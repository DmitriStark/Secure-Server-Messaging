// repositories/UserRepository.js
const User = require("../models/User");

class UserRepository {
  async findByUsername(username) {
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

    return existingUser;
  }

  async createUser(username, hashedPassword, publicKey) {
    const newUser = new User({
      username,
      password: hashedPassword,
      publicKey,
      createdAt: new Date(),
      lastLogin: null,
    });

    await newUser.save();

    if (global.redisClient) {
      await global.redisClient.del(`user:${username}`);
      await global.redisClient.del("all_users");
    }

    return newUser;
  }

  async updateLastLogin(user) {
    user.lastLogin = new Date();
    await user.save();
    return user;
  }

  async getUserProfile(username) {
    const user = await User.findOne(
      { username },
      "username publicKey lastLogin"
    );
    return user;
  }

  async getProfileFromCache(username) {
    if (global.redisGetAsync) {
      const cachedProfile = await global.redisGetAsync(
        `profile:${username}`
      );
      if (cachedProfile) {
        return JSON.parse(cachedProfile);
      }
    }
    return null;
  }

  async cacheProfile(username, profile) {
    if (global.redisSetAsync) {
      await global.redisSetAsync(
        `profile:${username}`,
        JSON.stringify(profile),
        "EX",
        300
      );
    }
  }

  async getTokenFromCache(token) {
    if (global.redisGetAsync) {
      try {
        const cachedResult = await global.redisGetAsync(
          `token:${token.substring(0, 10)}`
        );
        if (cachedResult) {
          return JSON.parse(cachedResult);
        }
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  async cacheToken(token, data, expiryTime) {
    if (global.redisSetAsync) {
      await global.redisSetAsync(
        `token:${token.substring(0, 10)}`,
        JSON.stringify(data),
        "EX",
        expiryTime
      );
    }
  }

  async blacklistToken(token, expiryTime) {
    if (global.redisSetAsync) {
      await global.redisSetAsync(
        `token:blacklist:${token.substring(0, 10)}`,
        "1",
        "EX",
        expiryTime
      );
    }
  }
}

module.exports = new UserRepository();