const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');
const { queueConnection } = require('../config/queueConnection');

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by sessionTimeout.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const sessionTimeoutQueue = new Queue('session-timeout', {
  connection: queueConnection,
  prefix,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

sessionTimeoutQueue.on('error', (err) => {
  logger.error(`Session timeout queue error: ${err.message}`);
});

const addToSessionTimeoutQueue = async (jobData, opts) => {
  return sessionTimeoutQueue.add('check-timeout', jobData, opts);
};

module.exports = {
  sessionTimeoutQueue,
  addToSessionTimeoutQueue
};
