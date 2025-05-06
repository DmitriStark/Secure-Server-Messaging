// // Optimized authentication middleware for high concurrency
// const jwt = require('jsonwebtoken');
// const User = require('../models/User');
// const logger = require('../utils/logger');

// // Constants
// const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// // Efficient token blacklist checker - Checks if token has been invalidated
// const isTokenBlacklisted = async (token) => {
//   if (!token || !global.redisGetAsync) return false;
  
//   try {
//     // Check Redis blacklist
//     const blacklisted = await global.redisGetAsync(`token:blacklist:${token.substring(0, 10)}`);
//     return !!blacklisted;
//   } catch (err) {
//     logger.error('Token blacklist check error:', err);
//     return false;
//   }
// };

// // Cached token verification - For high performance
// const verifyTokenWithCache = async (token) => {
//   // First check cache if Redis is available
//   if (global.redisGetAsync) {
//     try {
//       // Get cached verification result
//       const cached = await global.redisGetAsync(`token:${token.substring(0, 10)}`);
//       if (cached) {
//         const result = JSON.parse(cached);
//         if (result.valid && result.username) {
//           // Still need to check blacklist
//           const blacklisted = await isTokenBlacklisted(token);
//           if (blacklisted) {
//             throw new Error('Token has been revoked');
//           }
//           return { username: result.username };
//         }
//       }
//     } catch (err) {
//       if (err.message === 'Token has been revoked') {
//         throw err;
//       }
//       // Cache miss or error, continue with verification
//       logger.debug('Token cache miss:', err);
//     }
//   }
  
//   // Verify JWT token
//   const decoded = jwt.verify(token, JWT_SECRET);
  
//   // Check if token is blacklisted
//   const blacklisted = await isTokenBlacklisted(token);
//   if (blacklisted) {
//     throw new Error('Token has been revoked');
//   }
  
//   return decoded;
// };

// // User caching for better performance
// const getUserFromCache = async (username) => {
//   // Try cache first
//   if (global.redisGetAsync) {
//     try {
//       const cachedUser = await global.redisGetAsync(`user:${username}`);
//       if (cachedUser) {
//         return JSON.parse(cachedUser);
//       }
//     } catch (err) {
//       logger.debug('User cache error:', err);
//     }
//   }
  
//   // Fallback to database
//   const user = await User.findOne({ username }, 'username publicKey');
  
//   // Cache user if found
//   if (user && global.redisSetAsync) {
//     try {
//       await global.redisSetAsync(`user:${username}`, JSON.stringify({
//         username: user.username,
//         publicKey: user.publicKey
//       }), 'EX', 300); // Cache for 5 minutes
//     } catch (err) {
//       logger.debug('User caching error:', err);
//     }
//   }
  
//   return user;
// };

// // Enhanced authentication middleware with caching
// const authenticate = async (req, res, next) => {
//   try {
//     // Get token from headers
//     const authHeader = req.headers.authorization;
//     if (!authHeader) {
//       return res.status(401).json({ message: 'No authorization header provided' });
//     }

//     const token = authHeader.split(' ')[1];
//     if (!token) {
//       return res.status(401).json({ message: 'No token provided' });
//     }

//     // Verify token with caching
//     const decoded = await verifyTokenWithCache(token);
    
//     // Get user info
//     const user = await getUserFromCache(decoded.username);
    
//     if (!user) {
//       return res.status(401).json({ message: 'User not found' });
//     }

//     // Add user info to request
//     req.user = {
//       username: user.username,
//       publicKey: user.publicKey
//     };
    
//     next();
//   } catch (error) {
//     if (error.name === 'TokenExpiredError') {
//       return res.status(401).json({ message: 'Token expired' });
//     } else if (error.message === 'Token has been revoked') {
//       return res.status(401).json({ message: 'Token has been revoked' });
//     } else {
//       logger.error('Authentication error:', error);
//       return res.status(401).json({ message: 'Invalid token' });
//     }
//   }
// };

