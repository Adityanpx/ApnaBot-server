// One automated message to one customer, the way WhatsApp allows it:
// plain text while the customer's 24-hour window is open (free), else an
// approved template (charged to the wallet like a broadcast, refunded if
// WhatsApp refuses it), else not at all — the caller gets a code saying why.
//
// Shared by Free demo messages (demoReminder.service.js) and follow-up
// automations. Deliberately does NOT check opted_in / opted_out_at /
// bot_paused_until: whether a message may go out at all is the caller's rule
// (a demo confirmation the parent asked for differs from a marketing nudge).
const supabase = require('../config/supabase');
const config = require('../config/env');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const walletService = require('./wallet.service');
const rateCardService = require('./rateCard.service');
const whatsappService = require('./whatsapp.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { toCamelCase } = require('../utils/caseConvert');
const { isTemplateUsable } = require('../utils/templateStatus');
const logger = require('../utils/logger');

const FREE_FORM_WINDOW_MS = 24 * 60 * 60 * 1000; // same as message.controller.js

const isConnected = (business) => !!(business.isWhatsappConnected && business.phoneNumberId);

/** Whether the customer's 24-hour window (free-form text allowed) is open at `nowMs`. */
const isWindowOpen = (customerRow, nowMs = Date.now()) => !!(customerRow.last_message_at &&
  nowMs < new Date(customerRow.last_message_at).getTime() + FREE_FORM_WINDOW_MS);

/** Records a bot message in the chat and pushes it to the dashboard. */
const recordOutbound = async (business, customerRow, text, status) => {
  const { data: messageRow, error } = await supabase.from('messages').insert({
    business_id: business.id,
    customer_id: customerRow.id,
    customer_number: customerRow.whatsapp_number,
    direction: 'outbound',
    type: 'text',
    content: text,
    status,
    sender_type: 'bot',
    is_read: true
  }).select().single();
  if (error) throw error;
  const message = toCamelCase(messageRow);
  try {
    socketService.emitToBusiness(business.id.toString(), 'new_message', {
      customer: toCamelCase(customerRow), message, customerNumber: customerRow.whatsapp_number
    });
  } catch (socketError) {
    logger.error('Error emitting new_message socket event:', socketError);
  }
  return message;
};

/**
 * @param {Object} business        camelCase business (businessService.getBusinessById)
 * @param {Object} customerRow     snake_case customers row
 * @param {Object} opts
 * @param {(languageCode: string|null) => string} opts.textFor  free-form text in the customer's language
 * @param {Object|null|(() => Promise<Object|null>)} opts.template
 *   message_templates row (sent only when status 'approved' and send_support 'ok'), or a loader
 *   called only when the window is closed
 * @param {string[]} opts.templateParams     body {{1}}..{{n}} values
 * @param {string} opts.templateText         the template as it reads in the chat
 * @param {{ referenceId: string, notes: string, refundNotes: string }} opts.billing  wallet transaction details
 * @param {string} [opts.bookingId]          only for log context (messages has no booking column)
 * @returns {Promise<{ sent: 'text'|'template', messageId: string, costPaise: number } | { sent: false, code: 'not_connected'|'blocked'|'no_template'|'low_balance'|'rejected' }>}
 */
const sendWindowAwareMessage = async (business, customerRow, { textFor, template, templateParams, templateText, billing, bookingId = null }) => {
  if (!isConnected(business)) return { sent: false, code: 'not_connected' };
  if (customerRow.is_blocked) return { sent: false, code: 'blocked' };

  if (isWindowOpen(customerRow)) {
    const text = textFor(customerRow.preferred_language || null);
    const message = await recordOutbound(business, customerRow, text, 'sent');
    await addToWhatsappQueue({
      businessId: business.id,
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: customerRow.whatsapp_number,
      message: text,
      type: 'text',
      messageId: message.id
    });
    usageService.incrementUsage(business.id, 'outbound').catch(err => logger.error('Error incrementing outbound usage:', err));
    return { sent: 'text', messageId: message.id, costPaise: 0 };
  }

  // Loaded only now (when given as a loader) so a window-open send never
  // depends on the template lookup.
  const templateRow = typeof template === 'function' ? await template() : template;
  if (!isTemplateUsable(templateRow)) return { sent: false, code: 'no_template' };

  const ratePaise = config.WALLET_BILLING_ENABLED
    ? await rateCardService.getRateForMessage('IN', templateRow.category.toLowerCase())
    : 0;
  if (ratePaise > 0) {
    try {
      await walletService.debitWallet(business.id, ratePaise, billing.referenceId, billing.notes);
    } catch (debitErr) {
      if (debitErr.message && debitErr.message.includes('Insufficient wallet balance')) {
        return { sent: false, code: 'low_balance' };
      }
      throw debitErr;
    }
  }

  try {
    await whatsappService.sendTemplateMessage(
      business.phoneNumberId, business.accessToken, customerRow.whatsapp_number, templateRow.name, templateRow.language,
      // No body component for a template without variables (as broadcast.worker.js).
      templateParams.length > 0 ? [{ type: 'body', parameters: templateParams.map(t => ({ type: 'text', text: t })) }] : []
    );
  } catch {
    if (ratePaise > 0) {
      await walletService.refundToWallet(business.id, ratePaise, billing.referenceId, billing.refundNotes)
        .catch(err => logger.error('Window-aware send: refund failed', { businessId: business.id, bookingId, error: err.message }));
    }
    return { sent: false, code: 'rejected' };
  }
  const message = await recordOutbound(business, customerRow, templateText, 'sent');
  usageService.incrementUsage(business.id, 'outbound').catch(err => logger.error('Error incrementing outbound usage:', err));
  return { sent: 'template', messageId: message.id, costPaise: ratePaise };
};

module.exports = {
  FREE_FORM_WINDOW_MS,
  isConnected,
  isWindowOpen,
  recordOutbound,
  sendWindowAwareMessage
};
