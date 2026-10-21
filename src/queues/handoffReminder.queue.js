const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');
const { queueConnection } = require('../config/queueConnection');

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by handoffReminder.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// One delayed "still waiting" job per open handoff. The job id carries the moment the handoff was
// opened, so clearing and re-opening it can never cancel (or be cancelled by) the other one.
// Completed jobs are removed at once.
const handoffReminderQueue = new Queue('handoff-reminder', {
  connection: queueConnection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 500
  }
});

handoffReminderQueue.on('error', (err) => {
  logger.error(`Handoff reminder queue error: ${err.message}`);
});

const reminderJobId = (customerId, needsHumanAt) => `handoff-reminder-${customerId}-${new Date(needsHumanAt).getTime()}`;

const scheduleHandoffReminder = async (jobData, delayMs) => {
  return handoffReminderQueue.add('remind', jobData, {
    jobId: reminderJobId(jobData.customerId, jobData.needsHumanAt),
    delay: delayMs
  });
};

/** Cancels a pending reminder. A job that already ran or never existed is fine. */
const cancelHandoffReminder = async (customerId, needsHumanAt) => {
  const job = await handoffReminderQueue.getJob(reminderJobId(customerId, needsHumanAt));
  if (job) await job.remove();
};

module.exports = {
  handoffReminderQueue,
  reminderJobId,
  scheduleHandoffReminder,
  cancelHandoffReminder
};