// module.exports = { authenticate };



// Optimized authentication middleware for 10,000+ concurrent connections
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const logger = require('../utils/logger');

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Simple in-memory token blacklist with TTL
// For production with multiple servers, use Redis instead
const tokenBlacklist = new Map();

// Clean up expired blacklist entries every 5 minutes
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;
  
  for (const [token, expiry] of tokenBlacklist.entries()) {
    if (now >= expiry) {
      tokenBlacklist.delete(token);
      removed++;
    }
  }
  
  if (removed > 0) {
    logger.debug(`Cleaned up ${removed} expired blacklist tokens`);
  }
}, 300000); // 5 minutes

// Very efficient token blacklist checker
const isTokenBlacklisted = (token) => {
  if (!token) return false;
  
  // Use first 10 chars as a key to avoid memory issues with long tokens
  const tokenKey = token.substring(0, 10);
  return tokenBlacklist.has(tokenKey);
};

// Fast token verification
const verifyToken = (token) => {
  try {
    // First check if token is blacklisted (much faster than verification)
    if (isTokenBlacklisted(token)) {
      throw new Error('Token has been revoked');
    }
    
    // Verify JWT token
    return jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'] // Explicitly specify algorithm for security
    });
  } catch (err) {
    throw err;
  }
};

// High-performance in-memory user cache
// Use Map instead of object for better performance with large number of keys
const userCache = new Map();
const USER_CACHE_TTL = 300; // 5 minutes in seconds

// Clean up expired cache entries every minute
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let removed = 0;
  
  for (const [username, data] of userCache.entries()) {
    if (now >= data.expiry) {
      userCache.delete(username);
      removed++;
    }
  }
  
  if (removed > 0 && removed % 100 === 0) {
    logger.debug(`Cleaned up ${removed} expired cached users`);
  }
}, 60000); // 1 minute

// Efficient user fetcher with caching
const getUser = async (username) => {
  // Check cache first
  const cached = userCache.get(username);
  if (cached && Math.floor(Date.now() / 1000) < cached.expiry) {
    return cached.user;
  }
  
  // Cache miss - get from database
  const user = await User.findOne({ username }, 'username publicKey')
    .lean() // Use lean() for better performance
    .exec();
  
  // Cache user for 5 minutes
  if (user) {
    userCache.set(username, {
      user,
      expiry: Math.floor(Date.now() / 1000) + USER_CACHE_TTL
    });
  }
  
  return user;
};

// High-performance authentication middleware
const authenticate = async (req, res, next) => {
  // Skip auth check for OPTIONS requests (CORS preflight)
  if (req.method === 'OPTIONS') {
    return next();
  }
  
  try {
    // Get token from headers
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: 'No authorization header provided' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    // Verify token (using efficient verification)
    const decoded = verifyToken(token);
    if (!decoded || !decoded.username) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    
    // Get user info (with caching)
    const user = await getUser(decoded.username);
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    // Add minimal user info to request
    req.user = {
      username: user.username,
      publicKey: user.publicKey
    };
    
    // Continue to next middleware
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    } else if (error.message === 'Token has been revoked') {
      return res.status(401).json({ message: 'Token has been revoked' });
    } else {
      logger.error('Authentication error:', error.message);
      return res.status(401).json({ message: 'Authentication failed' });
    }
  }
};

// Blacklist a token (for logout)
const blacklistToken = (token) => {
  try {
    if (!token) return false;
    
    // Verify token to get expiry
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
    
    // Add to blacklist with expiry
    const tokenKey = token.substring(0, 10);
    tokenBlacklist.set(tokenKey, decoded.exp);
    
    return true;
  } catch (err) {
    logger.error('Token blacklisting error:', err.message);
    return false;
  }
};

module.exports = { 
  authenticate,
  blacklistToken
};