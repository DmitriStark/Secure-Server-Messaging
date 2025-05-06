// Optimized Message model with fixed index for high-volume messaging
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  // Using messageId with MongoDB ObjectId
  messageId: {
    type: mongoose.Schema.Types.ObjectId,
    default: () => new mongoose.Types.ObjectId(),
    unique: true
  },
  // Sender username
  sender: {
    type: String,
    required: true,
    index: true
  },
  // Encrypted message content
  encryptedContent: {
    type: String,
    required: true
  },
  // Initialization vector for encryption
  iv: {
    type: String,
    required: true
  },
  // Recipients list (usernames)
  recipients: [{
    type: String,
    index: true
  }],
  // Store encrypted symmetric keys for each recipient
  recipientKeys: {
    type: Map,
    of: String,
    default: {}
  },
  // Message timestamp
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  // For audit purposes - who has read the message
  readBy: [{
    username: {
      type: String
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Add a boolean flag for unread status - easier to query
  isUnread: {
    type: Boolean,
    default: true,
    index: true
  },
  // TTL for message expiry (optional)
  expiresAt: {
    type: Date,
    expires: 0, // Use with TTL index
    default: function() {
      // Default message retention of 90 days
      const date = new Date();
      date.setDate(date.getDate() + 90);
      return date;
    }
  }
}, {
  // Use optimized settings for high volume collections
  timestamps: false, // Manage our own timestamps
  versionKey: false, // Don't track versions to reduce document size
  // Only include specified fields when converting to JSON
  toJSON: {
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Create compound indexes for common queries
// These are critical for performance with 10,000+ concurrent users
messageSchema.index({ recipients: 1, timestamp: -1 });
messageSchema.index({ sender: 1, timestamp: -1 });
messageSchema.index({ 'readBy.username': 1, timestamp: -1 });

// Add TTL index for message expiration
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Create index for unread messages - simpler than partial index
messageSchema.index({ isUnread: 1, timestamp: -1 });

// Static method to efficiently fetch messages for a user
messageSchema.statics.getMessagesForUser = async function(username, page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  
  // Use lean query for better performance
  return this.find({ recipients: username })
    .select('_id sender encryptedContent iv recipientKeys timestamp isUnread')
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

// Static method to mark a message as read efficiently
messageSchema.statics.markAsRead = async function(messageId, username) {
  return this.updateOne(
    { 
      _id: messageId,
      recipients: username,
      'readBy.username': { $ne: username }
    },
    { 
      $addToSet: { 
        readBy: {
          username,
          readAt: new Date()
        }
      },
      $set: { isUnread: false }
    }
  );
};

// Pre-save hook to validate message size
messageSchema.pre('save', function(next) {
  // Check message size to prevent oversized documents
  // MongoDB has a 16MB document size limit
  const approximateSize = 
    (this.encryptedContent ? this.encryptedContent.length : 0) +
    (this.iv ? this.iv.length : 0) +
    JSON.stringify(this.recipientKeys).length +
    JSON.stringify(this.recipients).length;
  
  if (approximateSize > 15 * 1024 * 1024) { // 15MB safety limit
    return next(new Error('Message size exceeds maximum allowed size'));
  }
  
  next();
});

// Create the model
const Message = mongoose.model('Message', messageSchema);

// Create indexes without using background option (which is deprecated)
Message.createIndexes().catch(err => {
  console.error('Error creating message indexes:', err);
});

module.exports = Message;