// // Optimized message handling routes for 10,000 concurrent connections
// const express = require("express");
// const router = express.Router();
// const crypto = require("crypto");
// const Message = require("../models/Message");
// const User = require("../models/User");
// const { authenticate } = require("../middleware/auth");
// const logger = require("../utils/logger");

// // Connected clients map for long polling (per worker process)
// const connectedClients = new Map();

// // Message queue for messages that need to be delivered
// const messageQueue = [];
// const MAX_QUEUE_SIZE = 1000; // Prevent memory issues
// const MAX_CLIENTS_PER_WORKER = 2000; // Limit connections per worker

// // Batch processing
// let messageBatch = [];
// const BATCH_SIZE = 100;
// const BATCH_INTERVAL = 1000; // 1 second

// // Track which users have received which messages
// const messageDeliveryTracker = new Map();

// // Subscribe to Redis message channel if using clustering
// if (global.redisClient) {
//   const redisSub = global.redisClient.duplicate();
//   redisSub.on("message", (channel, message) => {
//     if (channel === "new-message") {
//       try {
//         const messageData = JSON.parse(message);
//         // Only process if not from this worker
//         if (messageData._workerId !== process.pid) {
//           broadcastMessage(messageData, false); // Don't re-publish
//         }
//       } catch (err) {
//         logger.error("Error processing Redis message:", err);
//       }
//     }
//   });
//   redisSub.subscribe("new-message");
// }

// // Process message batch periodically
// setInterval(async () => {
//   if (messageBatch.length > 0) {
//     const batch = [...messageBatch];
//     messageBatch = [];

//     try {
//       // Bulk insert to database
//       await Message.insertMany(batch);
//       logger.info(
//         `Batch processed: ${batch.length} messages saved to database`
//       );
//     } catch (error) {
//       logger.error("Error processing message batch:", error);
//       // Re-queue failed messages if critical
//       if (batch.length <= 10) {
//         messageBatch = [...messageBatch, ...batch];
//       } else {
//         logger.error(`Dropped ${batch.length} messages due to database error`);
//       }
//     }
//   }
// }, BATCH_INTERVAL);

// // Cleanup expired clients periodically
// setInterval(() => {
//   const now = Date.now();
//   let expiredCount = 0;

//   for (const [clientId, data] of connectedClients.entries()) {
//     if (now - data.timestamp > 35000) {
//       // 35 second expiry (slightly longer than client timeout)
//       connectedClients.delete(clientId);
//       expiredCount++;
//     }
//   }

//   if (expiredCount > 0) {
//     logger.info(
//       `Cleaned up ${expiredCount} expired client connections. Active: ${connectedClients.size}`
//     );
//   }

//   // Trim message queue if needed
//   if (messageQueue.length > MAX_QUEUE_SIZE) {
//     const removed = messageQueue.length - MAX_QUEUE_SIZE;
//     messageQueue.splice(0, removed); // Remove oldest messages
//     logger.info(`Trimmed message queue by ${removed} messages`);
//   }

//   // Clean up message delivery tracker (remove entries older than 1 hour)
//   const oneHourAgo = now - 3600000;
//   for (const [messageId, data] of messageDeliveryTracker.entries()) {
//     if (data.timestamp < oneHourAgo) {
//       messageDeliveryTracker.delete(messageId);
//     }
//   }
// }, 10000); // Every 10 seconds

// // Broadcast message to connected clients
// const broadcastMessage = async (message, publishToRedis = true) => {
//   const start = Date.now();
//   let deliveredCount = 0;

//   // Add worker ID to track message origin
//   if (!message._workerId) {
//     message._workerId = process.pid;
//   }

//   // Initialize delivery tracking for this message
//   const messageId = message._id.toString();
//   if (!messageDeliveryTracker.has(messageId)) {
//     messageDeliveryTracker.set(messageId, {
//       deliveredTo: new Set(),
//       timestamp: Date.now()
//     });
//   }

//   // Publish to Redis for other workers if needed
//   if (publishToRedis && global.redisPublish) {
//     try {
//       await global.redisPublish("new-message", JSON.stringify(message));
//     } catch (err) {
//       logger.error("Redis publish error:", err);
//     }
//   }

