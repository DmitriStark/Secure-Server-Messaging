const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const Message = require("../models/Message");
const User = require("../models/User");
const { authenticate } = require("../middleware/auth");
const logger = require("../utils/logger");
const os = require("os");

const connectedClients = new Map();

const messageQueue = [];
const MAX_QUEUE_SIZE = 5000;
const MAX_CLIENTS_PER_WORKER = Math.ceil(15000 / os.cpus().length);

const messageDeliveryTracker = new Map();

let messageBatch = [];
const BATCH_SIZE = 500;
const BATCH_INTERVAL = 1000;

let activeConnections = 0;

setInterval(async () => {
  if (messageBatch.length > 0) {
    const batch = [...messageBatch];
    messageBatch = [];

    try {
      if (batch.length > 0) {
        const bulkOps = batch.map((message) => ({
          insertOne: { document: message },
        }));

        const result = await Message.collection.bulkWrite(bulkOps, {
          ordered: false,
        });
        logger.info(
          `Batch processed: ${batch.length} messages saved to database`
        );
      }
    } catch (error) {
      logger.error("Error processing message batch:", error);
      if (batch.length <= 20) {
        messageBatch = [...messageBatch, ...batch];
      } else {
        logger.error(`Dropped ${batch.length} messages due to database error`);
      }
    }
  }
}, BATCH_INTERVAL);

setInterval(() => {
  const now = Date.now();
  let expiredCount = 0;

  for (const [clientId, data] of connectedClients.entries()) {
    if (now - data.timestamp > 10000) {
      connectedClients.delete(clientId);
      expiredCount++;
      activeConnections--;
    }
  }

  if (expiredCount > 0 && expiredCount % 100 === 0) {
    logger.info(
      `Cleaned up ${expiredCount} expired client connections. Active: ${connectedClients.size}`
    );
  }

  if (messageQueue.length > MAX_QUEUE_SIZE * 0.9) {
    const removed = messageQueue.length - Math.floor(MAX_QUEUE_SIZE * 0.7);
    messageQueue.splice(0, removed);
    logger.info(`Trimmed message queue by ${removed} messages`);
  }

  const tenMinutesAgo = now - 600000;
  let trackerCleanupCount = 0;

  for (const [messageId, data] of messageDeliveryTracker.entries()) {
    if (data.timestamp < tenMinutesAgo) {
      messageDeliveryTracker.delete(messageId);
      trackerCleanupCount++;
    }
  }

  if (trackerCleanupCount > 0) {
    logger.debug(
      `Cleaned up ${trackerCleanupCount} expired message delivery tracking entries`
    );
  }
}, 5000);

const broadcastMessage = (message) => {
  const start = Date.now();
  let deliveredCount = 0;
  const batchSize = 1000;
  const recipients = message.recipients || [];

  if (!recipients.length) {
    return 0;
  }

  const messageId = message._id.toString();
  if (!messageDeliveryTracker.has(messageId)) {
    messageDeliveryTracker.set(messageId, {
      deliveredTo: new Set(),
      timestamp: Date.now(),
    });
  }

  const processBatch = (clientEntries, batchIndex) => {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, clientEntries.length);

    if (batchStart >= clientEntries.length) {
      return;
    }

    for (let i = batchStart; i < batchEnd; i++) {
      const [clientId, client] = clientEntries[i];
      const username = client.username;

      if (!recipients.includes(username)) {
        continue;
      }

      const messageTracker = messageDeliveryTracker.get(messageId);
      if (messageTracker && messageTracker.deliveredTo.has(username)) {
        continue;
      }

      try {
        const clientMessage = { ...message };
        delete clientMessage._workerId;
        delete clientMessage._queued;

        client.res.json({
          type: "message",
          data: clientMessage,
        });

        if (messageTracker) {
          messageTracker.deliveredTo.add(username);
        }

        connectedClients.delete(clientId);
        activeConnections--;
        deliveredCount++;
      } catch (error) {
        connectedClients.delete(clientId);
        activeConnections--;
      }
    }

    if (batchEnd < clientEntries.length) {
      setImmediate(() => processBatch(clientEntries, batchIndex + 1));
    } else {
      if (deliveredCount > 0) {
        const duration = Date.now() - start;
        if (deliveredCount > 100) {
          logger.info(
            `Broadcast completed: ${deliveredCount} clients, ${Math.round(
              duration
            )}ms`
          );
        }
      }
    }
  };

  const clientEntries = [...connectedClients.entries()];
  processBatch(clientEntries, 0);

  if (!message._queued) {
    message._queued = true;
    messageQueue.push(message);
  }

  return deliveredCount;
};

