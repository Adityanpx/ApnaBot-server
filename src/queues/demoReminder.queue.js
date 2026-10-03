const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');
const { queueConnection } = require('../config/queueConnection');

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by demoReminder.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// One delayed job per booking (jobId below). Completed jobs are removed at
// once so a re-fixed demo time can reuse the id — BullMQ ignores an add
// whose jobId still exists.
const demoReminderQueue = new Queue('demo-reminder', {
  connection: queueConnection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 500
  }
});

demoReminderQueue.on('error', (err) => {
  logger.error(`Demo reminder queue error: ${err.message}`);
});

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
