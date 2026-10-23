const { Worker } = require('bullmq');
const whatsappService = require('../services/whatsapp.service');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const config = require('../config/env');
const { workerConnection } = require('../config/queueConnection');
const { extractMetaMessageId, attachMetaMessageId } = require('../services/outboundMessageId.service');
const { fromSendError } = require('../utils/whatsappErrors');
const usageService = require('../services/usage.service');

// Must match the prefix used by whatsapp.queue.js - see comment there.
const prefix = `apnabot:${config.QUEUE_NAMESPACE}`;

// A carousel reply (webhook.controller.js, content_type 'carousel'). carouselNative = the cards are
// eligible for Meta's native carousel; otherwise (no photos, fewer than 2 with photos, uneven buttons)
// or when Meta REJECTS the carousel with a 4xx, the sequential fallback goes out instead: the body, then
// one message per card - its image if it has one, its text and its quick-reply buttons - so every
// button still routes. A rejection is not retried (it would fail the same way). A 5xx / network error on
// the FIRST send (the native carousel, or the body when there was no native attempt) throws so the queue
// retries as usual; once the fallback's body has gone out, a failing card message is logged at warn and
// the remaining cards still go - throwing would retry the whole sequence and send the body twice.
// Returns the first message's send result (the row's wamid).
const sendCarouselReply = async ({ phoneNumberId, encryptedAccessToken, to, message, carouselCards, carouselNative, businessId }) => {
  if (carouselNative) {
    try {
      return await whatsappService.sendCarouselMessage(phoneNumberId, encryptedAccessToken, to, message, carouselCards);
    } catch (error) {
      const status = error.response?.status;
      if (!(status >= 400 && status < 500 && status !== 429)) throw error;
      logger.info('Meta rejected a carousel, sending the sequential fallback', {
        businessId, status, error: error.response?.data?.error?.message || error.message
      });
    }
  }

  const first = await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, message);
  for (const card of carouselCards) {
    const text = card.text || message;
    try {
      if (Array.isArray(card.buttons) && card.buttons.length > 0) {
        await whatsappService.sendInteractiveButtons(phoneNumberId, encryptedAccessToken, to, text, card.buttons, card.mediaType === 'image' ? card.mediaUrl : null);
      } else if (card.mediaType === 'image' && card.mediaUrl) {
        await whatsappService.sendImageMessage(phoneNumberId, encryptedAccessToken, to, card.mediaUrl, card.text || undefined);
      } else if (card.text) {
        await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, card.text);
      }
    } catch (error) {
      logger.warn('Carousel fallback: a card message failed, continuing with the rest', {
        businessId, cardIndex: card.index, status: error.response?.status || null, error: error.response?.data?.error?.message || error.message
      });
    }
  }
  return first;
};

const worker = new Worker('whatsapp-outbound', async (job) => {
  const { businessId, phoneNumberId, encryptedAccessToken, to, message, messageId,
          type = 'text', imageUrl = null, videoUrl = null, buttons = [], listOptions = [],
          interactiveButtons = null, interactiveList = null, listButtonLabel = 'Choose',
          step = null, location = null, locationRequest = false, ctaButton = null,
          carouselCards = null, carouselNative = false, countAs = 1 } = job.data;

  // Meta's send response ({ messages: [{ id }] }), whichever branch sends.
  let sendResult = null;

  try {
    if (type === 'carousel' && Array.isArray(carouselCards) && carouselCards.length > 0) {
      sendResult = await sendCarouselReply({ phoneNumberId, encryptedAccessToken, to, message, carouselCards, carouselNative, businessId });
    } else if (location) {
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
      sendResult = await whatsappService.sendRuleListMessage(phoneNumberId, encryptedAccessToken, to, message, listButtonLabel, listOptions, imageUrl);
    } else if (type === 'video' && videoUrl) {
      // A reply node's video (webhook.controller.js sendReplyExtraMedia), sent on its own before the reply.
      sendResult = await whatsappService.sendVideoMessage(phoneNumberId, encryptedAccessToken, to, videoUrl, message);
    } else if (imageUrl) {
      sendResult = await whatsappService.sendImageMessage(phoneNumberId, encryptedAccessToken, to, imageUrl, message);
    } else {
      sendResult = await whatsappService.sendTextMessage(phoneNumberId, encryptedAccessToken, to, message);
    }

    // The one place queued sends are counted against the plan: one unit per job (job.countAs, default 1; 0 for
    // the photos of a catalogue page, whose closing message counts the page), however many
    // WhatsApp messages a carousel fallback makes. Only after Meta accepted it, so a failed or
    // retried job is never counted. Not awaited and never throws: counting must not slow or fail a send.
    if (countAs > 0) usageService.recordOutbound(businessId, { count: countAs });

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
