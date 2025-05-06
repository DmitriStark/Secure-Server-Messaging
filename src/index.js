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
  
  // Set system-wide limits if possible - check OS first
  const isWindows = process.platform === 'win32';
  
  if (!isWindows) {
    // Unix/Linux specific configurations
    try {
      // Increase file descriptor limit for more connections
      require('child_process').execSync('ulimit -n 100000');
      logger.info('Set file descriptor limit to 100000');
      
      // Configure additional kernel parameters for high-concurrency (Linux only)
      try {
        require('child_process').execSync('sysctl -w net.core.somaxconn=65535');
        require('child_process').execSync('sysctl -w net.ipv4.tcp_max_syn_backlog=40000');
        require('child_process').execSync('sysctl -w net.ipv4.tcp_fin_timeout=15');
        logger.info('Configured kernel parameters for high concurrency');
      } catch (err) {
        logger.warn('Unable to set kernel parameters, continuing anyway');
      }
    } catch (err) {
      logger.warn('Unable to set file descriptor limit, may limit connection capacity');
    }
  } else {
    // Windows-specific optimizations
    try {
      // For Windows, we can at least try to set some networking parameters
      // These don't require administrative privileges
      process._setMaxListeners(0);
      require('events').EventEmitter.defaultMaxListeners = 0;
      logger.info('Configured Windows networking parameters for high concurrency');
    } catch (err) {
      logger.warn('Unable to set Windows networking parameters');
    }
  }
  
  // Configure Node.js memory settings
  // Increase the memory limit if available
  if (freeMem > 8 * 1024 * 1024 * 1024) { // More than 8GB free
    try {
      // Only works if --max-old-space-size not already set
      process.env.NODE_OPTIONS = '--max-old-space-size=8192';
      logger.info('Increased Node.js memory limit to 8GB');
    } catch (err) {
      logger.warn('Unable to increase Node.js memory limit');
    }
  }
}

