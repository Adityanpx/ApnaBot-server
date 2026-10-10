// Marketing consent asked ONCE per customer, right after a booking
// confirmation (graph booking, immediate confirm, web form). Gate: the
// business's ask_consent_after_booking setting (default off). The question
// reuses the opt-in link Yes/No buttons with the ids optin_yes:booking /
// optin_no:booking (utils/optInLink.js) — taps handled in
// webhook.controller.js Step 11.7 via handleBookingConsentTap below.
//
// "Ask once" = customers.consent_prompted_at, set by an atomic claim
// (update ... where consent_prompted_at is null). Nothing here ever throws
// into the booking path: a failed claim just means no question.

const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('./business.service');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { getSystemMessage } = require('../utils/systemMessages');
const { buildInteractivePayload } = require('../utils/interactivePayload');
const { BOOKING_CONSENT_YES_ID, BOOKING_CONSENT_NO_ID } = require('../utils/optInLink');
const logger = require('../utils/logger');

/**
 * Whether this customer may be asked: never asked before, not opted in, never
 * sent STOP, not blocked, bot not paused. Pure. Raw (snake_case) customers row.
 */
const isEligible = (row, nowMs = Date.now()) => {
  if (!row) return false;
  if (row.consent_prompted_at) return false;
  if (row.opted_in === true) return false;
  if (row.opted_out_at) return false;
  if (row.is_blocked) return false;
  if (row.bot_paused_until && new Date(row.bot_paused_until).getTime() > nowMs) return false;
  return true;
};

/**
 * Claim the one-time question for a customer whose booking was just confirmed.
 * Returns the updated camelCase customer when this call claimed it (the
 * caller must then send the question), else null — setting off, not eligible,
 * window closed, lost a race, or any error (logged, never thrown).
 * @param {Object} args
 * @param {string} args.businessId
 * @param {string} args.customerNumber
 * @param {(row: Object) => boolean} [args.windowCheck] - e.g. windowAwareSend's
 *   isWindowOpen, for callers outside the customer's own message (web form)
 */
const claimAfterBooking = async ({ businessId, customerNumber, windowCheck = null }) => {
  try {
    // Uncached on purpose: a toggle must apply to the very next booking.
    const business = await businessService.getBusinessById(businessId);
    if (!business?.askConsentAfterBooking) return null;

    const { data: row, error } = await supabase
      .from('customers').select('*').eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
    if (error) throw error;
    if (!isEligible(row)) return null;
    if (windowCheck && !windowCheck(row)) return null;

    const { data: claimed, error: claimError } = await supabase
      .from('customers').update({ consent_prompted_at: new Date().toISOString() })
      .eq('id', row.id).is('consent_prompted_at', null)
      .eq('opted_in', false).is('opted_out_at', null).eq('is_blocked', false)
      .select();
    if (claimError) throw claimError;
    return claimed && claimed.length > 0 ? toCamelCase(claimed[0]) : null;
  } catch (err) {
    logger.error('Error claiming post-booking consent question, skipping it:', err);
    return null;
  }
};

/**
 * Send the Yes/No question. Not awaited-to-completion: it goes out after the
 * confirmation, which the caller has already sent in order.
 * @param {Object} args
 * @param {string} args.businessId
 * @param {string} args.phoneNumberId
 * @param {string} args.encryptedAccessToken
 * @param {string} args.businessName
 * @param {Object} args.customer - camelCase customer row
 * @param {string} args.customerNumber
 */
const sendQuestion = async ({ businessId, phoneNumberId, encryptedAccessToken, businessName, customer, customerNumber }) => {
  const languageCode = customer.preferredLanguage;
  const text = getSystemMessage('bookingConsentQuestion', languageCode, { business: businessName });
  const buttons = [
    { title: getSystemMessage('optInYesButton', languageCode), nextKeyword: BOOKING_CONSENT_YES_ID },
    { title: getSystemMessage('optInNoButton', languageCode), nextKeyword: BOOKING_CONSENT_NO_ID }
  ];

  const { data: messageRow, error } = await supabase.from('messages').insert({
    business_id: businessId,
    customer_id: customer.id,
    customer_number: customerNumber,
    direction: 'outbound',
    type: 'text',
    content: text,
    status: 'sent',
    sender_type: 'bot',
    interactive_payload: buildInteractivePayload({ message: text, buttons }),
    is_read: true
  }).select().single();
  if (error) throw error;
  const message = toCamelCase(messageRow);

  await addToWhatsappQueue({
    businessId,
    phoneNumberId,
    encryptedAccessToken,
    to: customerNumber,
    message: text,
    type: 'text',
    buttons,
    messageId: message.id
  });
  usageService.incrementUsage(businessId, 'outbound').catch(err =>
    logger.error('Error incrementing outbound usage:', err)
  );
  try {
    socketService.emitToBusiness(businessId.toString(), 'new_message', { customer, message, customerNumber });
  } catch (socketError) {
    logger.error('Error emitting socket event:', socketError);
  }
};

/**
 * A tap on the post-booking question. The answer is recorded once (a repeat
 * tap on the same buttons is ignored). A "Yes" opts the customer in only if
 * they have not sent STOP since the question went out — opted_out_at is never
 * cleared here — and are not already opted in.
 * @param {Object} customer - camelCase customer row
 * @param {{ answer: 'yes'|'no' }} tap - utils/optInLink.js#parseOptInTapId
 * @returns {Promise<{ answered: boolean, newlyOptedIn: boolean, customer: Object }>}
 *   answered = false for a repeat tap; customer = updated row when written
 */
const handleBookingConsentTap = async (customer, tap) => {
  const { data: recorded, error } = await supabase
    .from('customers').update({ consent_prompt_result: tap.answer })
    .eq('id', customer.id).is('consent_prompt_result', null).select();
  if (error) throw error;
  if (!recorded || recorded.length === 0) return { answered: false, newlyOptedIn: false, customer };
  if (tap.answer !== 'yes') return { answered: true, newlyOptedIn: false, customer: toCamelCase(recorded[0]) };

  const { data: optedIn, error: optInError } = await supabase
    .from('customers').update({
      opted_in: true,
      opted_in_at: new Date().toISOString(),
      opt_in_source: 'booking_prompt',
      opt_in_link_id: null
    })
    .eq('id', customer.id).eq('opted_in', false).is('opted_out_at', null).select();
  if (optInError) throw optInError;
  if (!optedIn || optedIn.length === 0) return { answered: true, newlyOptedIn: false, customer: toCamelCase(recorded[0]) };
  return { answered: true, newlyOptedIn: true, customer: toCamelCase(optedIn[0]) };
};

module.exports = { isEligible, claimAfterBooking, sendQuestion, handleBookingConsentTap };
