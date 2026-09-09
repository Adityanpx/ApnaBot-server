const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const bookingService = require('../services/booking.service');
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

// Must match the prefix used by sessionTimeout.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('session-timeout', async (job) => {
  const { businessId, customerNumber, phoneNumberId, encryptedAccessToken, expectedToken } = job.data;

  try {
    const session = await bookingService.getBookingSession(businessId, customerNumber);
    if (!session || session.timeoutToken !== expectedToken) {
      // Stale job: the customer replied (saveBookingSession rotated the
      // token onto a newer job) or the session already ended some other
      // way (booking completed, TTL lapsed). Nothing to do.
      return;
    }

    await whatsappService.sendTextMessage(
      phoneNumberId,
      encryptedAccessToken,
      customerNumber,
      "Looks like you've stepped away — I've ended this session due to inactivity. Send 'book' anytime to start again."
    );
    await bookingService.deleteBookingSession(businessId, customerNumber);
  } catch (error) {
    logger.error(`Session timeout check failed for business ${businessId}, customer ${customerNumber}:`, {
      error: error.message
    });
  }
}, {
  connection,
  prefix,
  concurrency: 5
});

worker.on('completed', (job) => {
  logger.info(`Session timeout job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Session timeout job failed: ${job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Session timeout worker error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
worker.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for session timeout worker permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

module.exports = worker;
