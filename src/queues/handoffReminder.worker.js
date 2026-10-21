const { Worker } = require('bullmq');
const handoffService = require('../services/handoff.service');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');

// Must match the prefix used by handoffReminder.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('handoff-reminder', async (job) => {
  const outcome = await handoffService.runReminder(job.data);
  logger.info(`Handoff reminder for customer ${job.data.customerId}: ${outcome}`);
  return outcome;
}, {
  connection: workerConnection,
  prefix,
  concurrency: 5
});

worker.on('failed', (job, err) => {
  logger.error(`Handoff reminder job failed: ${job && job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Handoff reminder worker error: ${err.message}`);
});

module.exports = worker;
