// Message handling routes
const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { decryptWithPrivateKey } = require('../utils/cryptography');
const logger = require('../utils/logger');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Connected clients map for long polling
const connectedClients = new Map();

// Server private key for decryption
let SERVER_PRIVATE_KEY;

// Load the server's keys
const getServerPrivateKey = () => {
  if (!SERVER_PRIVATE_KEY) {
    try {
      SERVER_PRIVATE_KEY = fs.readFileSync(
        path.join(__dirname, '../../keys/server-private.pem'),
        'utf8'
      );
    } catch (error) {
      logger.error('Error reading server private key:', error);
      throw new Error('Server private key not available');
    }
  }
  return SERVER_PRIVATE_KEY;
};

// Send a message with proper E2E encryption
router.post('/send', authenticate, async (req, res) => {
  try {
    const { encryptedContent, iv, recipientKeys } = req.body;
    
    if (!encryptedContent || !iv || !recipientKeys) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Get all users to broadcast to
    const users = await User.find({}, 'username');
    
    // Create new message with recipients' encrypted keys
    const newMessage = new Message({
      sender: req.user.username,
      encryptedContent,
      iv,
      recipients: users.map(user => user.username),
      recipientKeys
    });
    
    await newMessage.save();
    
    logger.info(`Message sent by ${req.user.username}`);
    
    // Broadcast message to all connected clients
    const messageToSend = {
      _id: newMessage._id,
      sender: req.user.username,
      encryptedContent,
      iv,
      recipientKeys,
      timestamp: newMessage.timestamp
    };
    
    // Notify all connected clients
    for (const [clientId, response] of connectedClients.entries()) {
      response.json({
        type: 'message',
        data: messageToSend
      });
      
      // Remove client from connected clients map
      connectedClients.delete(clientId);
    }
    
    return res.status(201).json({
      message: 'Message sent successfully',
      messageId: newMessage._id
    });
  } catch (error) {
    logger.error('Message sending error:', error);
    return res.status(500).json({ message: 'Failed to send message' });
  }
});

// Long-polling endpoint for clients to receive messages
router.get('/poll', authenticate, (req, res) => {
  const clientId = crypto.randomUUID();
  
  // Set timeout for long-polling (30 seconds)
  req.setTimeout(30000);
  
  // Set up headers for streaming response
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Cache-Control', 'no-cache');
  
  // Add response to connected clients
  connectedClients.set(clientId, res);
  
  // Handle client disconnect
  req.on('close', () => {
    connectedClients.delete(clientId);
  });
  
  // Set a timeout to end the long-polling connection
  setTimeout(() => {
    if (connectedClients.has(clientId)) {
      connectedClients.delete(clientId);
      res.json({ type: 'timeout' });
    }
  }, 29000); // Just under 30 seconds
});

// Get message history for the authenticated user
router.get('/history', authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    const messages = await Message.find({
      recipients: req.user.username
    })
    .sort({ timestamp: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
    
    const totalMessages = await Message.countDocuments({
      recipients: req.user.username
    });
    
    return res.status(200).json({
      messages,
      totalPages: Math.ceil(totalMessages / limit),
      currentPage: page,
      totalMessages
    });
  } catch (error) {
    logger.error('Message history retrieval error:', error);
    return res.status(500).json({ message: 'Failed to retrieve message history' });
  }
});

// Mark message as read
router.post('/:messageId/read', authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ message: 'Message not found' });
    }
    
    // Check if the authenticated user is a recipient
    if (!message.recipients.includes(req.user.username)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Check if user has already read the message
    const alreadyRead = message.readBy.some(read => read.username === req.user.username);
    
    if (!alreadyRead) {
      // Add user to readBy array
      message.readBy.push({
        username: req.user.username,
        readAt: new Date()
      });
      
      await message.save();
    }
    
    return res.status(200).json({ message: 'Message marked as read' });
  } catch (error) {
    logger.error('Message read status error:', error);
    return res.status(500).json({ message: 'Failed to update read status' });
  }
});

// Get a specific message by ID
router.get('/:messageId', authenticate, async (req, res) => {
  try {
    const { messageId } = req.params;
    
    const message = await Message.findById(messageId);
    
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

module.exports = router;