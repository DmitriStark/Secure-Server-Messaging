const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const helmet = require("helmet");
const path = require("path");
const cluster = require("cluster");
const os = require("os");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const messageRoutes = require("./routes/messages");
const keyRoutes = require("./routes/keys");

const { setupServerKeys } = require("./utils/cryptography");
const logger = require("./utils/logger");

const numCPUs = os.cpus().length;

const PORT = process.env.PORT || 3001;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/secure-chat";

if (cluster.isMaster) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  logger.info(`Total memory: ${Math.round(totalMem / 1024 / 1024)} MB`);
  logger.info(`Free memory: ${Math.round(freeMem / 1024 / 1024)} MB`);

  const isWindows = process.platform === "win32";

  if (!isWindows) {
    try {
      require("child_process").execSync("ulimit -n 100000");
      logger.info("Set file descriptor limit to 100000");

      try {
        require("child_process").execSync("sysctl -w net.core.somaxconn=65535");
        require("child_process").execSync(
          "sysctl -w net.ipv4.tcp_max_syn_backlog=40000"
        );
        require("child_process").execSync(
          "sysctl -w net.ipv4.tcp_fin_timeout=15"
        );
        logger.info("Configured kernel parameters for high concurrency");
      } catch (err) {
        logger.warn("Unable to set kernel parameters, continuing anyway");
      }
    } catch (err) {
      logger.warn(
        "Unable to set file descriptor limit, may limit connection capacity"
      );
    }
  } else {
    try {
      process._setMaxListeners(0);
      require("events").EventEmitter.defaultMaxListeners = 0;
      logger.info(
        "Configured Windows networking parameters for high concurrency"
      );
    } catch (err) {
      logger.warn("Unable to set Windows networking parameters");
    }
  }

  if (freeMem > 8 * 1024 * 1024 * 1024) {
    // More than 8GB free
    try {
      // Only works if --max-old-space-size not already set
      process.env.NODE_OPTIONS = "--max-old-space-size=8192";
      logger.info("Increased Node.js memory limit to 8GB");
    } catch (err) {
      logger.warn("Unable to increase Node.js memory limit");
    }
  }
}

