// Optimized server file for 10,000+ concurrent connections
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const path = require('path');
const cluster = require('cluster');
const os = require('os');
require('dotenv').config();

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const messageRoutes = require('./routes/messages');
const keyRoutes = require('./routes/keys');

// Import utilities
const { setupServerKeys } = require('./utils/cryptography');
const logger = require('./utils/logger');

// Number of CPU cores - use all available cores
const numCPUs = os.cpus().length;

// Constants
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/secure-chat';

// Increase Node.js heap memory if needed
if (cluster.isMaster) {
  // Check available memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  logger.info(`Total memory: ${Math.round(totalMem / 1024 / 1024)} MB`);
  logger.info(`Free memory: ${Math.round(freeMem / 1024 / 1024)} MB`);
  
  // Set system-wide limits if possible
  try {
    require('child_process').execSync('ulimit -n 65535');
    logger.info('Set file descriptor limit to 65535');
  } catch (err) {
    logger.warn('Unable to set file descriptor limit, may limit connection capacity');
  }
}

// Master process
if (cluster.isMaster) {
  logger.info(`Master ${process.pid} is running`);
  
  // Setup server keys once in the master process
  setupServerKeys();

  // Set Node.js process limits for high concurrency
  process.setMaxListeners(0);

  // Fork workers based on CPU cores
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  // Monitor worker health and restart if needed
  cluster.on('exit', (worker, code, signal) => {
    logger.warn(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    logger.info('Starting a new worker');
    cluster.fork();
  });

  // Centralized connection accounting
  let totalConnections = 0;
  const workerConnections = {};
  
  // Set up worker communication
  Object.keys(cluster.workers).forEach(id => {
    const worker = cluster.workers[id];
    
    worker.on('message', (msg) => {
      if (msg.type === 'connections' && typeof msg.count === 'number') {
        workerConnections[worker.id] = msg.count;
        
        // Recalculate total
        totalConnections = Object.values(workerConnections).reduce((a, b) => a + b, 0);
        
        if (totalConnections % 1000 === 0) {
          logger.info(`Total active connections: ${totalConnections}`);
        }
      }
    });
  });

  // Periodically request connection counts from workers
  setInterval(() => {
    Object.keys(cluster.workers).forEach(id => {
      cluster.workers[id].send({ type: 'connection-count-request' });
    });
  }, 5000);

} else {
  // Worker process - each handles a portion of the connections
  const app = express();
  
  // Enhanced HTTP server settings for high connection count
  const http = require('http');
  const server = http.createServer(app);
  
  // Track connections for this worker
  let activeConnections = 0;
  
  // Increase the maximum number of listeners
  server.setMaxListeners(0);
  process.setMaxListeners(0);
  
  // Optimize server for high concurrency
  server.maxConnections = Math.ceil(15000 / numCPUs); // Allow extra headroom
  
  // CRITICAL: Reduce HTTP timeouts for better connection handling
  server.timeout = 8000; // 8 seconds - even shorter timeouts for more efficient connection cycling
  server.keepAliveTimeout = 10000; // 10 seconds
  server.headersTimeout = 11000; // slightly higher than keepAliveTimeout
  
  // Process message from master
  process.on('message', (msg) => {
    if (msg.type === 'connection-count-request') {
      process.send({ type: 'connections', count: activeConnections });
    }
  });

  // Track connection count
  server.on('connection', (socket) => {
    activeConnections++;
    process.send({ type: 'connections', count: activeConnections });
    
    socket.setNoDelay(true); // Disable Nagle's algorithm for better responsiveness
    socket.setKeepAlive(true, 5000); // Enable TCP keepalive probes
    
    socket.on('close', () => {
      activeConnections--;
      process.send({ type: 'connections', count: activeConnections });
    });
  });
  
  // Setup security and middleware optimized for performance
  app.use(cors({
    maxAge: 600 // Cache preflight requests for 10 minutes
  }));
  
  // Streamlined Helmet configuration for performance
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for performance
    dnsPrefetchControl: false, // Allow DNS prefetching
    frameguard: true,
    hidePoweredBy: true,
    hsts: true,
    ieNoOpen: true,
    noSniff: true,
    xssFilter: true,
    referrerPolicy: { policy: 'same-origin' }
  }));
  
  // Increase JSON payload limit for large encrypted messages
  app.use(express.json({ 
    limit: '2mb',
    // More efficient JSON parsing options
    strict: true, // Faster JSON parsing by enforcing strict mode
    inflate: true // Use compression if available
  }));
  
  // Minimal logging for better performance
  app.use(morgan('tiny', {
    skip: (req, res) => res.statusCode < 400 // Only log errors
  }));

  // Share the activeConnections with routes
  app.use((req, res, next) => {
    req.activeConnections = activeConnections;
    next();
  });

  // Setup routes
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/messages', messageRoutes);
  app.use('/api/keys', keyRoutes);

  // Serve static files from the React build in production
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../client/build'), {
      maxAge: '1d' // Cache static files for 1 day
    }));
    
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
    });
  }

  // Streamlined error handling middleware
  app.use((err, req, res, next) => {
    logger.error(`${err.name}: ${err.message}`);
    res.status(500).json({ message: 'Server error' });
  });

  // Setup database connection with highly optimized settings
  mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    // Significantly increased connection pool
    maxPoolSize: Math.ceil(1000 / numCPUs), // Increased to 1000 from 100
    // Set minimum pool size to avoid cold start issues
    minPoolSize: Math.ceil(50 / numCPUs),
    // Keep connections alive
    keepAlive: true,
    keepAliveInitialDelay: 30000,
    // Short socket timeout (faster error detection)
    socketTimeoutMS: 30000,
    // Faster server selection timeout
    serverSelectionTimeoutMS: 5000,
    // Faster connection timeout
    connectTimeoutMS: 10000,
    // Optimized write concern for better performance
    w: 1, // Accept writes as soon as they're received by the primary
    wtimeoutMS: 2000
  })
  .then(() => {
    logger.info(`Worker ${process.pid} connected to MongoDB`);
    
    // Start the server
    server.listen(PORT, () => {
      logger.info(`Worker ${process.pid} listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    logger.error(`MongoDB connection error: ${error}`);
    process.exit(1);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info(`Worker ${process.pid} received SIGTERM`);
    server.close(() => {
      mongoose.connection.close(false, () => {
        logger.info('MongoDB connection closed');
        process.exit(0);
      });
    });
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack);
    // Don't exit, just log and continue
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection:', reason);
    // Don't exit, just log and continue
  });
}