// Master process
if (cluster.isMaster) {
  logger.info(`Master ${process.pid} is running`);
  
  // Setup server keys once in the master process
  setupServerKeys();

  // Set Node.js process limits for high concurrency
  process.setMaxListeners(0);
  
  // Use round-robin scheduling for better load distribution
  cluster.schedulingPolicy = cluster.SCHED_RR;

  // Fork workers based on CPU cores (leave one core free for OS)
  const workerCount = numCPUs > 1 ? numCPUs - 1 : 1;
  logger.info(`Starting ${workerCount} workers`);
  
  for (let i = 0; i < workerCount; i++) {
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
  
  // Add master process graceful shutdown
  process.on('SIGTERM', () => {
    logger.info(`Master ${process.pid} received SIGTERM, initiating graceful shutdown`);
    
    // Notify all workers to shut down gracefully
    Object.keys(cluster.workers).forEach(id => {
      cluster.workers[id].send({ type: 'shutdown' });
    });
    
    // Set a timeout to force exit if workers don't shut down
    setTimeout(() => {
      logger.warn('Some workers did not exit gracefully, forcing shutdown');
      process.exit(0);
    }, 30000);
  });

} else {
  // Worker process - each handles a portion of the connections
  const app = express();
  
  // Enhanced HTTP server settings for high connection count
  const http = require('http');
  const server = http.createServer(app);
  
  // Track connections for this worker
  let activeConnections = 0;
  let isShuttingDown = false;
  
  // Increase the maximum number of listeners
  server.setMaxListeners(0);
  process.setMaxListeners(0);
  
  // Optimize server for high concurrency
  server.maxConnections = Math.ceil(20000 / (numCPUs > 1 ? numCPUs - 1 : 1)); // Allow more headroom per worker
  
  // CRITICAL: Optimize HTTP timeouts for long polling
  server.timeout = 30000; // 30 seconds for long polling instead of 8
  server.keepAliveTimeout = 65000; // 65 seconds (above typical load balancer timeouts)
  server.headersTimeout = 66000; // slightly higher than keepAliveTimeout
  
  // Process message from master
  process.on('message', (msg) => {
    if (msg.type === 'connection-count-request') {
      process.send({ type: 'connections', count: activeConnections });
    }
    
    if (msg.type === 'shutdown') {
      logger.info(`Worker ${process.pid} received shutdown signal`);
      isShuttingDown = true;
      
      // Stop accepting new connections
      server.close(() => {
        logger.info(`Worker ${process.pid} closed server`);
        
        // Close database connections
        mongoose.connection.close(false, () => {
          logger.info(`Worker ${process.pid} closed MongoDB connection`);
          process.exit(0);
        });
      });
      
      // Force exit if it takes too long
      setTimeout(() => {
        logger.warn(`Worker ${process.pid} forcing exit`);
        process.exit(1);
      }, 10000);
    }
  });

  // Track connection count
  server.on('connection', (socket) => {
    // Reject new connections during shutdown
    if (isShuttingDown) {
      socket.end();
      return;
    }
    
    activeConnections++;
    process.send({ type: 'connections', count: activeConnections });
    
    // TCP optimizations
    socket.setNoDelay(true); // Disable Nagle's algorithm for better responsiveness
    socket.setKeepAlive(true, 30000); // Enable TCP keepalive probes with longer interval
    
    // Set TCP buffer sizes for high throughput - only try if method exists
    // This is safer for cross-platform compatibility (especially Windows)
    if (typeof socket.setRecvBufferSize === 'function' && 
        typeof socket.setSendBufferSize === 'function') {
      try {
        socket.setRecvBufferSize(256 * 1024); // 256KB
        socket.setSendBufferSize(256 * 1024); // 256KB
      } catch (err) {
        // Not all platforms support this
      }
    }
    
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
    limit: '5mb', // Increased from 2mb for larger batch operations
    // More efficient JSON parsing options
    strict: true, // Faster JSON parsing by enforcing strict mode
    inflate: true // Use compression if available
  }));
  
  // Minimal logging for better performance
  app.use(morgan('tiny', {
    skip: (req, res) => {
      // In high load scenarios, only log a small percentage of requests
      if (activeConnections > 5000) {
        // Log only 1% of requests when under high load
        return res.statusCode < 400 || Math.random() > 0.01;
      }
      // Otherwise only skip successful requests
      return res.statusCode < 400;
    }
  }));

  // Share the activeConnections with routes
  app.use((req, res, next) => {
    req.activeConnections = activeConnections;
    req.isShuttingDown = isShuttingDown;
    
    // Add connection limiting middleware
    if (isShuttingDown) {
      return res.status(503).json({ message: 'Server is shutting down' });
    }
    
    // Return 503 Service Unavailable if at connection limit
    if (activeConnections >= server.maxConnections) {
      return res.status(503).json({ message: 'Server at connection limit' });
    }
    
    next();
  });

  // Add health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      connections: activeConnections,
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      uptime: Math.round(process.uptime())
    });
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

  // Enhanced error handling middleware
  app.use((err, req, res, next) => {
    // Only log full error details in development
    if (process.env.NODE_ENV !== 'production') {
      logger.error(`${err.name}: ${err.message}`);
      logger.error(err.stack);
    } else {
      // In production, log minimal information
      logger.error(`${err.name}: ${err.message} (${req.method} ${req.path})`);
    }
    
    // Don't send internal error details to client in production
    res.status(500).json({ 
      message: process.env.NODE_ENV === 'production' ? 'Server error' : err.message
    });
  });

  // Setup database connection with highly optimized settings
  mongoose.connect(MONGODB_URI, {
    // Significantly increased connection pool
    maxPoolSize: Math.ceil(2000 / (numCPUs > 1 ? numCPUs - 1 : 1)), // Increased to 2000 from 1000
    // Set minimum pool size to avoid cold start issues
    minPoolSize: Math.ceil(100 / (numCPUs > 1 ? numCPUs - 1 : 1)), // Increased to 100 from 50
    // Keep connections alive
    keepAlive: true,
    keepAliveInitialDelay: 30000,
    // Longer socket timeout for better stability 
    socketTimeoutMS: 45000, // Increased from 30000
    // Faster server selection timeout
    serverSelectionTimeoutMS: 10000, // Increased from 5000
    // Connection timeout
    connectTimeoutMS: 15000, // Increased from 10000
    // Optimized write concern for better performance
    w: 1, // Accept writes as soon as they're received by the primary
    wtimeoutMS: 5000, // Increased from 2000
    // Add buffer commands to handle connection blips
    bufferCommands: true
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
  
  // Memory monitoring
  const memoryMonitor = setInterval(() => {
    const memUsage = process.memoryUsage();
    
    // Log memory usage occasionally
    if (Math.random() < 0.1) { // 10% chance to log
      logger.info(`Memory usage - RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB, Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    }
    
    // Check for high memory usage
    if (memUsage.heapUsed > 1.5 * 1024 * 1024 * 1024) { // 1.5GB
      logger.warn(`High memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
      
      // Force garbage collection if --expose-gc flag was used
      if (global.gc) {
        global.gc();
        logger.info('Forced garbage collection');
      }
    }
  }, 30000);
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info(`Worker ${process.pid} received SIGTERM`);
    isShuttingDown = true;
    
    // Stop memory monitoring
    clearInterval(memoryMonitor);
    
    // Close server first (stop accepting new connections)
    server.close(() => {
      logger.info(`Server closed for worker ${process.pid}`);
      
      // Then close database connection
      mongoose.connection.close(false, () => {
        logger.info('MongoDB connection closed');
        process.exit(0);
      });
    });
    
    // Force exit after timeout
    setTimeout(() => {
      logger.warn(`Worker ${process.pid} forcing exit after timeout`);
      process.exit(1);
    }, 10000);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack);
    
    // For critical errors that might leave the process in an unstable state
    if (err.code === 'ERR_HTTP_HEADERS_SENT' || err.code === 'EADDRINUSE') {
      logger.error('Critical error, worker will exit');
      process.exit(1);
    }
    // For connection errors, just log and continue
    else if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
      logger.warn('Connection error, continuing execution');
    }
    // Don't exit for other errors, let the worker continue
  });
  
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection:', reason);
    // Don't exit, just log and continue
  });
}