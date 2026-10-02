const { Worker } = require('bullmq');
const demoReminderService = require('../services/demoReminder.service');
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

// Must match the prefix used by demoReminder.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('demo-reminder', async (job) => {
  const outcome = await demoReminderService.runReminder(job.data);
  logger.info(`Demo reminder for booking ${job.data.bookingId}: ${outcome}`);
  return outcome;
}, {
  connection,
  prefix,
  concurrency: 5
});

worker.on('failed', (job, err) => {
  logger.error(`Demo reminder job failed: ${job && job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Demo reminder worker error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
worker.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for demo reminder worker permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

module.exports = worker;
