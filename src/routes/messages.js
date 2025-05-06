const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const messageController = require("../controllers/MessageController");

router.get("/poll", authenticate, (req, res) => 
  messageController.pollMessages(req, res));

router.post("/send", authenticate, (req, res) => 
  messageController.sendMessage(req, res));

router.get("/history", authenticate, (req, res) => 
  messageController.getMessageHistory(req, res));

router.post("/:messageId/read", authenticate, (req, res) => 
  messageController.markMessageAsRead(req, res));

router.get("/:messageId", authenticate, (req, res) => 
  messageController.getMessageById(req, res));

router.get("/status", authenticate, (req, res) => 
  messageController.getSystemStatus(req, res));

module.exports = router;