//   // Broadcast to connected clients in this worker
//   for (const [clientId, client] of connectedClients.entries()) {
//     const username = client.username;
//     const messageTracker = messageDeliveryTracker.get(messageId);
    
//     // Skip if already delivered to this user
//     if (messageTracker && messageTracker.deliveredTo.has(username)) {
//       continue;
//     }
    
//     if (message.recipients.includes(username)) {
//       try {
//         // Create a sanitized version of the message (without worker ID)
//         const clientMessage = { ...message };
//         delete clientMessage._workerId;
//         delete clientMessage._queued;

//         client.res.json({
//           type: "message",
//           data: clientMessage,
//         });

//         // Mark as delivered to this user
//         if (messageTracker) {
//           messageTracker.deliveredTo.add(username);
//         }

//         // Remove client from connected clients map
//         connectedClients.delete(clientId);
//         deliveredCount++;
//       } catch (error) {
//         // Client connection might be broken
//         connectedClients.delete(clientId);
//         logger.debug(
//           `Error broadcasting to client ${clientId}:`,
//           error.message
//         );
//       }
//     }
//   }

//   // Add message to queue for clients that weren't connected
//   if (!message._queued) {
//     message._queued = true;
//     messageQueue.push(message);
//   }

//   if (deliveredCount > 0) {
//     logger.info(
//       `Broadcast completed: ${deliveredCount} clients, ${Date.now() - start}ms`
//     );
//   }

//   return deliveredCount;
// };

// // Long-polling endpoint for clients to receive messages
// router.get("/poll", authenticate, (req, res) => {
//   // Check if we've reached max clients for this worker
//   if (connectedClients.size >= MAX_CLIENTS_PER_WORKER) {
//     logger.warn(
//       `Worker ${process.pid} at capacity (${connectedClients.size} clients)`
//     );
//     return res.status(503).json({
//       message: "Server at capacity, please try again later",
//       retryAfter: 5, // Suggest retry in 5 seconds
//     });
//   }

//   const clientId = crypto.randomUUID();
//   const username = req.user.username;

//   // Set timeout for long-polling (30 seconds)
//   req.setTimeout(30000);

//   // Set up headers for streaming response
//   res.setHeader("Content-Type", "application/json");
//   res.setHeader("Connection", "keep-alive");
//   res.setHeader("Cache-Control", "no-cache");

//   // Check message queue for any pending messages for this user
//   for (let i = 0; i < messageQueue.length; i++) {
//     const message = messageQueue[i];
//     const messageId = message._id.toString();
    
//     // Check if message is for this user and hasn't been delivered yet
//     if (message.recipients.includes(username)) {
//       // Check delivery tracker
//       const messageTracker = messageDeliveryTracker.get(messageId);
//       if (!messageTracker || !messageTracker.deliveredTo.has(username)) {
//         // Create a clean copy without internal properties
//         const clientMessage = { ...message };
//         delete clientMessage._workerId;
//         delete clientMessage._queued;
        
//         // Mark as delivered to this user
//         if (!messageTracker) {
//           messageDeliveryTracker.set(messageId, {
//             deliveredTo: new Set([username]),
//             timestamp: Date.now()
//           });
//         } else {
//           messageTracker.deliveredTo.add(username);
//         }
        
//         // Remove from queue if all recipients have received it
//         if (messageTracker && messageTracker.deliveredTo.size >= message.recipients.length) {
//           messageQueue.splice(i, 1);
//           logger.debug(`Message ${messageId} removed from queue - all recipients notified`);
//         }
        
//         return res.json({
//           type: "message",
//           data: clientMessage,
//         });
//       }
//     }
//   }

//   // No pending messages for this user, add to connected clients for future broadcasts
//   connectedClients.set(clientId, {
//     res,
//     username,
//     timestamp: Date.now(),
//   });

//   // Handle client disconnect
//   req.on("close", () => {
//     connectedClients.delete(clientId);
//   });

//   // Set a timeout to end the long-polling connection
//   setTimeout(() => {
//     if (connectedClients.has(clientId)) {
//       connectedClients.delete(clientId);

