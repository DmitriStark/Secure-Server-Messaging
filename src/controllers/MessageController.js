const crypto = require("crypto");
const logger = require("../utils/logger");
const messageRepository = require("../repositories/MessageRepository");
const messageService = require("../services/MessageService");

class MessageController {
  async pollMessages(req, res) {
    try {
      if (messageService.isAtCapacity()) {
        const load = messageService.getLoadFactor();
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

      const result = messageService.hasMessageForUser(username);
      if (result) {
        const { message, messageId } = result;

        const clientMessage = { ...message };
        delete clientMessage._workerId;
        delete clientMessage._queued;

        messageService.markMessageDelivered(messageId, username);

        return res.json({
          type: "message",
          data: clientMessage,
        });
      }

      messageService.addClient(clientId, res, username);

      req.on("close", () => {
        messageService.removeClient(clientId);
      });

      setTimeout(() => {
        if (messageService.removeClient(clientId)) {
          try {
            res.json({ type: "timeout" });
          } catch (err) {}
        }
      }, 5000);
    } catch (error) {
      logger.error("Poll message error:", error);
      return res.status(500).json({ message: "Error during message polling" });
    }
  }

  async sendMessage(req, res) {
    try {
      const { encryptedContent, iv, recipientKeys } = req.body;

      if (!encryptedContent || !iv || !recipientKeys) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      let recipients;

      try {
        const users = await messageRepository.getAllUsers();
        recipients = users.map((user) => user.username);
      } catch (error) {
        logger.error("Error getting recipients:", error);
        recipients = [req.user.username];
      }

      const messageId = await messageRepository.createMessageId();

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

      messageService.addToMessageBatch(newMessage);

      setImmediate(() => {
        try {
          messageService.broadcastMessage(newMessage);
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
  }

  async getMessageHistory(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;

      const result = await messageRepository.getMessageHistory(
        req.user.username,
        page,
        limit
      );

      return res.status(200).json(result);
    } catch (error) {
      logger.error("Message history retrieval error:", error);
      return res
        .status(500)
        .json({ message: "Failed to retrieve message history" });
    }
  }

  async markMessageAsRead(req, res) {
    try {
      const { messageId } = req.params;

      await messageRepository.markMessageAsRead(messageId, req.user.username);

      return res.status(200).json({ message: "Message marked as read" });
    } catch (error) {
      logger.error("Message read status error:", error);
      return res.status(500).json({ message: "Failed to update read status" });
    }
  }

  async getMessageById(req, res) {
    try {
      const { messageId } = req.params;

      const message = await messageRepository.getMessageById(messageId);

      if (!message) {
        return res.status(404).json({ message: "Message not found" });
      }

      return res.status(200).json(message);
    } catch (error) {
      logger.error("Message retrieval error:", error);
      return res.status(500).json({ message: "Failed to retrieve message" });
    }
  }

  async getSystemStatus(req, res) {
    try {
      if (process.send) {
        process.send({
          type: "connections",
          count: messageService.activeConnections,
        });
      }

      const stats = messageService.getSystemStatus();

      return res.status(200).json({
        status: "online",
        stats,
      });
    } catch (error) {
      logger.error("Status endpoint error:", error);
      return res.status(500).json({ message: "Error retrieving status" });
    }
  }

  async getAllMessages(req, res) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;

      const messages = await Message.find({})
        .select(
          "_id sender encryptedContent iv recipientKeys recipients timestamp isUnread"
        )
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec();

      const totalMessages = await Message.countDocuments();
      const totalPages = Math.ceil(totalMessages / limit);

      return res.status(200).json({
        messages,
        totalPages,
        currentPage: page,
        totalMessages,
        approximate: false,
      });
    } catch (error) {
      console.error("Error fetching all messages:", error);
      return res
        .status(500)
        .json({ message: "Failed to retrieve all messages" });
    }
  }
}

module.exports = new MessageController();
