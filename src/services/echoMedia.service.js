// Copies the media of a phone-app echo (smb_message_echoes) from Meta to R2 so
// the dashboard can show it, the same way storeInboundImage does for customer
// photos. Fire-and-forget after the echo row is saved: never delays the webhook,
// and any failure leaves the row with its text label (e.g. "📷 Photo").
// Not counted against the business's media-library storage (storage_used_bytes).

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const whatsappService = require('./whatsapp.service');
const r2 = require('./r2.service');
const socketService = require('./socket.service');

const MB = 1024 * 1024;

// Per message type: what is stored and the size cap. Anything else keeps the label.
const MEDIA_RULES = {
  image: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 10 * MB },
  video: { mimeTypes: ['video/mp4'], maxBytes: 16 * MB },
  document: { mimeTypes: ['application/pdf'], maxBytes: 10 * MB }
};

/** Media id of an echo entry for a storable type, else null. */
const echoMediaOf = (echo) => {
  const rule = echo && MEDIA_RULES[echo.type];
  const media = rule && echo[echo.type];
  if (!media || !media.id) return null;
  return { type: echo.type, id: media.id, mimeType: media.mime_type || null };
};

/**
 * @param {Object} tenant - resolved tenant (businessId, accessToken)
 * @param {Object} row - the saved snake_case messages row
 * @param {{type:string, id:string, mimeType:string|null}} media - from echoMediaOf
 * @returns {Promise<string|null>} the stored media_url, or null when not stored
 */
const storeEchoMedia = async (tenant, row, media) => {
  try {
    const rule = MEDIA_RULES[media.type];
    // The payload's own mime type lets an unsupported file skip the download.
    if (media.mimeType && !rule.mimeTypes.includes(media.mimeType.split(';')[0].trim())) {
      logger.info(`Echo media ${row.id} has type ${media.mimeType} — not stored`);
      return null;
    }
    const { buffer, mimeType } = await whatsappService.downloadMedia(media.id, tenant.accessToken, rule.maxBytes);
    if (!rule.mimeTypes.includes(mimeType)) {
      logger.info(`Echo media ${row.id} has type ${mimeType} — not stored`);
      return null;
    }
    if (buffer.length > rule.maxBytes) {
      logger.info(`Echo media ${row.id} is ${buffer.length} bytes, over the ${rule.maxBytes} limit — not stored`);
      return null;
    }
    const { url } = await r2.uploadImage(buffer, `echo-media/${tenant.businessId}`, row.id, mimeType);
    const { error } = await supabase.from('messages').update({ media_url: url }).eq('id', row.id);
    if (error) throw error;
    try {
      socketService.emitToBusiness(tenant.businessId.toString(), 'message_media', {
        messageId: row.id,
        customerId: row.customer_id,
        mediaUrl: url
      });
    } catch (socketError) {
      logger.error('Error emitting message_media socket event:', socketError);
    }
    return url;
  } catch (error) {
    // Includes Meta's oversize refusal from downloadMedia and an expired media id.
    logger.error('Error storing echo media', {
      businessId: tenant.businessId,
      messageId: row.id,
      message: error.response?.data || error.message
    });
    return null;
  }
};

module.exports = { MEDIA_RULES, echoMediaOf, storeEchoMedia };