router.get("/poll", authenticate, (req, res) => {
  const capacity = MAX_CLIENTS_PER_WORKER;
  const load = activeConnections / capacity;

  if (load >= 0.9) {
    const retryAfter = Math.min(Math.ceil(load * 5), 10);

    res.set("Retry-After", retryAfter.toString());
    return res.status(503).json({
      message: "Server at capacity, please retry shortly",
      retryAfter: retryAfter,
    });
  }

  const clientId = crypto.randomUUID();
  const username = req.user.username;

  req.setTimeout(7000);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache");

  for (let i = 0; i < Math.min(messageQueue.length, 1000); i++) {
    const message = messageQueue[i];
    if (!message || !message.recipients) continue;

    const messageId = message._id.toString();

    if (message.recipients.includes(username)) {
      const messageTracker = messageDeliveryTracker.get(messageId);
      if (!messageTracker || !messageTracker.deliveredTo.has(username)) {
        const clientMessage = { ...message };
        delete clientMessage._workerId;
        delete clientMessage._queued;

        if (!messageTracker) {
          messageDeliveryTracker.set(messageId, {
            deliveredTo: new Set([username]),
            timestamp: Date.now(),
          });
        } else {
          messageTracker.deliveredTo.add(username);
          messageTracker.timestamp = Date.now();
        }

        return res.json({
          type: "message",
          data: clientMessage,
        });
      }
    }
  }

  connectedClients.set(clientId, {
    res,
    username,
    timestamp: Date.now(),
  });

  activeConnections++;

  req.on("close", () => {
    if (connectedClients.has(clientId)) {
      connectedClients.delete(clientId);
      activeConnections--;
    }
  });

  setTimeout(() => {
    if (connectedClients.has(clientId)) {
      connectedClients.delete(clientId);
      activeConnections--;

      try {
        res.json({ type: "timeout" });
      } catch (err) {}
    }
  }, 5000);
});

router.post("/send", authenticate, async (req, res) => {
  try {
    const { encryptedContent, iv, recipientKeys } = req.body;

    if (!encryptedContent || !iv || !recipientKeys) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let recipients;

    try {
      const users = await User.find({}, "username").lean().exec();
      recipients = users.map((user) => user.username);
    } catch (error) {
      logger.error("Error getting recipients:", error);
      recipients = [req.user.username];
    }

    const mongoose = require("mongoose");
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
      isUnread: true,
    };

    messageBatch.push(newMessage);

    setImmediate(() => {
      try {
        broadcastMessage(newMessage);
      } catch (err) {
        logger.error("Broadcast error:", err);
      }
    });

    return res.status(201).json({
      message: "Message sent successfully",
      messageId: messageId,
    });
  } catch (error) {
    logger.error("Message sending error:", error);
    return res.status(500).json({ message: "Failed to send message" });
  }
});

router.get("/history", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const messages = await Message.find({
      recipients: req.user.username,
    })
      .select("_id sender encryptedContent iv recipientKeys timestamp isUnread")
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();

    const totalMessages = 1000;
    const totalPages = Math.ceil(totalMessages / limit);

    const result = {
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: true,
    };

    return res.status(200).json(result);
  } catch (error) {
    logger.error("Message history retrieval error:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve message history" });
  }
});

router.post("/:messageId/read", authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;

    Message.updateOne(
      {
        _id: messageId,
        recipients: req.user.username,
        "readBy.username": { $ne: req.user.username },
      },
      {
        $addToSet: {
          readBy: {
            username: req.user.username,
            readAt: new Date(),
          },
        },
        $set: { isUnread: false },
      }
    ).exec();

    return res.status(200).json({ message: "Message marked as read" });
  } catch (error) {
    logger.error("Message read status error:", error);
    return res.status(500).json({ message: "Failed to update read status" });
  }
});

router.get("/:messageId", authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await Message.findById(messageId)
      .select(
        "_id sender encryptedContent iv recipientKeys recipients timestamp isUnread"
      )
      .lean()
      .exec();

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    if (!message.recipients.includes(req.user.username)) {
      return res.status(403).json({ message: "Access denied" });
    }

    return res.status(200).json(message);
  } catch (error) {
    logger.error("Message retrieval error:", error);
    return res.status(500).json({ message: "Failed to retrieve message" });
  }
});

router.get("/status", authenticate, async (req, res) => {
  try {
    if (process.send) {
      process.send({ type: "connections", count: activeConnections });
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
        percent: Math.round((activeConnections / MAX_CLIENTS_PER_WORKER) * 100),
      },
      trackerSize: messageDeliveryTracker.size,
    };

    return res.status(200).json({
      status: "online",
      stats,
    });
  } catch (error) {
    logger.error("Status endpoint error:", error);
    return res.status(500).json({ message: "Error retrieving status" });
  }
});

module.exports = router;
