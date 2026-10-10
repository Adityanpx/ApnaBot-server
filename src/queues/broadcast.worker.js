const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const walletService = require('../services/wallet.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');
const { buildTemplateComponents } = require('../utils/templateComponents');
const { splitMapping } = require('../utils/templateMapping');
const { extractMetaMessageId } = require('../services/outboundMessageId.service');
const { fromSendError } = require('../utils/whatsappErrors');
const { notifyBroadcastProgress } = require('../services/broadcastProgress.service');
const deliverySignals = require('../services/deliverySignals.service');
const { isPaymentIssueCode } = require('../services/accountHealth.service');

// Must match the prefix used by broadcast.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// Resolves a recipient's own values from variableMapping (see
// broadcast.controller.js createBroadcast) instead of the shared,
// broadcast-wide components array: body {{1}}, {{2}}... ordered by position,
// plus an optional TEXT-header variable (target 'header') and dynamic URL
// button suffixes (target 'button' + buttonIndex). 'customer.name' pulls from
// that recipient's own data; 'static' uses the fixed value from the mapping.
// `mediaHeader` is the shared IMAGE/VIDEO/DOCUMENT header the controller
// built once (no per-recipient variables); it is passed through unchanged, and
// so are `quickReplies` (the template's quick_reply payload components).
// Jobs queued before quickReplyComponents existed carry none.
const resolveValue = (entry, recipient) => {
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
};

const resolveRecipientComponents = (variableMapping, recipient, mediaHeader = null, quickReplies = []) => {
  const parts = splitMapping(variableMapping);
  const body = [...parts.body]
    .sort((a, b) => a.position - b.position)
    .map((entry) => resolveValue(entry, recipient));
  const header = parts.header.map((entry) => resolveValue(entry, recipient));
  const buttons = {};
  for (const entry of parts.button) buttons[entry.buttonIndex] = resolveValue(entry, recipient);

  const built = buildTemplateComponents({ header_type: header.length > 0 ? 'TEXT' : 'NONE' }, { body, header, buttons, quickReplies });
  return [...(header.length === 0 && mediaHeader ? [mediaHeader] : []), ...built];
};

// Record one recipient's outcome on its broadcast_recipients row (made 'queued' by
// sendBroadcast). The wamid is saved here, at once, so Meta's status webhooks find
// the row. A broadcast sent before delivery tracking has no rows: the update matches
// nothing and the old counters carry on. Never throws - tracking must not fail a send.
const recordRecipient = async (broadcastId, whatsappNumber, fields) => {
  try {
    const { error } = await supabase.from('broadcast_recipients').update(fields)
      .eq('broadcast_id', broadcastId).eq('whatsapp_number', whatsappNumber).eq('status', 'queued');
    if (error) logger.error(`Broadcast ${broadcastId}: could not record the result for ${whatsappNumber}`, error);
  } catch (err) {
    logger.error(`Broadcast ${broadcastId}: could not record the result for ${whatsappNumber}`, err);
  }
};

const worker = new Worker('broadcast-outbound', async (job) => {
  const { broadcastId, businessId, phoneNumberId, encryptedAccessToken, templateName, language, components, variableMapping, ratePerMessage, billed, recipients, quickReplyComponents } = job.data;
  // Refund only what broadcast.controller.js actually debited. Jobs queued
  // before `billed` existed fall back to the billing switch (same condition
  // as the debit, since ratePerMessage > 0 is checked below).
  const debited = billed !== undefined ? billed : config.WALLET_BILLING_ENABLED;

  let sent = 0;
  let failed = 0;
  // A payment-method failure is the same for every recipient: noted once per batch.
  let paymentIssueNoted = false;

  // Per-recipient failures (e.g. a single bad number) must not fail the
  // whole job - attempts:1 on this queue means a thrown job error loses
  // progress tracking for the batch, not just a retry.
  // A media header (if any) has no per-recipient variables - it's built once in
  // broadcast.controller.js and passed through unchanged, same as the
  // non-mapped `components` path below.
  const headerComponent = (components || []).find((c) => c.type === 'header');

  for (const recipient of recipients) {
    try {
      const recipientComponents = variableMapping
        ? resolveRecipientComponents(variableMapping, recipient, headerComponent, quickReplyComponents || [])
        : components;
      const sendResult = await whatsappService.sendTemplateMessage(phoneNumberId, encryptedAccessToken, recipient.whatsappNumber, templateName, language, recipientComponents);
      sent += 1;
      await recordRecipient(broadcastId, recipient.whatsappNumber, {
        status: 'sent',
        meta_message_id: extractMetaMessageId(sendResult),
        sent_at: new Date().toISOString()
      });
    } catch (error) {
      failed += 1;
      const { errorCode, errorTitle, errorDetails } = fromSendError(error);
      await recordRecipient(broadcastId, recipient.whatsappNumber, {
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_code: errorCode,
        error_title: errorTitle,
        error_details: errorDetails
      });
      logger.error(`Broadcast ${broadcastId}: failed to send to ${recipient.whatsappNumber}`, {
        error: error.response?.data || error.message
      });
      if (!(isPaymentIssueCode(errorCode) && paymentIssueNoted)) {
        await deliverySignals.noteSendFailure({ businessId, errorCode, customerId: recipient.customerId, whatsappNumber: recipient.whatsappNumber });
      }
      if (isPaymentIssueCode(errorCode)) paymentIssueNoted = true;

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
  notifyBroadcastProgress(businessId, broadcastId);

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