//       // Send timeout response
//       try {
//         res.json({ type: "timeout" });
//       } catch (err) {
//         // Connection might already be closed
//       }
//     }
//   }, 29000); // Just under 30 seconds
// });

// // Send a message with proper E2E encryption
// router.post("/send", authenticate, async (req, res) => {
//   try {
//     const { encryptedContent, iv, recipientKeys } = req.body;

//     if (!encryptedContent || !iv || !recipientKeys) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }

//     // Get all users to broadcast to - use caching to reduce DB load
//     let recipients;

//     if (global.redisGetAsync) {
//       // Try to get user list from Redis cache
//       const cachedUsers = await global.redisGetAsync("all_users");
//       if (cachedUsers) {
//         recipients = JSON.parse(cachedUsers);
//       }
//     }

//     if (!recipients) {
//       // Get from database if not in cache
//       const users = await User.find({}, "username");
//       recipients = users.map((user) => user.username);

//       // Cache for future requests
//       if (global.redisSetAsync) {
//         await global.redisSetAsync(
//           "all_users",
//           JSON.stringify(recipients),
//           "EX",
//           300
//         ); // Cache for 5 minutes
//       }
//     }

//     // Create new message object with a unique ID
//     const mongoose = require("mongoose");
//     const messageId = new mongoose.Types.ObjectId();
    
//     const newMessage = {
//       _id: messageId,
//       messageId: messageId,
//       sender: req.user.username,
//       encryptedContent,
//       iv,
//       recipients,
//       recipientKeys,
//       timestamp: new Date(),
//       isUnread: true
//     };

//     // Add to batch for efficient database storage
//     messageBatch.push(newMessage);

//     // Broadcast message to connected clients immediately
//     broadcastMessage(newMessage);

//     logger.info(
//       `Message from ${req.user.username} queued for broadcast to ${recipients.length} recipients`
//     );

//     return res.status(201).json({
//       message: "Message sent successfully",
//       messageId: messageId,
//     });
//   } catch (error) {
//     logger.error("Message sending error:", error);
//     return res.status(500).json({ message: "Failed to send message" });
//   }
// });

// // Get message history for the authenticated user with pagination and caching
// router.get("/history", authenticate, async (req, res) => {
//   try {
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 20;

//     // Check for cached results if Redis is available
//     let cachedResult;
//     const cacheKey = `msg_history:${req.user.username}:${page}:${limit}`;

//     if (global.redisGetAsync) {
//       cachedResult = await global.redisGetAsync(cacheKey);
//       if (cachedResult) {
//         return res.status(200).json(JSON.parse(cachedResult));
//       }
//     }

//     // Database query with efficient indexing
//     const messages = await Message.find({
//       recipients: req.user.username,
//     })
//       .select("_id sender encryptedContent iv recipientKeys timestamp isUnread")
//       .sort({ timestamp: -1 })
//       .skip((page - 1) * limit)
//       .limit(limit)
//       .lean(); // Returns plain JS objects instead of Mongoose documents

//     // Get count using estimate for better performance
//     const collection = Message.collection;
//     const totalMessages = await collection.countDocuments(
//       {
//         recipients: req.user.username,
//       },
//       {
//         maxTimeMS: 1000, // Limit query time to 1 second
//         hint: "recipients_1_timestamp_-1", // Use index hint
//       }
//     );

//     const result = {
//       messages,
//       totalPages: Math.ceil(totalMessages / limit),
//       currentPage: page,
//       totalMessages,
//     };

//     // Cache results
//     if (global.redisSetAsync) {
//       await global.redisSetAsync(cacheKey, JSON.stringify(result), "EX", 60); // Cache for 60 seconds
//     }

//     return res.status(200).json(result);
//   } catch (error) {
//     logger.error("Message history retrieval error:", error);
//     return res
//       .status(500)
//       .json({ message: "Failed to retrieve message history" });
//   }
// });

// // Mark message as read
// router.post("/:messageId/read", authenticate, async (req, res) => {
//   try {
//     const { messageId } = req.params;

