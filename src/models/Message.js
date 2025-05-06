// Message model
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Add messageId field with MongoDB ObjectId as default value
  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    default: () => new mongoose.Types.ObjectId(),
    unique: true
  },
  sender: {
    type: String,
    required: true,
    ref: 'User'
  },
  encryptedContent: {
    type: String,
    required: true
  },
  iv: {
    type: String,
    required: true
  },
  recipients: [{
    type: String,
    ref: 'User'
  }],
  // Store encrypted symmetric keys for each recipient
  recipientKeys: {
    type: Map,
    of: String,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  // For audit purposes
  readBy: [{
    username: {
      type: String,
      ref: 'User'
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }]
});

// Add index on sender and timestamp for better query performance
messageSchema.index({ sender: 1, timestamp: -1 });
messageSchema.index({ recipients: 1, timestamp: -1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;