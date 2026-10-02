// Free demo time + reminder (coaching, bookings.form_key = 'demo').
//
//   setDemoTime     owner fixes the demo (PUT /api/bookings/:id/demo-time):
//                   saves scheduled_for, marks the request "Demo fixed"
//                   (confirmed), tells the parent and plans the reminder
//   runReminder     demoReminder.worker.js, at the planned time
//
// Messages go as plain text while the parent's 24-hour window is open (free),
// else as the approved template (charged to the wallet like a broadcast),
// else not at all — the booking's reminder_note says why
// (windowAwareSend.service.js does the sending).
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const socketService = require('./socket.service');
const customerPipelineService = require('./customerPipeline.service');
const { getReminderTemplate } = require('./demoReminderTemplate.service');
const { isConnected, sendWindowAwareMessage } = require('./windowAwareSend.service');
const { scheduleDemoReminder, removeDemoReminder } = require('../queues/demoReminder.queue');
const { demoReminderFor } = require('../utils/coachingBotSettings');
const {
  MAX_DAYS_AHEAD, reminderAt, demoDetails,
  confirmationText, reminderText, templateParams, templateText
} = require('../utils/demoReminder');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const MIN_REMINDER_LEAD_MS = 60 * 1000;
const OPEN_STATUSES = ['pending', 'confirmed'];

const loadPublishedReminder = async (businessId) => {
  const { data, error } = await supabase
    .from('business_bot_settings').select('published_at, published_settings').eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data && data.published_at ? demoReminderFor(data.published_settings && data.published_settings.settings) : null;
};

// What the parent is told when nothing was sent (bookings.reminder_note /
// the setDemoTime response), per windowAwareSend.service.js code.
const NOT_SENT_REASONS = {
  not_connected: 'WhatsApp is not connected.',
  blocked: 'This parent is blocked.',
  no_template: "The parent hasn't messaged in the last 24 hours, and WhatsApp hasn't approved the reminder message yet.",
  low_balance: 'Wallet balance is too low to send the reminder message.',
  rejected: 'WhatsApp did not accept the message.'
};

/**
 * Sends textFor(parent's language) to the parent: free-form inside the
 * 24-hour window, else the approved reminder template (English;
 * wallet-charged when billing is on).
 * @param {(languageCode: string|null) => string} textFor
 * @returns {Promise<{ sent: 'text'|'template' } | { sent: false, reason: string }>}
 */
const sendToParent = async (business, booking, details, textFor) => {
  if (!isConnected(business)) return { sent: false, reason: NOT_SENT_REASONS.not_connected };

  const { data: customerRow, error: customerErr } = await supabase
    .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
  if (customerErr) throw customerErr;
  if (!customerRow) return { sent: false, reason: 'Parent not found.' };

  const result = await sendWindowAwareMessage(business, customerRow, {
    textFor,
    template: () => getReminderTemplate(business.id),
    templateParams: templateParams(details),
    templateText: templateText(details),
    billing: {
      referenceId: booking.id,
      notes: `Demo message for booking ${booking.booking_code}`,
      refundNotes: `Refund: demo message for booking ${booking.booking_code} not sent`
    },
    bookingId: booking.id
  });
  // Only { sent } — the setDemoTime response and reminder outcome stay as before.
  return result.sent ? { sent: result.sent } : { sent: false, reason: NOT_SENT_REASONS[result.code] };
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
