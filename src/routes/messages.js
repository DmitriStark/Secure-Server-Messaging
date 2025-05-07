const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const messageController = require("../controllers/MessageController");
const Message = require("../models/Message"); 

router.get("/all-messages", authenticate, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    
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
    
    return res.status(200).json({
      messages,
      totalPages,
      currentPage: page,
      totalMessages,
      approximate: false
    });
  } catch (error) {
    console.error("Error fetching all messages:", error);
    return res.status(500).json({ message: "Failed to retrieve all messages" });
  }
});

// Original routes
router.get("/poll", authenticate, (req, res) => 
  messageController.pollMessages(req, res));

router.post("/send", authenticate, (req, res) => 
  messageController.sendMessage(req, res));

router.get("/history", authenticate, (req, res) => 
  messageController.getMessageHistory(req, res));

router.post("/:messageId/read", authenticate, (req, res) => 
  messageController.markMessageAsRead(req, res));
  
router.get("/status", authenticate, (req, res) => 
  messageController.getSystemStatus(req, res));

router.get("/:messageId", authenticate, (req, res) => 
  messageController.getMessageById(req, res));

module.exports = router;