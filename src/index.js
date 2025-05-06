// Main server entry point
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const keyRoutes = require('./routes/keys');

// Import utilities
const { setupServerKeys } = require('./utils/cryptography');
const logger = require('./utils/logger');

// Constants
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/secure-messaging';

// Setup server keys
setupServerKeys();

// Setup MongoDB connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  logger.info('Connected to MongoDB');
}).catch(err => {
  logger.error('MongoDB connection error:', err);
  process.exit(1);
});

// Initialize Express app
const app = express();

// Trust first proxy for rate limiting to work correctly with X-Forwarded-For headers
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', apiLimiter);

// Routes
app.get('/', (req, res) => {
  res.send('Secure Messaging Server');
});

app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/keys', keyRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).send('Something broke!');
});

// Create HTTP server
const server = http.createServer(app);

// Start server
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
  });
});

module.exports = { app, server };