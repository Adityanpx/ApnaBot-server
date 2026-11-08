// "Tell customers when the bot pauses": when an owner / staff message switches the bot off for a customer
// (dashboard reply, reply from the WhatsApp Business app, or the owner's pause toggle), the customer gets ONE short
// notice saying so and how it resumes. Callers decide whether the bot just went active -> paused; this decides the rest.
//
//   - Off unless businesses.notify_pause_enabled (default false; true only for businesses created after it shipped).
//   - Only inside the customer's 24h window (a free-form text; no template exists for it). Never written -> skipped.
//   - At most one per customer per 24h: a guarded UPDATE on customers.pause_notice_sent_at claims the slot, so two
//     racing replies send once.
//   - Timed pause: the owner's notify_pause_text (per language) or the built-in text; it says to reply START.
//     Indefinite pause: START does not lift it, so ALWAYS the built-in text, which never mentions START (an owner's
//     custom wording could, so it is not used here).
//   - Never throws and never blocks the owner's own send: every failure is logged and swallowed. The notice is a bot
//     message (saved, queued, pushed to the inbox like the START confirmation). It never touches bot_paused_until,
//     so it cannot re-pause or loop; an echo of it is matched by wamid and ignored (coexistence.service.js).
//
// The queue, the socket and the window helper are required lazily: they live in modules that open Redis / sockets on
// load, and this file is imported by controllers and services that must stay loadable without them.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const { getSystemMessage } = require('../utils/systemMessages');
const { getLocalizedText } = require('../utils/localization');

const PAUSE_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const BUSINESS_COLUMNS = 'id, notify_pause_enabled, notify_pause_text, notify_pause_text_translations, phone_number_id, access_token, is_whatsapp_connected';

/** The text to send: timed -> owner wording (per language) or the built-in; indefinite -> always the built-in. */
const pauseNoticeText = (business, languageCode, indefinite) => {
  if (indefinite) return getSystemMessage('pauseNoticeIndefinite', languageCode);
  const custom = getLocalizedText(business, 'notifyPauseText', languageCode);
  return (typeof custom === 'string' && custom.trim()) ? custom.trim() : getSystemMessage('pauseNoticeTimed', languageCode);
};

/**
 * @param {Object} args
 * @param {string} args.businessId
 * @param {Object} [args.business]  camelCase business row if the caller already has it (else read here)
 * @param {Object} args.customer    camelCase customers row: id, whatsappNumber, lastMessageAt, preferredLanguage,
 *                                  pauseNoticeSentAt (missing = never)
 * @param {string} [args.pausedUntil] the bot_paused_until just written (the row passed in is the pre-pause read; the
 *                                  inbox push carries this instead so it never shows the customer as un-paused)
 * @param {boolean} args.indefinite the pause that was just set is the indefinite one
 * @returns {Promise<{sent:boolean, reason:string}>}
 */
const maybeSendPauseNotice = async ({ businessId, business = null, customer, pausedUntil = null, indefinite = false }) => {
  let claimedAt = null;
  try {
    let biz = business;
    if (!biz || biz.notifyPauseEnabled === undefined) {
      const { data, error } = await supabase.from('businesses').select(BUSINESS_COLUMNS).eq('id', businessId).maybeSingle();
      if (error) throw error;
      biz = data ? toCamelCase(data) : null;
    }
    if (!biz || biz.notifyPauseEnabled !== true) return { sent: false, reason: 'setting off' };
    if (!biz.isWhatsappConnected || !biz.phoneNumberId) return { sent: false, reason: 'whatsapp not connected' };

    const { isWindowOpen } = require('./windowAwareSend.service');
    if (!isWindowOpen({ last_message_at: customer.lastMessageAt })) return { sent: false, reason: 'outside the 24h window' };

    // Claim the once-per-24h slot. Only the caller whose UPDATE matches a row sends.
    claimedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - PAUSE_NOTICE_COOLDOWN_MS).toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('customers').update({ pause_notice_sent_at: claimedAt })
      .eq('id', customer.id).eq('business_id', businessId)
      .or(`pause_notice_sent_at.is.null,pause_notice_sent_at.lt.${cutoff}`)
      .select('id');
    if (claimErr) throw claimErr;
    if (!claimed || claimed.length === 0) { claimedAt = null; return { sent: false, reason: 'cooldown' }; }

    const text = pauseNoticeText(biz, customer.preferredLanguage, indefinite);
    const { data: row, error: msgErr } = await supabase.from('messages').insert({
      business_id: businessId,
      customer_id: customer.id,
      customer_number: customer.whatsappNumber,
      direction: 'outbound',
      type: 'text',
      content: text,
      status: 'sent',
      sender_type: 'bot',
      is_read: true
    }).select().single();
    if (msgErr) throw msgErr;
    const message = toCamelCase(row);

    const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
    await addToWhatsappQueue({
      businessId: String(businessId),
      phoneNumberId: biz.phoneNumberId,
      encryptedAccessToken: biz.accessToken,
      to: customer.whatsappNumber,
      message: text,
      type: 'text',
      messageId: message.id
    });
    const claimedAtForPush = claimedAt;
    claimedAt = null; // sent: the slot stays used

    try {
      const socketService = require('./socket.service');
      socketService.emitToBusiness(String(businessId), 'new_message', {
        customer: { ...customer, botPausedUntil: pausedUntil || customer.botPausedUntil, pauseNoticeSentAt: claimedAtForPush },
        message,
        customerNumber: customer.whatsappNumber
      });
    } catch (socketError) {
      logger.error('pause notice: error emitting new_message socket event:', socketError);
    }
    logger.info(`Pause notice (${indefinite ? 'indefinite' : 'timed'}) sent to ${customer.whatsappNumber} for business ${businessId}`);
    return { sent: true, reason: indefinite ? 'indefinite' : 'timed' };
  } catch (err) {
    logger.error('pause notice: failed, owner send unaffected:', err);
    if (claimedAt) {
      // Nothing went out, so give the slot back (only if it is still ours).
      try {
        await supabase.from('customers').update({ pause_notice_sent_at: customer.pauseNoticeSentAt ?? null })
          .eq('id', customer.id).eq('pause_notice_sent_at', claimedAt);
      } catch (releaseErr) {
        logger.error('pause notice: could not release the cooldown slot:', releaseErr);
      }
    }
    return { sent: false, reason: `error: ${err.message}` };
  }
};

module.exports = { maybeSendPauseNotice, pauseNoticeText, PAUSE_NOTICE_COOLDOWN_MS };
