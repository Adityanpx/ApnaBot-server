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
// match the prefix used by demoReminder.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// One delayed job per booking (jobId below). Completed jobs are removed at
// once so a re-fixed demo time can reuse the id — BullMQ ignores an add
// whose jobId still exists.
const demoReminderQueue = new Queue('demo-reminder', {
  connection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 500
  }
});

demoReminderQueue.on('error', (err) => {
  logger.error(`Demo reminder queue error: ${err.message}`);
});

// connection's retryStrategy gives up after 10 attempts, which makes
// ioredis emit 'end' on its underlying client instead of retrying further.
// There's no automatic recovery from that state, so exit and let pm2 (see
// deploy.yml) restart the process and reconnect from scratch.
demoReminderQueue.client.then((client) => {
  client.on('end', () => {
    logger.error('CRITICAL: Redis connection for demo reminder queue permanently closed (retries exhausted); exiting to trigger process restart');
    process.exit(1);
  });
}).catch(() => {});

const jobIdFor = (bookingId) => `demo-reminder-${bookingId}`;

/** Drops a booking's pending reminder, if any. The worker re-checks the booking anyway. */
const removeDemoReminder = async (bookingId) => {
  const job = await demoReminderQueue.getJob(jobIdFor(bookingId));
  if (job) await job.remove();
};

/** (Re)plans a booking's reminder to fire at `at`. */
const scheduleDemoReminder = async (jobData, at) => {
  await removeDemoReminder(jobData.bookingId);
  return demoReminderQueue.add('send-reminder', jobData, {
    jobId: jobIdFor(jobData.bookingId),
    delay: Math.max(0, new Date(at).getTime() - Date.now())
  });
};

module.exports = {
  demoReminderQueue,
  scheduleDemoReminder,
  removeDemoReminder
};
