const express = require("express");
const router = express.Router();
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { authenticate } = require("../middleware/auth");
const logger = require("../utils/logger");

const JWT_SECRET = process.env.JWT_SECRET ;
const JWT_EXPIRATION = "24h";

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

router.post("/register", authLimiter, async (req, res) => {
  try {
    const { username, password, publicKey } = req.body;

    if (!username || !password || !publicKey) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!username.match(/^[a-zA-Z0-9_]{3,30}$/)) {
      return res.status(400).json({
        message:
          "Username must be 3-30 characters and contain only letters, numbers, and underscores",
      });
    }

    if (
      password.length < 8 ||
      !password.match(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/
      )
    ) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and include uppercase, lowercase, number and special character",
      });
    }

    if (
      !publicKey.includes("BEGIN PUBLIC KEY") ||
      !publicKey.includes("END PUBLIC KEY")
    ) {
      return res.status(400).json({ message: "Invalid public key format" });
    }

    let existingUser;

    if (global.redisGetAsync) {
      const cachedUser = await global.redisGetAsync(`user:${username}`);
      if (cachedUser) {
        existingUser = JSON.parse(cachedUser);
      }
    }

    if (!existingUser) {
      existingUser = await User.findOne({ username });

      if (existingUser && global.redisSetAsync) {
        await global.redisSetAsync(
          `user:${username}`,
          JSON.stringify({
            username: existingUser.username,
            _id: existingUser._id,
          }),
          "EX",
          300
        );
      }
    }

    if (existingUser) {
      return res.status(409).json({ message: "Username already exists" });
    }

    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16, // 64MiB
      timeCost: 3, // 3 iterations
      parallelism: 1, // 1 thread
    });

    const newUser = new User({
      username,
      password: hashedPassword,
      publicKey,
      createdAt: new Date(),
      lastLogin: null,
    });

    await newUser.save();

    logger.info(`User registered: ${username}`);

    const token = jwt.sign({ username: newUser.username }, JWT_SECRET, {
      expiresIn: JWT_EXPIRATION,
    });

    if (global.redisClient) {
      await global.redisClient.del(`user:${username}`);

      await global.redisClient.del("all_users");
    }

    return res.status(201).json({
      message: "User registered successfully",
      token,
      username: newUser.username,
    });
  } catch (error) {
    logger.error("Registration error:", error);
    return res.status(500).json({ message: "Registration failed" });
  }
});

router.post("/login", authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Missing username or password" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      await argon2.verify(
        "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$hash",
        password
      );
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      logger.warn(`Failed login attempt for user: ${username}`);
      return res.status(401).json({ message: "Invalid username or password" });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign({ username: user.username }, JWT_SECRET, {
      expiresIn: JWT_EXPIRATION,
    });

    logger.info(`User logged in: ${username}`);

    return res.status(200).json({
      message: "Login successful",
      token,
      username: user.username,
    });
  } catch (error) {
    logger.error("Login error:", error);
    return res.status(500).json({ message: "Login failed" });
  }
});

router.get("/profile", authenticate, async (req, res) => {
  try {
    if (global.redisGetAsync) {
      const cachedProfile = await global.redisGetAsync(
        `profile:${req.user.username}`
      );
      if (cachedProfile) {
        return res.status(200).json(JSON.parse(cachedProfile));
      }
    }

    const user = await User.findOne(
      { username: req.user.username },
      "username publicKey lastLogin"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const profile = {
      username: user.username,
      publicKey: user.publicKey,
      lastLogin: user.lastLogin,
    };

    if (global.redisSetAsync) {
      await global.redisSetAsync(
        `profile:${req.user.username}`,
        JSON.stringify(profile),
        "EX",
        300
      ); // Cache for 5 minutes
    }

    return res.status(200).json(profile);
  } catch (error) {
    logger.error("Profile retrieval error:", error);
    return res.status(500).json({ message: "Failed to retrieve profile" });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ message: "No token provided" });
    }

    if (global.redisGetAsync) {
      try {
        const cachedResult = await global.redisGetAsync(
          `token:${token.substring(0, 10)}`
        );
        if (cachedResult) {
          const result = JSON.parse(cachedResult);
          if (result.valid) {
            return res.status(200).json({ valid: true });
          }
        }
      } catch (err) {
        logger.error("Token cache error:", err);
      }
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.username) {
      throw new Error("Invalid token");
    }

    const user = await User.findOne({ username: decoded.username });

    if (!user) {
      if (global.redisSetAsync) {
        await global.redisSetAsync(
          `token:${token.substring(0, 10)}`,
          JSON.stringify({ valid: false }),
          "EX",
          60
        );
      }
      return res.status(401).json({ valid: false });
    }

    if (global.redisSetAsync) {
      await global.redisSetAsync(
        `token:${token.substring(0, 10)}`,
        JSON.stringify({
          valid: true,
          username: decoded.username,
        }),
        "EX",
        3600
      );
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    logger.error("Token verification error:", error);
    return res.status(401).json({ valid: false });
  }
});

router.post("/logout", authenticate, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (token && global.redisSetAsync) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const expiryTime = decoded.exp - Math.floor(Date.now() / 1000);

        if (expiryTime > 0) {
          await global.redisSetAsync(
            `token:blacklist:${token.substring(0, 10)}`,
            "1",
            "EX",
            expiryTime
          );
        }
      } catch (err) {
        logger.debug("Token invalidation error:", err);
      }
    }

    logger.info(`User logged out: ${req.user.username}`);

    return res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    logger.error("Logout error:", error);
    return res.status(500).json({ message: "Logout failed" });
  }
});

module.exports = router;
