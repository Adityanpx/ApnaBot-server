// The Redis connections every BullMQ queue and worker shares, instead of each
// opening its own (Redis Cloud's plan allows 30 connections, and a deploy
// briefly runs two instances side by side):
//
//   queueConnection   the app's general client (config/redis.js) — Queues
//                     only send jobs, so they share it. Commands fail after a
//                     few reconnect attempts while Redis is down, so a request
//                     that queues a message errors instead of hanging.
//   workerConnection  one connection for every Worker's ordinary commands
//                     (and QueueEvents). BullMQ requires maxRetriesPerRequest
//                     null here; each Worker / QueueEvents still opens its own
//                     blocking copy of it (connection.duplicate()) to wait for
//                     jobs, so job pickup is unchanged.
//
// Per instance: 2 shared + 1 blocking per Worker (4) + QueueEvents (1, only
// once an ordered send needs it) — was ~13. BullMQ never closes a connection
// it was given, so closing a Queue/Worker leaves these open.
const Redis = require('ioredis');
const config = require('./env');
const queueConnection = require('./redis');
const { reconnectDelay } = require('./redisRetry');
const logger = require('../utils/logger');

const workerConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: reconnectDelay
});

workerConnection.on('error', (err) => {
  logger.error(`Redis worker connection error: ${err.message}`);
});

module.exports = { queueConnection, workerConnection };
