const Redis = require('ioredis');
const config = require('./env');
const { reconnectDelay } = require('./redisRetry');
const logger = require('../utils/logger');

// The app's general Redis client (caches, usage counters, sessions) — and,
// shared, the connection every BullMQ Queue sends jobs on (see
// config/queueConnection.js). maxRetriesPerRequest 3: while Redis is
// unreachable a command fails after a few reconnect attempts instead of
// hanging the request that issued it. Reconnects forever (redisRetry.js).
const redis = new Redis(config.REDIS_URL, {
  retryStrategy: reconnectDelay,
  maxRetriesPerRequest: 3
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error('Redis connection error:', err);
});

module.exports = redis;