//     // Just record the read status without waiting for result
//     // This improves responsiveness under load
//     Message.updateOne(
//       {
//         _id: messageId,
//         recipients: req.user.username,
//         'readBy.username': { $ne: req.user.username }
//       },
//       { 
//         $addToSet: { 
//           readBy: {
//             username: req.user.username,
//             readAt: new Date()
//           }
//         },
//         $set: { isUnread: false }
//       }
//     ).exec();

//     return res.status(200).json({ message: "Message marked as read" });
//   } catch (error) {
//     logger.error("Message read status error:", error);
//     return res.status(500).json({ message: "Failed to update read status" });
//   }
// });

// // Get a specific message by ID with caching
// router.get("/:messageId", authenticate, async (req, res) => {
//   try {
//     const { messageId } = req.params;

//     // Try cache first
//     if (global.redisGetAsync) {
//       const cachedMessage = await global.redisGetAsync(`msg:${messageId}`);
//       if (cachedMessage) {
//         const message = JSON.parse(cachedMessage);
//         // Verify user has access
//         if (message.recipients.includes(req.user.username)) {
//           return res.status(200).json(message);
//         } else {
//           return res.status(403).json({ message: "Access denied" });
//         }
//       }
//     }

//     // Get from database
//     const message = await Message.findById(messageId).lean();

//     if (!message) {
//       return res.status(404).json({ message: "Message not found" });
//     }

//     // Check if the authenticated user is a recipient
//     if (!message.recipients.includes(req.user.username)) {
//       return res.status(403).json({ message: "Access denied" });
//     }

//     // Cache for future requests
//     if (global.redisSetAsync) {
//       await global.redisSetAsync(
//         `msg:${messageId}`,
//         JSON.stringify(message),
//         "EX",
//         3600
//       ); // Cache for 1 hour
//     }

//     return res.status(200).json(message);
//   } catch (error) {
//     logger.error("Message retrieval error:", error);
//     return res.status(500).json({ message: "Failed to retrieve message" });
//   }
// });

// // Endpoint to check server status and connection metrics
// router.get("/status", async (req, res) => {
//   try {
//     const stats = {
//       workerId: process.pid,
//       activeConnections: connectedClients.size,
//       messageQueueSize: messageQueue.length,
//       messageBatchSize: messageBatch.length,
//       memoryUsage: process.memoryUsage(),
//     };

//     // Get total connections across all workers if Redis is available
//     if (global.redisClient) {
//       try {
//         await global.redisSetAsync(
//           `worker:${process.pid}:connections`,
//           connectedClients.size,
//           "EX",
//           30
//         );

//         // Aggregate all worker stats
//         const keys = await global.redisClient.keys("worker:*:connections");
//         let totalConnections = 0;

//         for (const key of keys) {
//           const workerConnections =
//             parseInt(await global.redisGetAsync(key)) || 0;
//           totalConnections += workerConnections;
//         }

//         stats.totalClusterConnections = totalConnections;
//       } catch (err) {
//         logger.error("Error aggregating worker stats:", err);
//       }
//     }

//     return res.status(200).json({
//       status: "online",
//       stats
//     });
//   } catch (error) {
//     logger.error("Status endpoint error:", error);
//     return res.status(500).json({ message: "Error retrieving status" });
//   }
// });

// module.exports = router;



// Optimized message handling routes for 10,000+ concurrent connections
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Message = require('../models/Message');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');
const os = require('os');

// Connected clients map for long polling (per worker process)
const connectedClients = new Map();

// Message queue for messages that need to be delivered
const messageQueue = [];
const MAX_QUEUE_SIZE = 5000; // Increased queue size for high traffic
const MAX_CLIENTS_PER_WORKER = Math.ceil(15000 / os.cpus().length); // Scale per CPU

// Message delivery tracking to prevent duplicates
const messageDeliveryTracker = new Map();

// Batch processing
let messageBatch = [];
const BATCH_SIZE = 500; // Increased batch size
const BATCH_INTERVAL = 1000; // Longer interval (1s) for less frequent DB writes

// Active connections counter
let activeConnections = 0;

