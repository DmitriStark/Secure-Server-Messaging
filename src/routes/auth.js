// Authentication routes
const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRATION = '24h';

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const { username, password, publicKey } = req.body;
    
    if (!username || !password || !publicKey) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Check if username already exists
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already exists' });
    }
    
    // Hash the password with Argon2 (more secure than bcrypt)
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
      publicKey
    });
    
    await newUser.save();
    
    logger.info(`User registered: ${username}`);
    
    // Generate JWT token
    const token = jwt.sign(
      { username: newUser.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRATION }
    );
    
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
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ message: 'Missing username or password' });
    }
    
    // Find user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
    // Verify password
    const isPasswordValid = await argon2.verify(user.password, password);
    if (!isPasswordValid) {
      logger.warn(`Failed login attempt for user: ${username}`);
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    
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

// Get current user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    return res.status(200).json({
      username: req.user.username,
      publicKey: req.user.publicKey
    });
  } catch (error) {
    logger.error('Profile retrieval error:', error);
    return res.status(500).json({ message: 'Failed to retrieve profile' });
  }
});

// Verify token validity
router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ message: 'No token provided' });
    }
    
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findOne({ username: decoded.username });
    
    if (!user) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    return res.status(200).json({ valid: true });
  } catch (error) {
    logger.error('Token verification error:', error);
    return res.status(401).json({ valid: false });
  }
});

module.exports = router;