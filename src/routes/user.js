// User management routes
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { authenticate } = require("../middleware/auth");
const logger = require("../utils/logger");

// Get public keys for all users
router.get("/public-keys", authenticate, async (req, res) => {
  try {
    const users = await User.find({}, "username publicKey");

    return res.status(200).json({
      users,
    });
  } catch (error) {
    logger.error("Error fetching public keys:", error);
    return res.status(500).json({ message: "Failed to fetch public keys" });
  }
});

// Update user's public key
router.post("/update-key", authenticate, async (req, res) => {
  try {
    const { publicKey } = req.body;

    if (!publicKey) {
      return res.status(400).json({ message: "Public key is required" });
    }

    // Update user's public key
    await User.findOneAndUpdate({ username: req.user.username }, { publicKey });

    logger.info(`Public key updated for user: ${req.user.username}`);

    return res.status(200).json({
      message: "Public key updated successfully",
    });
  } catch (error) {
    logger.error("Error updating public key:", error);
    return res.status(500).json({ message: "Failed to update public key" });
  }
});

module.exports = router;
