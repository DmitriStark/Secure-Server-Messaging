// repositories/MessageRepository.js
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
    const messages = await Message.find({
      recipients: username,
    })
      .select("_id sender encryptedContent iv recipientKeys timestamp isUnread")
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();

    // Note: In the original implementation, this was hardcoded to 1000
    // In a real implementation, you would count the actual number of messages
    const totalMessages = 1000;
    const totalPages = Math.ceil(totalMessages / limit);

    return {
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: true,
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