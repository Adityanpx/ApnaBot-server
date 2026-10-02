// Free demo time + reminder (coaching, bookings.form_key = 'demo').
//
//   setDemoTime     owner fixes the demo (PUT /api/bookings/:id/demo-time):
//                   saves scheduled_for, marks the request "Demo fixed"
//                   (confirmed), tells the parent and plans the reminder
//   runReminder     demoReminder.worker.js, at the planned time
//
// Messages go as plain text while the parent's 24-hour window is open (free),
// else as the approved template (charged to the wallet like a broadcast),
// else not at all — the booking's reminder_note says why.
const supabase = require('../config/supabase');
const config = require('../config/env');
const businessService = require('./business.service');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const walletService = require('./wallet.service');
const rateCardService = require('./rateCard.service');
const customerPipelineService = require('./customerPipeline.service');
const whatsappService = require('./whatsapp.service');
const { getReminderTemplate } = require('./demoReminderTemplate.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { scheduleDemoReminder, removeDemoReminder } = require('../queues/demoReminder.queue');
const { demoReminderFor } = require('../utils/coachingBotSettings');
const {
  MAX_DAYS_AHEAD, reminderAt, demoDetails,
  confirmationText, reminderText, templateParams, templateText
} = require('../utils/demoReminder');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const FREE_FORM_WINDOW_MS = 24 * 60 * 60 * 1000; // same as message.controller.js
const MIN_REMINDER_LEAD_MS = 60 * 1000;
const OPEN_STATUSES = ['pending', 'confirmed'];

const loadPublishedReminder = async (businessId) => {
  const { data, error } = await supabase
    .from('business_bot_settings').select('published_at, published_settings').eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data && data.published_at ? demoReminderFor(data.published_settings && data.published_settings.settings) : null;
};

/** Records a bot message in the chat and pushes it to the dashboard. */
const recordOutbound = async (business, booking, customerRow, text, status) => {
  const { data: messageRow, error } = await supabase.from('messages').insert({
    business_id: business.id,
    customer_id: booking.customer_id,
    customer_number: booking.customer_number,
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
      customer: toCamelCase(customerRow), message, customerNumber: booking.customer_number
    });
  } catch (socketError) {
    logger.error('Error emitting new_message socket event:', socketError);
  }
  return message;
};

/**
 * Sends textFor(parent's language) to the parent: free-form inside the
 * 24-hour window, else the approved reminder template (English;
 * wallet-charged when billing is on).
 * @param {(languageCode: string|null) => string} textFor
 * @returns {Promise<{ sent: 'text'|'template' } | { sent: false, reason: string }>}
 */
const sendToParent = async (business, booking, details, textFor) => {
  if (!business.isWhatsappConnected || !business.phoneNumberId) return { sent: false, reason: 'WhatsApp is not connected.' };

  const { data: customerRow, error: customerErr } = await supabase
    .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
  if (customerErr) throw customerErr;
  if (!customerRow) return { sent: false, reason: 'Parent not found.' };
  if (customerRow.is_blocked) return { sent: false, reason: 'This parent is blocked.' };

  const windowOpen = customerRow.last_message_at &&
    Date.now() < new Date(customerRow.last_message_at).getTime() + FREE_FORM_WINDOW_MS;

  if (windowOpen) {
    const text = textFor(customerRow.preferred_language || null);
    const message = await recordOutbound(business, booking, customerRow, text, 'sent');
    await addToWhatsappQueue({
      businessId: business.id,
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: booking.customer_number,
      message: text,
      type: 'text',
      messageId: message.id
    });
    usageService.incrementUsage(business.id, 'outbound').catch(err => logger.error('Error incrementing outbound usage:', err));
    return { sent: 'text' };
  }

  const template = await getReminderTemplate(business.id);
  if (!template || template.status !== 'approved') {
    return {
      sent: false,
      reason: "The parent hasn't messaged in the last 24 hours, and WhatsApp hasn't approved the reminder message yet."
    };
  }

  const ratePaise = config.WALLET_BILLING_ENABLED
    ? await rateCardService.getRateForMessage('IN', template.category.toLowerCase())
    : 0;
  if (ratePaise > 0) {
    try {
      await walletService.debitWallet(business.id, ratePaise, booking.id, `Demo message for booking ${booking.booking_code}`);
    } catch (debitErr) {
      if (debitErr.message && debitErr.message.includes('Insufficient wallet balance')) {
        return { sent: false, reason: 'Wallet balance is too low to send the reminder message.' };
      }
      throw debitErr;
    }
  }

  try {
    await whatsappService.sendTemplateMessage(
      business.phoneNumberId, business.accessToken, booking.customer_number, template.name, template.language,
      [{ type: 'body', parameters: templateParams(details).map(t => ({ type: 'text', text: t })) }]
    );
  } catch (sendErr) {
    if (ratePaise > 0) {
      await walletService.refundToWallet(business.id, ratePaise, booking.id, `Refund: demo message for booking ${booking.booking_code} not sent`)
        .catch(err => logger.error('Demo reminder: refund failed', err));
    }
    return { sent: false, reason: 'WhatsApp did not accept the message.' };
  }
  await recordOutbound(business, booking, customerRow, templateText(details), 'sent');
  usageService.incrementUsage(business.id, 'outbound').catch(err => logger.error('Error incrementing outbound usage:', err));
  return { sent: 'template' };
};

