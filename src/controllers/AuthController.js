const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const userRepository = require("../repositories/UserRepository");
const logger = require("../utils/logger");
const { JWT_SECRET, JWT_EXPIRATION } = require('../config/auth.config');


class AuthController {
  async register(req, res) {
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

      // Simplified password validation
      if (password.length < 4) {
        return res.status(400).json({
          message: "Password must be at least 4 characters"
        });
      }

      if (
        !publicKey.includes("BEGIN PUBLIC KEY") ||
        !publicKey.includes("END PUBLIC KEY")
      ) {
        return res.status(400).json({ message: "Invalid public key format" });
      }

      const existingUser = await userRepository.findByUsername(username);

      if (existingUser) {
        return res.status(409).json({ message: "Username already exists" });
      }

      const hashedPassword = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 2 ** 16, // 64MiB
        timeCost: 3, // 3 iterations
        parallelism: 1, // 1 thread
      });

      const newUser = await userRepository.createUser(username, hashedPassword, publicKey);

      logger.info(`User registered: ${username}`);

      const token = jwt.sign({ username: newUser.username }, JWT_SECRET, {
        expiresIn: JWT_EXPIRATION,
      });

      return res.status(201).json({
        message: "User registered successfully",
        token,
        username: newUser.username,
      });
    } catch (error) {
      logger.error("Registration error:", error);
      return res.status(500).json({ message: "Registration failed" });
    }
  }

  async login(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ message: "Missing username or password" });
      }

      const user = await userRepository.findByUsername(username);
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

      await userRepository.updateLastLogin(user);

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
  }

  async getProfile(req, res) {
    try {
      const cachedProfile = await userRepository.getProfileFromCache(req.user.username);
      if (cachedProfile) {
        return res.status(200).json(cachedProfile);
      }

      const user = await userRepository.getUserProfile(req.user.username);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const profile = {
        username: user.username,
        publicKey: user.publicKey,
        lastLogin: user.lastLogin,
      };

      await userRepository.cacheProfile(req.user.username, profile);

      return res.status(200).json(profile);
    } catch (error) {
      logger.error("Profile retrieval error:", error);
      return res.status(500).json({ message: "Failed to retrieve profile" });
    }
  }

  async verifyToken(req, res) {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ message: "No token provided" });
      }

      const cachedResult = await userRepository.getTokenFromCache(token);
      if (cachedResult) {
        if (cachedResult.valid) {
          return res.status(200).json({ valid: true });
        }
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      if (!decoded || !decoded.username) {
        throw new Error("Invalid token");
      }

      const user = await userRepository.findByUsername(decoded.username);

      if (!user) {
        await userRepository.cacheToken(token, { valid: false }, 60);
        return res.status(401).json({ valid: false });
      }

      await userRepository.cacheToken(
        token, 
        {
          valid: true,
          username: decoded.username,
        }, 
        3600
      );

      return res.status(200).json({ valid: true });
    } catch (error) {
      logger.error("Token verification error:", error);
      return res.status(401).json({ valid: false });
    }
  }

  async logout(req, res) {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader && authHeader.split(" ")[1];

      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          const expiryTime = decoded.exp - Math.floor(Date.now() / 1000);

          if (expiryTime > 0) {
            await userRepository.blacklistToken(token, expiryTime);
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
  }
}

module.exports = new AuthController();