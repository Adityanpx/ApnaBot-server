// What a failed or delivered WhatsApp message tells us about the business's
// account and about the customer. One entry point for every place a send can
// fail - the status webhook, the broadcast worker, windowAwareSend - so they all
// react the same way. Never throws: a signal must not fail the send or the
// webhook it rides on.
//   131042  the business's WhatsApp payment method has a problem -> accountHealth
//   131050  the customer stopped marketing messages               -> marketingBlock
const accountHealth = require('./accountHealth.service');
const marketingBlock = require('./marketingBlock.service');
const logger = require('../utils/logger');

/**
 * A send failed with `errorCode` (Meta's, from fromSendError / fromStatusErrors).
 * `customerId` or `whatsappNumber` says who it was sent to (needed for 131050).
 * @param {{ businessId: string, errorCode: number|null, customerId?: string|null, whatsappNumber?: string|null, at?: string|Date }} failure
 */
const noteSendFailure = async ({ businessId, errorCode, customerId = null, whatsappNumber = null, at }) => {
  try {
    if (accountHealth.isPaymentIssueCode(errorCode)) {
      await accountHealth.recordPaymentIssue(businessId, at);
    } else if (marketingBlock.isMarketingStoppedCode(errorCode)) {
      await marketingBlock.blockMarketing({ businessId, customerId, whatsappNumber, at });
    }
  } catch (err) {
    logger.error('Error handling a send-failure signal:', err);
  }
};

/**
 * The rows apply_message_statuses reports as changed. A failed row carries its
 * business, the customer and Meta's code; a broadcast recipient that was
 * delivered or read proves payment worked as of when it was sent.
 * @param {Object[]} changed             chat messages that moved
 * @param {Object[]} changedRecipients   broadcast_recipients that moved
 */
const noteStatusChanges = async (changed, changedRecipients) => {
  try {
    for (const row of [...(changed || []), ...(changedRecipients || [])]) {
      if (row.status === 'failed') {
        await noteSendFailure({
          businessId: row.business_id,
          errorCode: row.error_code,
          customerId: row.customer_id || null,
          whatsappNumber: row.whatsapp_number || row.customer_number || null,
          at: row.failed_at || undefined
        });
      }
    }

    // Latest delivered send per business: any one that began after the problem clears it.
    const latestDelivered = new Map();
    for (const rec of changedRecipients || []) {
      if ((rec.status !== 'delivered' && rec.status !== 'read') || !rec.sent_at) continue;
      const sentMs = new Date(rec.sent_at).getTime();
      if (!(latestDelivered.get(rec.business_id) >= sentMs)) latestDelivered.set(rec.business_id, sentMs);
    }
    for (const [businessId, sentMs] of latestDelivered) {
      await accountHealth.clearPaymentIssueIfSentAfter(businessId, new Date(sentMs));
    }
  } catch (err) {
    logger.error('Error handling status-change signals:', err);
  }
};

module.exports = { noteSendFailure, noteStatusChanges };
