// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../middleware/auth");
const authController = require("../controllers/AuthController");

// Rate limiting configuration
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later",
  },
  keyGenerator: (req) => {
    return `${req.body.username || "anonymous"}-${req.ip}`;
  },
  skip: (req, res) => {
    return process.env.NODE_ENV === "development";
  },
});

// Routes
router.post("/register", authLimiter, (req, res) => authController.register(req, res));
router.post("/login", authLimiter, (req, res) => authController.login(req, res));
router.get("/profile", authenticate, (req, res) => authController.getProfile(req, res));
router.post("/verify", (req, res) => authController.verifyToken(req, res));
router.post("/logout", authenticate, (req, res) => authController.logout(req, res));

module.exports = router;