const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');

const redisUrl = new URL(process.env.REDIS_URL);

const connection = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port),
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 50, 2000);
  }
};

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by sessionTimeout.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const sessionTimeoutQueue = new Queue('session-timeout', {
  connection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

sessionTimeoutQueue.on('error', (err) => {
  logger.error(`Session timeout queue error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
sessionTimeoutQueue.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for session timeout queue permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

const addToSessionTimeoutQueue = async (jobData, opts) => {
  return sessionTimeoutQueue.add('check-timeout', jobData, opts);
};

module.exports = {
  sessionTimeoutQueue,
  addToSessionTimeoutQueue
};
