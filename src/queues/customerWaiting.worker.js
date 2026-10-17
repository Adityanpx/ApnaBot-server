const { Worker } = require('bullmq');
const notificationService = require('../services/notification.service');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');

// Must match the prefix used by customerWaiting.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('customer-waiting', async (job) => {
  const outcome = await notificationService.runCustomerWaitingCheck(job.data);
  logger.info(`Customer waiting check for customer ${job.data.customerId}: ${outcome}`);
  return outcome;
}, {
  connection: workerConnection,
  prefix,
  concurrency: 5
});

worker.on('failed', (job, err) => {
  logger.error(`Customer waiting job failed: ${job && job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Customer waiting worker error: ${err.message}`);
});

module.exports = worker;
