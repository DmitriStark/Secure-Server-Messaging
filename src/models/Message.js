// Message model
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
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

const Message = mongoose.model('Message', messageSchema);

module.exports = Message;