// Optimized authentication routes for high-volume traffic
const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRATION = '24h';

// Rate limiting for authentication routes to prevent brute force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: 'Too many requests, please try again later'
  },
  keyGenerator: (req) => {
    // Use username + IP as the key to prevent username enumeration
    return `${req.body.username || 'anonymous'}-${req.ip}`;
  },
  skip: (req, res) => {
    // Skip rate limiting in development
    return process.env.NODE_ENV === 'development';
  }
});

// Register a new user
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password, publicKey } = req.body;
    
    if (!username || !password || !publicKey) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Validate username format (alphanumeric, 3-30 chars)
    if (!username.match(/^[a-zA-Z0-9_]{3,30}$/)) {
      return res.status(400).json({ 
        message: 'Username must be 3-30 characters and contain only letters, numbers, and underscores' 
      });
    }
    
    // Validate password strength (at least 8 chars, with complexity)
    if (password.length < 8 || !password.match(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)) {
      return res.status(400).json({ 
        message: 'Password must be at least 8 characters and include uppercase, lowercase, number and special character' 
      });
    }
    
    // Validate public key format (basic check)
    if (!publicKey.includes('BEGIN PUBLIC KEY') || !publicKey.includes('END PUBLIC KEY')) {
      return res.status(400).json({ message: 'Invalid public key format' });
    }
    
    // Check if username already exists - use a caching layer if available
    let existingUser;
    
    // Try Redis cache first if available
    if (global.redisGetAsync) {
      const cachedUser = await global.redisGetAsync(`user:${username}`);
      if (cachedUser) {
        existingUser = JSON.parse(cachedUser);
      }
    }
    
    // Fallback to database lookup
    if (!existingUser) {
      existingUser = await User.findOne({ username });
      
      // Cache result for future checks
      if (existingUser && global.redisSetAsync) {
        await global.redisSetAsync(`user:${username}`, JSON.stringify({
          username: existingUser.username,
          _id: existingUser._id
        }), 'EX', 300); // Cache for 5 minutes
      }
    }
    
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }
    
    // Hash the password with Argon2
    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 2 ** 16, // 64MiB
      timeCost: 3, // 3 iterations
      parallelism: 1 // 1 thread
    });
    
    // Create new user
    const newUser = new User({
      username,
      password: hashedPassword,
      publicKey,
      createdAt: new Date(),
      lastLogin: null
    });
    
    await newUser.save();
    
    logger.info(`User registered: ${username}`);
    
    // Generate JWT token
    const token = jwt.sign(
      { username: newUser.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRATION }
    );
    
    // Invalidate user cache
    if (global.redisClient) {
      await global.redisClient.del(`user:${username}`);
      
      // Update user list cache
      await global.redisClient.del('all_users');
    }
    
    return res.status(201).json({
      message: 'User registered successfully',
      token,
      username: newUser.username
    });
  } catch (error) {
    logger.error('Registration error:', error);
    return res.status(500).json({ message: 'Registration failed' });
  }
});

// Login user
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Missing username or password' });
    }
    
    // Find user
    const user = await User.findOne({ username });
    if (!user) {
      // Use constant-time comparison to prevent timing attacks
      await argon2.verify('$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$hash', password);
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Verify password
    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      logger.warn(`Failed login attempt for user: ${username}`);
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Update last login timestamp
    user.lastLogin = new Date();
    await user.save();
    
    // Generate JWT token
    const token = jwt.sign(
      { username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRATION }
    );
    
    logger.info(`User logged in: ${username}`);
    
    return res.status(200).json({
      message: 'Login successful',
      token,
      username: user.username
    });
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({ message: 'Login failed' });
  }
});

// Get current user profile - use caching
router.get('/profile', authenticate, async (req, res) => {
  try {
    // Try to get from cache first
    if (global.redisGetAsync) {
      const cachedProfile = await global.redisGetAsync(`profile:${req.user.username}`);
      if (cachedProfile) {
        return res.status(200).json(JSON.parse(cachedProfile));
      }
    }
    
    // Get from database
    const user = await User.findOne({ username: req.user.username }, 'username publicKey lastLogin');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const profile = {
      username: user.username,
      publicKey: user.publicKey,
      lastLogin: user.lastLogin
    };
    
    // Cache the profile
    if (global.redisSetAsync) {
      await global.redisSetAsync(`profile:${req.user.username}`, JSON.stringify(profile), 'EX', 300); // Cache for 5 minutes
    }
    
    return res.status(200).json(profile);
  } catch (error) {
    logger.error('Profile retrieval error:', error);
    return res.status(500).json({ message: 'Failed to retrieve profile' });
  }
});

// Verify token validity - heavily cached for performance
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ message: 'No token provided' });
    }
    
    // Check token cache first
    if (global.redisGetAsync) {
      try {
        const cachedResult = await global.redisGetAsync(`token:${token.substring(0, 10)}`);
        if (cachedResult) {
          const result = JSON.parse(cachedResult);
          // Only return cached valid tokens
          if (result.valid) {
            return res.status(200).json({ valid: true });
          }
        }
      } catch (err) {
        logger.error('Token cache error:', err);
        // Continue with verification if cache fails
      }
    }
    
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.username) {
      throw new Error('Invalid token');
    }
    
    // Check if user exists
    const user = await User.findOne({ username: decoded.username });
    
    if (!user) {
      // Cache negative result
      if (global.redisSetAsync) {
        await global.redisSetAsync(`token:${token.substring(0, 10)}`, JSON.stringify({ valid: false }), 'EX', 60);
      }
      return res.status(401).json({ valid: false });
    }
    
    // Cache successful verification
    if (global.redisSetAsync) {
      await global.redisSetAsync(`token:${token.substring(0, 10)}`, JSON.stringify({ 
        valid: true,
        username: decoded.username
      }), 'EX', 3600); // Cache for 1 hour (but shorter than token expiry)
    }
    
    return res.status(200).json({ valid: true });
  } catch (error) {
    logger.error('Token verification error:', error);
    return res.status(401).json({ valid: false });
  }
});

// Logout user - invalidate token
router.post('/logout', authenticate, async (req, res) => {
  try {
    // Get token from authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token && global.redisSetAsync) {
      // Add token to blacklist with TTL equal to remaining validity time
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const expiryTime = decoded.exp - Math.floor(Date.now() / 1000);
        
        if (expiryTime > 0) {
          await global.redisSetAsync(`token:blacklist:${token.substring(0, 10)}`, '1', 'EX', expiryTime);
        }
      } catch (err) {
        // Token might already be invalid
        logger.debug('Token invalidation error:', err);
      }
    }
    
    logger.info(`User logged out: ${req.user.username}`);
    
    return res.status(200).json({ message: 'Logout successful' });
  } catch (error) {
    logger.error('Logout error:', error);
    return res.status(500).json({ message: 'Logout failed' });
  }
});

module.exports = router;