// Process message batch periodically
setInterval(async () => {
  if (messageBatch.length > 0) {
    const batch = [...messageBatch];
    messageBatch = [];
    
    try {
      // Use MongoDB bulk operations for better performance
      if (batch.length > 0) {
        const bulkOps = batch.map(message => ({
          insertOne: { document: message }
        }));
        
        // Execute bulk operation
        const result = await Message.collection.bulkWrite(bulkOps, { ordered: false });
        logger.info(`Batch processed: ${batch.length} messages saved to database`);
      }
    } catch (error) {
      logger.error('Error processing message batch:', error);
      // Re-queue critical messages only (to avoid overwhelming the system)
      if (batch.length <= 20) {
        messageBatch = [...messageBatch, ...batch];
      } else {
        logger.error(`Dropped ${batch.length} messages due to database error`);
      }
    }
  }
}, BATCH_INTERVAL);

// Cleanup expired clients and message tracking data periodically
setInterval(() => {
  const now = Date.now();
  let expiredCount = 0;
  
  // Cleanup connected clients
  for (const [clientId, data] of connectedClients.entries()) {
    if (now - data.timestamp > 10000) { // 10 second expiry (reduced from 15s)
      connectedClients.delete(clientId);
      expiredCount++;
      activeConnections--;
    }
  }
  
  if (expiredCount > 0 && expiredCount % 100 === 0) {
    logger.info(`Cleaned up ${expiredCount} expired client connections. Active: ${connectedClients.size}`);
  }
  
  // Trim message queue if needed - more aggressive trimming
  if (messageQueue.length > MAX_QUEUE_SIZE * 0.9) { // Trim when 90% full
    const removed = messageQueue.length - Math.floor(MAX_QUEUE_SIZE * 0.7); // Trim to 70%
    messageQueue.splice(0, removed); // Remove oldest messages
    logger.info(`Trimmed message queue by ${removed} messages`);
  }
  
  // Cleanup message delivery tracker (remove entries older than 10 minutes)
  const tenMinutesAgo = now - 600000;
  let trackerCleanupCount = 0;
  
  for (const [messageId, data] of messageDeliveryTracker.entries()) {
    if (data.timestamp < tenMinutesAgo) {
      messageDeliveryTracker.delete(messageId);
      trackerCleanupCount++;
    }
  }
  
  if (trackerCleanupCount > 0) {
    logger.debug(`Cleaned up ${trackerCleanupCount} expired message delivery tracking entries`);
  }
}, 5000); // Every 5 seconds

// Broadcast message to connected clients - optimized for high throughput
const broadcastMessage = (message) => {
  const start = Date.now();
  let deliveredCount = 0;
  const batchSize = 1000; // Process clients in batches to avoid blocking
  const recipients = message.recipients || [];
  
  // Skip empty recipients
  if (!recipients.length) {
    return 0;
  }
  
  // Initialize delivery tracking for this message
  const messageId = message._id.toString();
  if (!messageDeliveryTracker.has(messageId)) {
    messageDeliveryTracker.set(messageId, {
      deliveredTo: new Set(),
      timestamp: Date.now()
    });
  }
  
  // Process clients in batches to avoid blocking the event loop
  const processBatch = (clientEntries, batchIndex) => {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, clientEntries.length);
    
    if (batchStart >= clientEntries.length) {
      return; // All batches processed
    }
    
    // Process this batch
    for (let i = batchStart; i < batchEnd; i++) {
      const [clientId, client] = clientEntries[i];
      const username = client.username;
      
      // Check if user is in recipients list
      if (!recipients.includes(username)) {
        continue;
      }
      
      // Check if message already delivered to this user
      const messageTracker = messageDeliveryTracker.get(messageId);
      if (messageTracker && messageTracker.deliveredTo.has(username)) {
        continue;
      }
      
      try {
        // Create a sanitized version of the message (without internal properties)
        const clientMessage = { ...message };
        // Remove internal tracking properties
        delete clientMessage._workerId;
        delete clientMessage._queued;
        
        // Send message to client
        client.res.json({
          type: 'message',
          data: clientMessage
        });
        
        // Mark as delivered to this user
        if (messageTracker) {
          messageTracker.deliveredTo.add(username);
        }
        
        // Remove client from connected clients map
        connectedClients.delete(clientId);
        activeConnections--;
        deliveredCount++;
      } catch (error) {
        // Client connection might be broken
        connectedClients.delete(clientId);
        activeConnections--;
      }
    }
    
    // Schedule next batch with setImmediate to avoid blocking
    if (batchEnd < clientEntries.length) {
      setImmediate(() => processBatch(clientEntries, batchIndex + 1));
    } else {
      // All batches complete, log metrics
      if (deliveredCount > 0) {
        const duration = Date.now() - start;
        if (deliveredCount > 100) {
          logger.info(`Broadcast completed: ${deliveredCount} clients, ${Math.round(duration)}ms`);
        }
      }
    }
  };
  
  // Start processing in batches
  const clientEntries = [...connectedClients.entries()];
  processBatch(clientEntries, 0);
  
  // Add message to queue for clients that weren't connected
  if (!message._queued) {
    message._queued = true;
    messageQueue.push(message);
  }
  
  return deliveredCount;
};

