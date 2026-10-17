const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');
const { queueConnection } = require('../config/queueConnection');

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by customerWaiting.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// One delayed job per customer (jobId below): while one is pending, a further
// add for the same customer is ignored, so a chatty customer gets one
// "customer waiting" check, not one per message. Completed jobs are removed at
// once so the id can be reused.
const customerWaitingQueue = new Queue('customer-waiting', {
  connection: queueConnection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 500
  }
});

customerWaitingQueue.on('error', (err) => {
  logger.error(`Customer waiting queue error: ${err.message}`);
});

const scheduleCustomerWaiting = async (jobData, delayMs) => {
  return customerWaitingQueue.add('check-waiting', jobData, {
    jobId: `customer-waiting-${jobData.customerId}`,
    delay: delayMs
  });
};

module.exports = {
  customerWaitingQueue,
  scheduleCustomerWaiting
};
