// routes/messageRoutes.js
const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const messageController = require("../controllers/MessageController");

// Message polling endpoint
router.get("/poll", authenticate, (req, res) => 
  messageController.pollMessages(req, res));

// Send message endpoint
router.post("/send", authenticate, (req, res) => 
  messageController.sendMessage(req, res));

// Message history endpoint
router.get("/history", authenticate, (req, res) => 
  messageController.getMessageHistory(req, res));

// Mark message as read endpoint
router.post("/:messageId/read", authenticate, (req, res) => 
  messageController.markMessageAsRead(req, res));

// Get specific message endpoint
router.get("/:messageId", authenticate, (req, res) => 
  messageController.getMessageById(req, res));

// System status endpoint
router.get("/status", authenticate, (req, res) => 
  messageController.getSystemStatus(req, res));

module.exports = router;