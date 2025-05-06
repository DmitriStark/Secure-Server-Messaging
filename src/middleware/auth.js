const jwt = require("jsonwebtoken");
const User = require("../models/User");
const logger = require("../utils/logger");

const JWT_SECRET = process.env.JWT_SECRET;

const tokenBlacklist = new Map();

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
}, 300000);

const isTokenBlacklisted = (token) => {
  if (!token) return false;

  const tokenKey = token.substring(0, 10);
  return tokenBlacklist.has(tokenKey);
};

const verifyToken = (token) => {
  try {
    if (isTokenBlacklisted(token)) {
      throw new Error("Token has been revoked");
    }

    return jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    });
  } catch (err) {
    throw err;
  }
};

const userCache = new Map();
const USER_CACHE_TTL = 300;

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
}, 60000);

const getUser = async (username) => {
  const cached = userCache.get(username);
  if (cached && Math.floor(Date.now() / 1000) < cached.expiry) {
    return cached.user;
  }

  const user = await User.findOne({ username }, "username publicKey")
    .lean()
    .exec();

  if (user) {
    userCache.set(username, {
      user,
      expiry: Math.floor(Date.now() / 1000) + USER_CACHE_TTL,
    });
  }

  return user;
};

const authenticate = async (req, res, next) => {
  if (req.method === "OPTIONS") {
    return next();
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ message: "No authorization header provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.username) {
      return res.status(401).json({ message: "Invalid token" });
    }

    const user = await getUser(decoded.username);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = {
      username: user.username,
      publicKey: user.publicKey,
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    } else if (error.message === "Token has been revoked") {
      return res.status(401).json({ message: "Token has been revoked" });
    } else {
      logger.error("Authentication error:", error.message);
      return res.status(401).json({ message: "Authentication failed" });
    }
  }
};

const blacklistToken = (token) => {
  try {
    if (!token) return false;

    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });

    const tokenKey = token.substring(0, 10);
    tokenBlacklist.set(tokenKey, decoded.exp);

    return true;
  } catch (err) {
    logger.error("Token blacklisting error:", err.message);
    return false;
  }
};

module.exports = {
  authenticate,
  blacklistToken,
};
