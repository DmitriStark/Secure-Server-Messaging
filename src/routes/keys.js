const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const User = require("../models/User");
const { authenticate } = require("../middleware/auth");
const logger = require("../utils/logger");

router.get("/server-public", async (req, res) => {
  try {
    const serverPublicKey = fs.readFileSync(
      path.join(__dirname, "../../keys/server-public.pem"),
      "utf8"
    );

    return res.status(200).json({
      publicKey: serverPublicKey,
    });
  } catch (error) {
    logger.error("Server public key retrieval error:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve server public key" });
  }
});

router.get("/user/:username", async (req, res) => {
  try {
    const { username } = req.params;

    const user = await User.findOne({ username }, "username publicKey");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      username: user.username,
      publicKey: user.publicKey,
    });
  } catch (error) {
    logger.error("User public key retrieval error:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve user public key" });
  }
});

router.get("/users", authenticate, async (req, res) => {
  try {
    const users = await User.find({}, "username publicKey");

    return res.status(200).json({
      users: users.map((user) => ({
        username: user.username,
        publicKey: user.publicKey,
      })),
    });
  } catch (error) {
    logger.error("Users public keys retrieval error:", error);
    return res
      .status(500)
      .json({ message: "Failed to retrieve users public keys" });
  }
});

module.exports = router;
