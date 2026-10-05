const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const walletService = require('../services/wallet.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');
const { buildBodyComponents } = require('../utils/templateComponents');

// Must match the prefix used by broadcast.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// Resolves a recipient's own {{1}}, {{2}}... values from variableMapping
// (see broadcast.controller.js createBroadcast) instead of the shared,
// broadcast-wide components array. 'customer.name' pulls from that
// recipient's own data; 'static' uses the fixed value from the mapping.
const resolveRecipientComponents = (variableMapping, recipient) => {
  const values = [...variableMapping]
    .sort((a, b) => a.position - b.position)
    .map((entry) => {
      const text = entry.source === 'customer.name'
        ? recipient.customer?.name
        : entry.value;
      const trimmed = text === null || text === undefined ? '' : String(text).trim();
      if (!trimmed) {
        throw new Error(entry.source === 'customer.name'
          ? 'recipient has no name on file'
          : 'variable mapping has an empty static value');
      }
      return String(text);
    });

  return buildBodyComponents(values);
};

const worker = new Worker('broadcast-outbound', async (job) => {
  const { broadcastId, businessId, phoneNumberId, encryptedAccessToken, templateName, language, components, variableMapping, ratePerMessage, billed, recipients } = job.data;
  // Refund only what broadcast.controller.js actually debited. Jobs queued
  // before `billed` existed fall back to the billing switch (same condition
  // as the debit, since ratePerMessage > 0 is checked below).
  const debited = billed !== undefined ? billed : config.WALLET_BILLING_ENABLED;

  let sent = 0;
  let failed = 0;

  // Per-recipient failures (e.g. a single bad number) must not fail the
  // whole job - attempts:1 on this queue means a thrown job error loses
  // progress tracking for the batch, not just a retry.
  // The header component (if any) has no per-recipient variables - it's built
  // once in broadcast.controller.js and passed through unchanged, same as the
  // non-mapped `components` path below.
  const headerComponent = (components || []).find((c) => c.type === 'header');

  for (const recipient of recipients) {
    try {
      const recipientComponents = variableMapping
        ? [...(headerComponent ? [headerComponent] : []), ...resolveRecipientComponents(variableMapping, recipient)]
        : components;
      await whatsappService.sendTemplateMessage(phoneNumberId, encryptedAccessToken, recipient.whatsappNumber, templateName, language, recipientComponents);
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error(`Broadcast ${broadcastId}: failed to send to ${recipient.whatsappNumber}`, {
        error: error.response?.data || error.message
      });

      if (debited && ratePerMessage > 0) {
        try {
          await walletService.refundToWallet(businessId, ratePerMessage, broadcastId, `Refund: failed broadcast message to ${recipient.whatsappNumber}`);
        } catch (refundErr) {
          logger.error(`Broadcast ${broadcastId}: failed to refund ${ratePerMessage} paise for ${recipient.whatsappNumber}`, refundErr);
        }
      }
    }
  }

  const { error: rpcErr } = await supabase.rpc('increment_broadcast_progress', {
    p_broadcast_id: broadcastId,
    p_sent_delta: sent,
    p_failed_delta: failed
  });
  if (rpcErr) logger.error(`Broadcast ${broadcastId}: failed to update progress`, rpcErr);

  logger.info(`Broadcast batch processed for business ${businessId}: ${sent} sent, ${failed} failed`, { broadcastId });
  return { sent, failed };
}, {
  connection: workerConnection,
  prefix,
  concurrency: 5
});

worker.on('completed', (job) => {
  logger.info(`Broadcast job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Broadcast job failed: ${job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Broadcast worker error: ${err.message}`);
});

module.exports = worker;