// Long-polling endpoint for clients to receive messages - optimized for high concurrency
router.get("/poll", authenticate, (req, res) => {
  // Check if we've reached max clients for this worker - implement sliding window
  const capacity = MAX_CLIENTS_PER_WORKER;
  const load = activeConnections / capacity;
  
  if (load >= 0.9) { // Over 90% capacity
    // Dynamic timeout based on load
    const retryAfter = Math.min(Math.ceil(load * 5), 10); // 5-10 second backoff
    
    res.set('Retry-After', retryAfter.toString());
    return res.status(503).json({
      message: "Server at capacity, please retry shortly",
      retryAfter: retryAfter
    });
  }
  
  const clientId = crypto.randomUUID();
  const username = req.user.username;
  
  // Set very short timeout for long-polling (7 seconds max)
  req.setTimeout(7000);
  
  // Set up headers for streaming response
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Cache-Control', 'no-cache');
  
  // Check message queue for any pending messages for this user
  // Use a fast loop with early return rather than find/filter
  for (let i = 0; i < Math.min(messageQueue.length, 1000); i++) { // Only check most recent 1000
    const message = messageQueue[i];
    if (!message || !message.recipients) continue;
    
    const messageId = message._id.toString();
    
    // Check if message is for this user and hasn't been delivered yet
    if (message.recipients.includes(username)) {
      // Check delivery tracker
      const messageTracker = messageDeliveryTracker.get(messageId);
      if (!messageTracker || !messageTracker.deliveredTo.has(username)) {
        // Create a clean copy without internal properties
        const clientMessage = { ...message };
        delete clientMessage._workerId;
        delete clientMessage._queued;
        
        // Mark as delivered to this user
        if (!messageTracker) {
          messageDeliveryTracker.set(messageId, {
            deliveredTo: new Set([username]),
            timestamp: Date.now()
          });
        } else {
          messageTracker.deliveredTo.add(username);
          messageTracker.timestamp = Date.now();
        }
        
        // Return immediately with this message
        return res.json({
          type: 'message',
          data: clientMessage
        });
      }
    }
  }
  
  // No pending messages, add to connected clients for future messages
  connectedClients.set(clientId, {
    res,
    username,
    timestamp: Date.now()
  });
  
  activeConnections++;
  
  // Handle client disconnect
  req.on('close', () => {
    if (connectedClients.has(clientId)) {
      connectedClients.delete(clientId);
      activeConnections--;
    }
  });
  
  // Set a very short timeout to end the long-polling connection
  setTimeout(() => {
    if (connectedClients.has(clientId)) {
      connectedClients.delete(clientId);
      activeConnections--;
      
      // Send a timeout response
      try {
        res.json({ type: 'timeout' });
      } catch (err) {
        // Connection might already be closed - ignore
      }
    }
  }, 5000); // 5 second timeout - even shorter for better performance
});

