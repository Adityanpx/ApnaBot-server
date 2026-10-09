const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');
const { extractMetaMessageId, attachMetaMessageId } = require('../services/outboundMessageId.service');
const { fromSendError } = require('../utils/whatsappErrors');

// Must match the prefix used by whatsapp.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

const worker = new Worker('whatsapp-outbound', async (job) => {
  const { businessId, phoneNumberId, encryptedAccessToken, to, message, messageId,
          type = 'text', imageUrl = null, buttons = [], listOptions = [],
          interactiveButtons = null, interactiveList = null, listButtonLabel = 'Choose',
          step = null, location = null, locationRequest = false, ctaButton = null } = job.data;

  // Meta's send response ({ messages: [{ id }] }), whichever branch sends.
  let sendResult = null;

  try {
    if (location) {
      // Business's own coordinates, sent as a map pin (see webhook.controller.js's
      // location-content-type branches). Distinct payload shape, so checked
      // before the message/imageUrl-based dispatch below.
      sendResult = await whatsappService.sendLocationMessage(phoneNumberId, encryptedAccessToken, to, location.latitude, location.longitude, location.name, location.address);
    } else if (locationRequest) {
      // Asking the CUSTOMER to share their own location (a 'location_request'
      // booking field, see sendFieldPrompt in webhook.controller.js) — the
      // opposite direction of `location` above, distinct payload shape.
      sendResult = await whatsappService.sendLocationRequest(phoneNumberId, encryptedAccessToken, to, message);
    } else if (ctaButton) {
      // web_form_trigger's booking-link send (see webhook.controller.js) —
      // a single button that opens ctaButton.url directly, instead of a
      // plain text message with the link inline.
      sendResult = await whatsappService.sendCtaUrlButton(phoneNumberId, encryptedAccessToken, to, message, ctaButton.buttonText, ctaButton.url);
    } else if (Array.isArray(interactiveList) && interactiveList.length > 0) {
      // Booking-field choice question rendered as a tappable list (Part C/D/E).
      sendResult = await whatsappService.sendListMessage(phoneNumberId, encryptedAccessToken, to, message, listButtonLabel, interactiveList, step, imageUrl);
    } else if (Array.isArray(interactiveButtons) && interactiveButtons.length > 0) {
      // Booking-field choice question rendered as reply buttons. Each id is
      // "{step}:{index}" (not just the index) so a stale tap from an earlier
      // question can't be silently misresolved against whatever booking
      // field is currently active — see webhook.controller.js's inbound
      // resolution.
      const mappedButtons = interactiveButtons.map((opt, index) => ({ title: opt, nextKeyword: `${step}:${index}` }));
      sendResult = await whatsappService.sendInteractiveButtons(phoneNumberId, encryptedAccessToken, to, message, mappedButtons, imageUrl);
    } else if (Array.isArray(buttons) && buttons.length > 0) {
      sendResult = await whatsappService.sendInteractiveButtons(phoneNumberId, encryptedAccessToken, to, message, buttons, imageUrl);
    } else if (Array.isArray(listOptions) && listOptions.length > 0) {
      sendResult = await whatsappService.sendRuleListMessage(phoneNumberId, encryptedAccessToken, to, message, 'Choose', listOptions, imageUrl);
    } else if (imageUrl) {
      sendResult = await whatsappService.sendImageMessage(phoneNumberId, encryptedAccessToken, to, imageUrl, message);
    } else {
      sendResult = await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, message);
    }

    if (messageId) {
      // Marks it sent and saves Meta's wamid in one write, so Meta's delivered / read
      // status webhooks can find the row. Never throws and never fails the job.
      await attachMetaMessageId(businessId, messageId, extractMetaMessageId(sendResult), { status: 'sent' });
    }

    logger.info(`Message sent successfully to ${to} for business ${businessId}`);
    return { success: true };
  } catch (error) {
    logger.error(`Failed to send message to ${to} for business ${businessId}:`, {
      error: error.message
    });

    if (messageId && job.attemptsMade >= 2) {
      // Keep Meta's reason (code + title) so the chat can say why it failed.
      const { errorCode, errorTitle, errorDetails } = fromSendError(error);
      const { error: updateErr } = await supabase.from('messages').update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_code: errorCode,
        error_title: errorTitle,
        error_details: errorDetails
      }).eq('id', messageId);
      if (updateErr) logger.error('Error marking message failed:', updateErr);
    }

    throw error;
  }
}, {
  connection: workerConnection,
  prefix,
  concurrency: 5
});

worker.on('completed', (job) => {
  logger.info(`Job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  logger.error(`Job failed: ${job.id} - ${err.message}`);
});

worker.on('error', (err) => {
  logger.error(`Worker error: ${err.message}`);
});

module.exports = worker;
