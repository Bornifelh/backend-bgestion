const Redis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  logger.info('Connected to Redis');
});

redis.on('error', (err) => {
  logger.error('Redis error:', err);
});

// Cache utilities
const cache = {
  async get(key) {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error('Cache get error:', err);
      return null;
    }
  },

  async set(key, value, expireSeconds = 3600) {
    try {
      await redis.setex(key, expireSeconds, JSON.stringify(value));
      return true;
    } catch (err) {
      logger.error('Cache set error:', err);
      return false;
    }
  },

  async del(key) {
    try {
      await redis.del(key);
      return true;
    } catch (err) {
      logger.error('Cache delete error:', err);
      return false;
    }
  },

  async invalidatePattern(pattern) {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      return true;
    } catch (err) {
      logger.error('Cache invalidate pattern error:', err);
      return false;
    }
  },

  // Store refresh tokens
  async storeRefreshToken(userId, token, expireSeconds = 2592000) { // 30 days
    try {
      await redis.setex(`refresh_token:${userId}`, expireSeconds, token);
      return true;
    } catch (err) {
      logger.error('Store refresh token error:', err);
      return false;
    }
  },

  async getRefreshToken(userId) {
    try {
      return await redis.get(`refresh_token:${userId}`);
    } catch (err) {
      logger.error('Get refresh token error:', err);
      return null;
    }
  },

  async deleteRefreshToken(userId) {
    try {
      await redis.del(`refresh_token:${userId}`);
      return true;
    } catch (err) {
      logger.error('Delete refresh token error:', err);
      return false;
    }
  },

  // Online users tracking
  async setUserOnline(userId, socketId) {
    try {
      await redis.hset('online_users', userId, socketId);
      return true;
    } catch (err) {
      logger.error('Set user online error:', err);
      return false;
    }
  },

  async setUserOffline(userId) {
    try {
      await redis.hdel('online_users', userId);
      return true;
    } catch (err) {
      logger.error('Set user offline error:', err);
      return false;
    }
  },

  async getOnlineUsers() {
    try {
      return await redis.hgetall('online_users');
    } catch (err) {
      logger.error('Get online users error:', err);
      return {};
    }
  }
};

module.exports = { redis, cache };
