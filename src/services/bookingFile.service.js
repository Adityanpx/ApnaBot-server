// Files a customer sends as the answer to a booking 'file' question (photo, PDF, spreadsheet, Word
// document). Downloaded from Meta, stored in R2 under booking-files/<businessId>/ and counted in the
// business's media storage (businesses.storage_used_bytes, the same limit as the media library). The
// booking_files row ties the file to the booking once it exists; storage cleanup treats a file whose
// booking is gone (or never got created) as an orphan.
//
// Never throws: webhook.controller.js re-asks the question on any non-'stored' result.
const crypto = require('crypto');
const supabase = require('../config/supabase');
const whatsappService = require('./whatsapp.service');
const r2 = require('./r2.service');
const { getActiveSubscription } = require('./subscription.service');
const { MAX_FILE_BYTES, resolveStorableFile } = require('../utils/inboundFiles');
const logger = require('../utils/logger');

const FOLDER_PREFIX = 'booking-files';

/**
 * @param {Object} args
 * @param {{businessId: string, accessToken: string}} args.tenant - accessToken is the encrypted one
 * @param {string} args.customerId
 * @param {string} args.fieldKey - the question's field key
 * @param {{id: string, mimeType: (string|null), filename: (string|null)}} args.media - from the webhook payload
 * @returns {Promise<{status: 'stored', url: string, key: string}|{status: 'rejected', reason: 'type'|'too_large'|'storage_limit'|'failed'}>}
 */
const storeBookingFile = async ({ tenant, customerId, fieldKey, media }) => {
  const { businessId } = tenant;
  const reject = (reason) => ({ status: 'rejected', reason });
  try {
    // The payload's own type lets an unsupported file skip the download. A payload with neither a
    // mime type nor a usable filename is decided after the download.
    const declared = resolveStorableFile(media.mimeType, media.filename);
    if (!declared && (media.mimeType || media.filename)) return reject('type');

    let downloaded;
    try {
      downloaded = await whatsappService.downloadMedia(media.id, tenant.accessToken, MAX_FILE_BYTES);
    } catch (error) {
      // downloadMedia's own "over the limit" refusal, or axios' maxContentLength.
      if (/over the \d+ limit|maxContentLength/i.test(error.message || '')) return reject('too_large');
      throw error;
    }
    if (downloaded.buffer.length > MAX_FILE_BYTES) return reject('too_large');
    const file = resolveStorableFile(downloaded.mimeType, media.filename);
    if (!file) return reject('type');

    // Same limit as the media library. A business with no active plan is not blocked here: the
    // customer's booking must not fail on the owner's subscription.
    const subscription = await getActiveSubscription(businessId);
    const limitMb = subscription && subscription.plan ? subscription.plan.storage_limit_mb : null;
    if (limitMb !== null && limitMb !== undefined) {
      const { data: business, error: usedErr } = await supabase
        .from('businesses').select('storage_used_bytes').eq('id', businessId).maybeSingle();
      if (usedErr) throw usedErr;
      if (business && business.storage_used_bytes + downloaded.buffer.length > limitMb * 1024 * 1024) {
        logger.warn(`Booking file for business ${businessId} refused: media storage limit (${limitMb}MB) reached`);
        return reject('storage_limit');
      }
    }

    const publicId = crypto.randomUUID();
    const { url, key } = await r2.uploadFile(downloaded.buffer, `${FOLDER_PREFIX}/${businessId}`, publicId, file.ext, file.contentType);

    const { error: insertErr } = await supabase.from('booking_files').insert({
      business_id: businessId,
      customer_id: customerId,
      field_key: fieldKey,
      r2_key: key,
      url,
      size_bytes: downloaded.buffer.length,
      mime_type: file.contentType,
      filename: media.filename || null
    });
    if (insertErr) {
      // Written to R2 but not tracked: remove it rather than leave an uncounted object behind.
      try {
        await r2.deleteImage(key);
      } catch (cleanupErr) {
        logger.error(`Failed to clean up R2 object ${key} after booking_files insert failure:`, cleanupErr);
      }
      throw insertErr;
    }

    const { error: rpcError } = await supabase.rpc('increment_business_storage_used', {
      p_business_id: businessId,
      p_delta_bytes: downloaded.buffer.length
    });
    if (rpcError) {
      logger.error(`booking_files row stored but storage_used_bytes increment failed for business ${businessId}:`, rpcError);
    }
    return { status: 'stored', url, key };
  } catch (error) {
    logger.error('Error storing booking file', {
      businessId,
      customerId,
      fieldKey,
      message: (error.response && error.response.data) || error.message
    });
    return reject('failed');
  }
};

/**
 * Ties the files of a finished booking to it ("kept while the booking exists"). Never throws: the
 * booking is already saved, and an unlinked file is only ever removed by the orphan scan after 48 hours,
 * so the worst a failure here causes is a file that scan would later offer for removal.
 * @param {string} businessId
 * @param {string} bookingId
 * @param {string[]} urls - the stored file urls from the booking's answers
 */
const attachFilesToBooking = async (businessId, bookingId, urls) => {
  if (!urls || urls.length === 0) return;
  try {
    const { error } = await supabase.from('booking_files')
      .update({ booking_id: bookingId }).eq('business_id', businessId).in('url', urls);
    if (error) throw error;
  } catch (error) {
    logger.error(`Could not attach booking files to booking ${bookingId}:`, error);
  }
};

module.exports = { FOLDER_PREFIX, storeBookingFile, attachFilesToBooking };
