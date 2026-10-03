const { Worker } = require('bullmq');
const demoReminderService = require('../services/demoReminder.service');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');

// Must match the prefix used by demoReminder.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('demo-reminder', async (job) => {
  const outcome = await demoReminderService.runReminder(job.data);
  logger.info(`Demo reminder for booking ${job.data.bookingId}: ${outcome}`);
  return outcome;
}, {
  connection: workerConnection,
  prefix,
  concurrency: 5
});

worker.on('failed', (job, err) => {
  logger.error(`Demo reminder job failed: ${job && job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Demo reminder worker error: ${err.message}`);
});

module.exports = worker;