/**
 * Owner fixes a Free demo's date/time.
 * @returns {Promise<{ status, error } | { booking, confirmation, reminder }>}
 *   confirmation: { sent, reason? }; reminder: { at } | { off: true } | { tooLate: true }
 */
const setDemoTime = async (businessId, bookingId, scheduledFor) => {
  const demoAt = new Date(scheduledFor);
  if (typeof scheduledFor !== 'string' || Number.isNaN(demoAt.getTime())) {
    return { status: 400, error: 'scheduledFor must be a date and time' };
  }
  if (demoAt.getTime() <= Date.now()) return { status: 400, error: 'Pick a time in the future' };
  if (demoAt.getTime() > Date.now() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
    return { status: 400, error: `Pick a time within the next ${MAX_DAYS_AHEAD} days` };
  }

  const { data: booking, error: findErr } = await supabase
    .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
  if (findErr) throw findErr;
  if (!booking) return { status: 404, error: 'Booking not found' };
  if (booking.form_key !== 'demo') return { status: 400, error: 'A demo time can only be set on a Free demo request' };
  if (!OPEN_STATUSES.includes(booking.status)) return { status: 400, error: 'This request is closed — reopen it first' };

  const choice = await loadPublishedReminder(businessId);
  const at = choice ? reminderAt(demoAt, choice) : null;
  const willRemind = !!at && at.getTime() > Date.now() + MIN_REMINDER_LEAD_MS;

  const { data: updatedRow, error: updateErr } = await supabase.from('bookings').update({
    scheduled_for: demoAt.toISOString(),
    status: 'confirmed',
    reminder_status: willRemind ? 'scheduled' : null,
    reminder_note: null
  }).eq('id', booking.id).select().single();
  if (updateErr) throw updateErr;

  // A demo moving to "Demo fixed" counts like any other confirmation
  // (booking.controller.js#updateBookingStatus).
  if (booking.status !== 'confirmed') {
    await customerPipelineService.advancePipelineStage(booking.customer_id, 'converted');
  }

  try {
    if (willRemind) {
      await scheduleDemoReminder({ bookingId: booking.id, businessId, scheduledFor: demoAt.toISOString() }, at);
    } else {
      await removeDemoReminder(booking.id);
    }
  } catch (queueErr) {
    logger.error('Demo reminder: could not plan the reminder', { bookingId: booking.id, error: queueErr.message });
    await supabase.from('bookings').update({ reminder_status: 'failed', reminder_note: 'The reminder could not be planned.' }).eq('id', booking.id);
    updatedRow.reminder_status = 'failed';
    updatedRow.reminder_note = 'The reminder could not be planned.';
  }

  let confirmation;
  try {
    const business = await businessService.getBusinessById(businessId);
    const details = demoDetails(booking, business.displayName || business.name, demoAt);
    confirmation = await sendToParent(business, booking, details, (lang) => confirmationText(details, lang));
  } catch (sendErr) {
    // The time is saved — a failed WhatsApp send is reported, not an error.
    logger.error('Demo time: confirmation not sent', { bookingId: booking.id, error: sendErr.message });
    confirmation = { sent: false, reason: 'The message could not be sent.' };
  }

  try {
    socketService.emitToBusiness(businessId, 'booking_updated', { bookingId: booking.id, status: 'confirmed' });
  } catch (socketError) {
    logger.error('Error emitting socket event:', socketError);
  }

  return {
    booking: toCamelCase(updatedRow),
    confirmation,
    reminder: willRemind ? { at: at.toISOString() } : (choice ? { tooLate: true } : { off: true })
  };
};

const setReminderOutcome = async (bookingId, status, note) => {
  const { error } = await supabase.from('bookings').update({ reminder_status: status, reminder_note: note || null }).eq('id', bookingId);
  if (error) logger.error('Demo reminder: could not save outcome', { bookingId, error: error.message });
};

/**
 * Worker job. Re-checks everything, so a stale job (time changed, request
 * closed, reminder switched off) does nothing.
 */
const runReminder = async ({ bookingId, businessId, scheduledFor }) => {
  const { data: booking, error } = await supabase
    .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!booking || !booking.scheduled_for) return 'gone';
  if (new Date(booking.scheduled_for).getTime() !== new Date(scheduledFor).getTime()) return 'stale';
  if (!OPEN_STATUSES.includes(booking.status)) {
    await setReminderOutcome(bookingId, 'skipped', 'The request was closed.');
    return 'closed';
  }
  if (new Date(scheduledFor).getTime() <= Date.now()) {
    await setReminderOutcome(bookingId, 'skipped', 'The demo time had already passed.');
    return 'past';
  }
  if (!(await loadPublishedReminder(businessId))) {
    await setReminderOutcome(bookingId, 'skipped', 'Reminders were switched off.');
    return 'off';
  }

  const business = await businessService.getBusinessById(businessId);
  if (!business) return 'gone';
  const details = demoDetails(booking, business.displayName || business.name, scheduledFor);
  let result;
  try {
    result = await sendToParent(business, booking, details, (lang) => reminderText(details, lang));
  } catch (sendErr) {
    logger.error('Demo reminder: send failed', { bookingId, error: sendErr.message });
    await setReminderOutcome(bookingId, 'failed', 'The reminder could not be sent.');
    return 'failed';
  }
  await setReminderOutcome(bookingId, result.sent ? 'sent' : 'skipped', result.sent ? null : result.reason);
  return result.sent ? 'sent' : 'skipped';
};

module.exports = {
  setDemoTime,
  runReminder
};
