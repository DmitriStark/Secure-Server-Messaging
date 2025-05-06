// services/MessageService.js
const os = require("os");
const logger = require("../utils/logger");
const messageRepository = require("../repositories/MessageRepository");

class MessageService {
  constructor() {
    // Constants
    this.MAX_QUEUE_SIZE = 5000;
    this.MAX_CLIENTS_PER_WORKER = Math.ceil(15000 / os.cpus().length);
    this.BATCH_SIZE = 500;
    this.BATCH_INTERVAL = 1000;
    
    // State management
    this.connectedClients = new Map();
    this.messageQueue = [];
    this.messageDeliveryTracker = new Map();
    this.messageBatch = [];
    this.activeConnections = 0;
    
    // Initialize batch processing and cleanup intervals
    this.initBatchProcessing();
    this.initCleanupInterval();
  }
  
  initBatchProcessing() {
    setInterval(async () => {
      if (this.messageBatch.length > 0) {
        const batch = [...this.messageBatch];
        this.messageBatch = [];
  
        try {
          if (batch.length > 0) {
            const result = await messageRepository.saveBulkMessages(batch);
            logger.info(
              `Batch processed: ${batch.length} messages saved to database`
            );
          }
        } catch (error) {
          logger.error("Error processing message batch:", error);
          if (batch.length <= 20) {
            this.messageBatch = [...this.messageBatch, ...batch];
          } else {
            logger.error(`Dropped ${batch.length} messages due to database error`);
          }
        }
      }
    }, this.BATCH_INTERVAL);
  }
  
  initCleanupInterval() {
    setInterval(() => {
      const now = Date.now();
      let expiredCount = 0;
  
      // Clean up expired client connections
      for (const [clientId, data] of this.connectedClients.entries()) {
        if (now - data.timestamp > 10000) {
          this.connectedClients.delete(clientId);
          expiredCount++;
          this.activeConnections--;
        }
      }
  
      if (expiredCount > 0 && expiredCount % 100 === 0) {
        logger.info(
          `Cleaned up ${expiredCount} expired client connections. Active: ${this.connectedClients.size}`
        );
      }
  
      // Trim message queue if needed
      if (this.messageQueue.length > this.MAX_QUEUE_SIZE * 0.9) {
        const removed = this.messageQueue.length - Math.floor(this.MAX_QUEUE_SIZE * 0.7);
        this.messageQueue.splice(0, removed);
        logger.info(`Trimmed message queue by ${removed} messages`);
      }
  
      // Clean up old message delivery tracking data
      const tenMinutesAgo = now - 600000;
      let trackerCleanupCount = 0;
  
      for (const [messageId, data] of this.messageDeliveryTracker.entries()) {
        if (data.timestamp < tenMinutesAgo) {
          this.messageDeliveryTracker.delete(messageId);
          trackerCleanupCount++;
        }
      }
  
      if (trackerCleanupCount > 0) {
        logger.debug(
          `Cleaned up ${trackerCleanupCount} expired message delivery tracking entries`
        );
      }
    }, 5000);
  }
  
  broadcastMessage(message) {
    const start = Date.now();
    let deliveredCount = 0;
    const batchSize = 1000;
    const recipients = message.recipients || [];
  
    if (!recipients.length) {
      return 0;
    }
  
    const messageId = message._id.toString();
    if (!this.messageDeliveryTracker.has(messageId)) {
      this.messageDeliveryTracker.set(messageId, {
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
  
        const messageTracker = this.messageDeliveryTracker.get(messageId);
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
  
          this.connectedClients.delete(clientId);
          this.activeConnections--;
          deliveredCount++;
        } catch (error) {
          this.connectedClients.delete(clientId);
          this.activeConnections--;
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
  
    const clientEntries = [...this.connectedClients.entries()];
    processBatch(clientEntries, 0);
  
    if (!message._queued) {
      message._queued = true;
      this.messageQueue.push(message);
    }
  
    return deliveredCount;
  }
  
  addToMessageBatch(message) {
    this.messageBatch.push(message);
  }
  
  isAtCapacity() {
    const capacity = this.MAX_CLIENTS_PER_WORKER;
    const load = this.activeConnections / capacity;
    return load >= 0.9;
  }
  
  getLoadFactor() {
    const capacity = this.MAX_CLIENTS_PER_WORKER;
    const load = this.activeConnections / capacity;
    return load;
  }
  
  addClient(clientId, res, username) {
    this.connectedClients.set(clientId, {
      res,
      username,
      timestamp: Date.now(),
    });
    
    this.activeConnections++;
  }
  
  removeClient(clientId) {
    if (this.connectedClients.has(clientId)) {
      this.connectedClients.delete(clientId);
      this.activeConnections--;
      return true;
    }
    return false;
  }
  
  hasMessageForUser(username) {
    for (let i = 0; i < Math.min(this.messageQueue.length, 1000); i++) {
      const message = this.messageQueue[i];
      if (!message || !message.recipients) continue;
  
      const messageId = message._id.toString();
  
      if (message.recipients.includes(username)) {
        const messageTracker = this.messageDeliveryTracker.get(messageId);
        if (!messageTracker || !messageTracker.deliveredTo.has(username)) {
          return { message, messageId };
        }
      }
    }
    
    return null;
  }
  
  markMessageDelivered(messageId, username) {
    if (!this.messageDeliveryTracker.has(messageId)) {
      this.messageDeliveryTracker.set(messageId, {
        deliveredTo: new Set([username]),
        timestamp: Date.now(),
      });
    } else {
      const tracker = this.messageDeliveryTracker.get(messageId);
      tracker.deliveredTo.add(username);
      tracker.timestamp = Date.now();
    }
  }
  
  getSystemStatus() {
    return {
      workerId: process.pid,
      activeConnections: this.activeConnections,
      messageQueueSize: this.messageQueue.length,
      messageBatchSize: this.messageBatch.length,
      memoryUsage: process.memoryUsage(),
      capacity: {
        max: this.MAX_CLIENTS_PER_WORKER,
        used: this.activeConnections,
        percent: Math.round((this.activeConnections / this.MAX_CLIENTS_PER_WORKER) * 100),
      },
      trackerSize: this.messageDeliveryTracker.size,
    };
  }
}

module.exports = new MessageService();