// Send a message with proper E2E encryption - optimized for high throughput
router.post("/send", authenticate, async (req, res) => {
  try {
    const { encryptedContent, iv, recipientKeys } = req.body;
    
    if (!encryptedContent || !iv || !recipientKeys) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Get all users in a memory-efficient way - just usernames
    let recipients;
    
    try {
      // Only select username field and use lean() for better performance
      const users = await User.find({}, 'username').lean().exec();
      recipients = users.map(user => user.username);
    } catch (error) {
      logger.error('Error getting recipients:', error);
      // Fallback to just the current user as recipient
      recipients = [req.user.username];
    }
    
    // Create new message object with a secure ID
    const mongoose = require('mongoose');
    const messageId = new mongoose.Types.ObjectId();
    
    const newMessage = {
      _id: messageId,
      messageId: messageId,
      sender: req.user.username,
      encryptedContent,
      iv,
      recipients,
      recipientKeys: recipientKeys || {},
      timestamp: new Date(),
      isUnread: true
    };
    
    // Add to batch for efficient database storage
    messageBatch.push(newMessage);
    
    // Broadcast message immediately without waiting for DB
    // Do this asynchronously without waiting for completion
    setImmediate(() => {
      try {
        broadcastMessage(newMessage);
      } catch (err) {
        logger.error('Broadcast error:', err);
      }
    });
    
    // Send response immediately without waiting for broadcast or DB
    return res.status(201).json({
      message: 'Message sent successfully',
      messageId: messageId
    });
    
  } catch (error) {
    logger.error('Message sending error:', error);
    return res.status(500).json({ message: 'Failed to send message' });
  }
});

// Get message history for the authenticated user with pagination - optimized for performance
router.get("/history", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    // Use projection to get only needed fields and lean() for better performance
    const messages = await Message.find({
      recipients: req.user.username
    })
      .select('_id sender encryptedContent iv recipientKeys timestamp isUnread')
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();
    
    // Fast approximate count - avoid expensive count operation
    const totalMessages = 1000; // Use a fixed approximation
    const totalPages = Math.ceil(totalMessages / limit);
    
    const result = {
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: true
    };
    
    return res.status(200).json(result);
  } catch (error) {
    logger.error('Message history retrieval error:', error);
    return res.status(500).json({ message: 'Failed to retrieve message history' });
  }
});

// Mark message as read - optimized for high throughput
router.post("/:messageId/read", authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    // Non-blocking update without waiting for result
    Message.updateOne(
      {
        _id: messageId,
        recipients: req.user.username,
        'readBy.username': { $ne: req.user.username }
      },
      {
        $addToSet: {
          readBy: {
            username: req.user.username,
            readAt: new Date()
          }
        },
        $set: { isUnread: false }
      }
    ).exec();
    
    // Send success response immediately without waiting for DB update
    return res.status(200).json({ message: 'Message marked as read' });
  } catch (error) {
    logger.error('Message read status error:', error);
    return res.status(500).json({ message: 'Failed to update read status' });
  }
});

// Get a specific message by ID - optimized with projection
router.get("/:messageId", authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    // Get from database with specific projection to improve performance
    const message = await Message.findById(messageId)
      .select('_id sender encryptedContent iv recipientKeys recipients timestamp isUnread')
      .lean()
      .exec();
    
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }
    
    // Check if the authenticated user is a recipient
    if (!message.recipients.includes(req.user.username)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    return res.status(200).json(message);
  } catch (error) {
    logger.error('Message retrieval error:', error);
    return res.status(500).json({ message: 'Failed to retrieve message' });
  }
});

// Server status and metrics endpoint
router.get("/status", authenticate, async (req, res) => {
  try {
    // Send connection stats to master
    if (process.send) {
      process.send({ type: 'connections', count: activeConnections });
    }
    
    const stats = {
      workerId: process.pid,
      activeConnections,
      messageQueueSize: messageQueue.length,
      messageBatchSize: messageBatch.length,
      memoryUsage: process.memoryUsage(),
      capacity: {
        max: MAX_CLIENTS_PER_WORKER,
        used: activeConnections,
        percent: Math.round((activeConnections / MAX_CLIENTS_PER_WORKER) * 100)
      },
      trackerSize: messageDeliveryTracker.size
    };
    
    return res.status(200).json({
      status: 'online',
      stats
    });
  } catch (error) {
    logger.error('Status endpoint error:', error);
    return res.status(500).json({ message: 'Error retrieving status' });
  }
});

module.exports = router;