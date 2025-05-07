const Message = require("../models/Message");
const User = require("../models/User");
const mongoose = require("mongoose");

class MessageRepository {
  async createMessageId() {
    return new mongoose.Types.ObjectId();
  }

  async getAllUsers() {
    return User.find({}, "username").lean().exec();
  }

  async saveBulkMessages(batch) {
    if (batch.length === 0) return { success: true };

    const bulkOps = batch.map((message) => ({
      insertOne: { document: message },
    }));

    return Message.collection.bulkWrite(bulkOps, {
      ordered: false,
    });
  }

  async getMessageHistory(username, page, limit) {
    const messages = await Message.find({})
      .select("_id sender encryptedContent iv recipientKeys timestamp isUnread recipients")
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();

    // Get total message count from the database
    const totalMessages = await Message.countDocuments();
    const totalPages = Math.ceil(totalMessages / limit);

    return {
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: false,
    };
  }

  async getAllMessages(page, limit) {
    // Get all messages without filtering by recipient
    const messages = await Message.find({})
      .select("_id sender encryptedContent iv recipientKeys recipients timestamp isUnread")
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();
    
    // Get total message count
    const totalMessages = await Message.countDocuments();
    const totalPages = Math.ceil(totalMessages / limit);
    
    return {
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: false
    };
  }

  async markMessageAsRead(messageId, username) {
    return Message.updateOne(
      {
        _id: messageId,
        recipients: username,
        "readBy.username": { $ne: username },
      },
      {
        $addToSet: {
          readBy: {
            username: username,
            readAt: new Date(),
          },
        },
        $set: { isUnread: false },
      }
    ).exec();
  }

  async getMessageById(messageId) {
    return Message.findById(messageId)
      .select(
        "_id sender encryptedContent iv recipientKeys recipients timestamp isUnread"
      )
      .lean()
      .exec();
  }
}

module.exports = new MessageRepository();