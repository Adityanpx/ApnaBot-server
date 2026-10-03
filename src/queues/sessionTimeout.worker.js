const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const bookingService = require('../services/booking.service');
const supabase = require('../config/supabase');
const { getSystemMessage } = require('../utils/systemMessages');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');

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

    // The customer's chosen language (systemMessages.js); English if unknown.
    const { data: customer } = await supabase
      .from('customers').select('preferred_language')
      .eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
    await whatsappService.sendTextMessage(
      phoneNumberId,
      encryptedAccessToken,
      customerNumber,
      getSystemMessage('sessionTimeout', customer?.preferred_language)
    );
    await bookingService.deleteBookingSession(businessId, customerNumber);
  } catch (error) {
    logger.error(`Session timeout check failed for business ${businessId}, customer ${customerNumber}:`, {
      error: error.message
    });
  }
}, {
  connection: workerConnection,
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

module.exports = worker;
