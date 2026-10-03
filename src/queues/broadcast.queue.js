const { Queue } = require('bullmq');
const logger = require('../utils/logger');
const config = require('../config/env');
const { queueConnection } = require('../config/queueConnection');

// Namespaces queue keys per environment so a local dev run can never join
// the production queue, even if REDIS_URL is accidentally shared. Must
// match the prefix used by broadcast.worker.js.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const broadcastQueue = new Queue('broadcast-outbound', {
  connection: queueConnection,
  prefix,
  defaultJobOptions: {
    // No retries: each job fans a template send out to up to 50 recipients,
    // tracked per-recipient inside the worker (see broadcast.worker.js). A
    // BullMQ retry would re-run the whole batch and re-send to recipients
    // who already succeeded on the first attempt.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500
  }
});

broadcastQueue.on('error', (err) => {
  logger.error(`Broadcast queue error: ${err.message}`);
});

const addToBroadcastQueue = async (jobData) => {
  return broadcastQueue.add('send-broadcast-batch', jobData);
};

module.exports = {
  broadcastQueue,
  addToBroadcastQueue
};