if (cluster.isMaster) {
  logger.info(`Master ${process.pid} is running`);

  setupServerKeys();

  process.setMaxListeners(0);

  cluster.schedulingPolicy = cluster.SCHED_RR;

  const workerCount = numCPUs > 1 ? numCPUs - 1 : 1;
  logger.info(`Starting ${workerCount} workers`);

  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    logger.warn(
      `Worker ${worker.process.pid} died with code ${code} and signal ${signal}`
    );
    logger.info("Starting a new worker");
    cluster.fork();
  });

  let totalConnections = 0;
  const workerConnections = {};

  Object.keys(cluster.workers).forEach((id) => {
    const worker = cluster.workers[id];

    worker.on("message", (msg) => {
      if (msg.type === "connections" && typeof msg.count === "number") {
        workerConnections[worker.id] = msg.count;

        totalConnections = Object.values(workerConnections).reduce(
          (a, b) => a + b,
          0
        );
      }
    });
  });

  setInterval(() => {
    Object.keys(cluster.workers).forEach((id) => {
      cluster.workers[id].send({ type: "connection-count-request" });
    });
  }, 5000);

  process.on("SIGTERM", () => {
    logger.info(
      `Master ${process.pid} received SIGTERM, initiating graceful shutdown`
    );

    Object.keys(cluster.workers).forEach((id) => {
      cluster.workers[id].send({ type: "shutdown" });
    });

    setTimeout(() => {
      logger.warn("Some workers did not exit gracefully, forcing shutdown");
      process.exit(0);
    }, 30000);
  });
} else {
  const app = express();

  const http = require("http");
  const server = http.createServer(app);

  let activeConnections = 0;
  let isShuttingDown = false;

  server.setMaxListeners(0);
  process.setMaxListeners(0);

  server.maxConnections = Math.ceil(20000 / (numCPUs > 1 ? numCPUs - 1 : 1));

  server.timeout = 30000;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  process.on("message", (msg) => {
    if (msg.type === "connection-count-request") {
      process.send({ type: "connections", count: activeConnections });
    }

    if (msg.type === "shutdown") {
      logger.info(`Worker ${process.pid} received shutdown signal`);
      isShuttingDown = true;

      server.close(() => {
        logger.info(`Worker ${process.pid} closed server`);

        mongoose.connection.close(false, () => {
          logger.info(`Worker ${process.pid} closed MongoDB connection`);
          process.exit(0);
        });
      });

      setTimeout(() => {
        logger.warn(`Worker ${process.pid} forcing exit`);
        process.exit(1);
      }, 10000);
    }
  });

  server.on("connection", (socket) => {
    if (isShuttingDown) {
      socket.end();
      return;
    }

    activeConnections++;
    process.send({ type: "connections", count: activeConnections });

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    if (
      typeof socket.setRecvBufferSize === "function" &&
      typeof socket.setSendBufferSize === "function"
    ) {
      try {
        socket.setRecvBufferSize(256 * 1024); // 256KB
        socket.setSendBufferSize(256 * 1024); // 256KB
      } catch (err) {
        // Not all platforms support this
      }
    }

    socket.on("close", () => {
      activeConnections--;
      process.send({ type: "connections", count: activeConnections });
    });
  });

  app.use(
    cors({
      maxAge: 600,
    })
  );

  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable CSP for performance
      dnsPrefetchControl: false, // Allow DNS prefetching
      frameguard: true,
      hidePoweredBy: true,
      hsts: true,
      ieNoOpen: true,
      noSniff: true,
      xssFilter: true,
      referrerPolicy: { policy: "same-origin" },
    })
  );

  // Increase JSON payload limit for large encrypted messages
  app.use(
    express.json({
      limit: "5mb", // Increased from 2mb for larger batch operations
      // More efficient JSON parsing options
      strict: true, // Faster JSON parsing by enforcing strict mode
      inflate: true, // Use compression if available
    })
  );

  // Minimal logging for better performance
  app.use(
    morgan("tiny", {
      skip: (req, res) => {
        // In high load scenarios, only log a small percentage of requests
        if (activeConnections > 5000) {
          // Log only 1% of requests when under high load
          return res.statusCode < 400 || Math.random() > 0.01;
        }
        // Otherwise only skip successful requests
        return res.statusCode < 400;
      },
    })
  );

  // Share the activeConnections with routes
  app.use((req, res, next) => {
    req.activeConnections = activeConnections;
    req.isShuttingDown = isShuttingDown;

    // Add connection limiting middleware
    if (isShuttingDown) {
      return res.status(503).json({ message: "Server is shutting down" });
    }

    // Return 503 Service Unavailable if at connection limit
    if (activeConnections >= server.maxConnections) {
      return res.status(503).json({ message: "Server at connection limit" });
    }

    next();
  });

  // Add health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({
      status: "healthy",
      connections: activeConnections,
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
      uptime: Math.round(process.uptime()),
    });
  });

  // Setup routes
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/keys", keyRoutes);

  // Serve static files from the React build in production
  if (process.env.NODE_ENV === "production") {
    app.use(
      express.static(path.join(__dirname, "../client/build"), {
        maxAge: "1d", // Cache static files for 1 day
      })
    );

    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "../client/build", "index.html"));
    });
  }

  // Enhanced error handling middleware
  app.use((err, req, res, next) => {
    // Only log full error details in development
    if (process.env.NODE_ENV !== "production") {
      logger.error(`${err.name}: ${err.message}`);
      logger.error(err.stack);
    } else {
      // In production, log minimal information
      logger.error(`${err.name}: ${err.message} (${req.method} ${req.path})`);
    }

    // Don't send internal error details to client in production
    res.status(500).json({
      message:
        process.env.NODE_ENV === "production" ? "Server error" : err.message,
    });
  });

  mongoose
    .connect(MONGODB_URI, {
      maxPoolSize: Math.ceil(2000 / (numCPUs > 1 ? numCPUs - 1 : 1)),
      minPoolSize: Math.ceil(100 / (numCPUs > 1 ? numCPUs - 1 : 1)),
      keepAlive: true,
      keepAliveInitialDelay: 30000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 15000,
      w: 1,
      wtimeoutMS: 5000,
      bufferCommands: true,
    })
    .then(() => {
      logger.info(`Worker ${process.pid} connected to MongoDB`);

      server.listen(PORT, () => {
        logger.info(`Worker ${process.pid} listening on port ${PORT}`);
      });
    })
    .catch((error) => {
      logger.error(`MongoDB connection error: ${error}`);
      process.exit(1);
    });

  const memoryMonitor = setInterval(() => {
    const memUsage = process.memoryUsage();

    if (Math.random() < 0.1) {
      logger.info(
        `Memory usage - RSS: ${Math.round(
          memUsage.rss / 1024 / 1024
        )}MB, Heap: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
      );
    }

    // Check for high memory usage
    if (memUsage.heapUsed > 1.5 * 1024 * 1024 * 1024) {
      // 1.5GB
      logger.warn(
        `High memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`
      );

      // Force garbage collection if --expose-gc flag was used
      if (global.gc) {
        global.gc();
        logger.info("Forced garbage collection");
      }
    }
  }, 30000);

  process.on("SIGTERM", () => {
    logger.info(`Worker ${process.pid} received SIGTERM`);
    isShuttingDown = true;

    clearInterval(memoryMonitor);

    server.close(() => {
      logger.info(`Server closed for worker ${process.pid}`);

      mongoose.connection.close(false, () => {
        logger.info("MongoDB connection closed");
        process.exit(0);
      });
    });

    setTimeout(() => {
      logger.warn(`Worker ${process.pid} forcing exit after timeout`);
      process.exit(1);
    }, 10000);
  });

  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
    logger.error(err.stack);

    if (err.code === "ERR_HTTP_HEADERS_SENT" || err.code === "EADDRINUSE") {
      logger.error("Critical error, worker will exit");
      process.exit(1);
    } else if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED") {
      logger.warn("Connection error, continuing execution");
    }
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled promise rejection:", reason);
  });
}
