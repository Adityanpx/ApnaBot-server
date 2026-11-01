// Travel quotes - the sweep. One pass (runSweep) does three things; server.js runs it right after the
// follow-up sweep, in the same 15-minute loop (ENABLE_FOLLOWUP_SWEEPER), through runSweepSafely.
//
//   REMINDER  a quote still 'sent', reminder_after_hours after it was sent: one plain-text message in the
//             customer's language, only while their 24-hour window is open (windowAwareSend with no
//             template, so a closed window sends nothing). Never a handoff lead, never when the reminder
//             would fall at or after the quote's expiry, never when reminder_after_hours is 0.
//   EXPIRY    a quote still 'sent' past expires_at becomes 'expired'. Nothing is sent: the customer only
//             hears of it if they tap an old button (quoteFlow.service). An accepted quote is never expired.
//   OVERDUE   an accepted quote whose advance is still unpaid, valid_hours after it was accepted: the owner
//             is told once. The booking is never cancelled or changed, and a paid or cancelled booking is
//             left alone.
//
// Every send is CLAIMED first with one guarded UPDATE (… where reminder_sent_at is null returning /
// … where overdue_notified_at is null returning). Whoever gets the row back sends; a second instance, an
// overlapping run or a retry gets nothing back and does nothing - so a quote is reminded / flagged at most
// once, even if the send itself then fails (nothing is retried: a late reminder is worse than none).
//
// Timing uses the business's own travel_quote_settings (valid_hours, reminder_after_hours), or the
// defaults when it has none. The travel_quotes switch is NOT checked: a quote that was sent stays
// answerable, reminded and expired after the switch is turned off. A business that is inactive or whose
// WhatsApp is disconnected is skipped (nothing can be sent for it); its quotes are still expired.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const businessService = require('./business.service');
const notificationService = require('./notification.service');
const { isConnected, isWindowOpen, sendWindowAwareMessage } = require('./windowAwareSend.service');
const { DEFAULT_SETTINGS } = require('../utils/travelQuote');
const { buildReminderText } = require('../utils/quoteText');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BATCH_MAX = 200;              // quotes looked at per kind per pass
const OVERDUE_LOOKBACK_DAYS = 30;   // an accepted quote older than this is not chased any more
const BUDGET_MS = 60 * 1000;        // one pass never holds the sweep loop longer than this

const iso = (d) => new Date(d).toISOString();
const isBotPausedAt = (customer, now) => !!customer.bot_paused_until && new Date(customer.bot_paused_until).getTime() > now.getTime();
const count = (map, key) => { map[key] = (map[key] || 0) + 1; };

/** { [businessId]: { validHours, reminderAfterHours } } for the businesses of `rows`, defaults where none saved. */
const loadSettings = async (businessIds) => {
  const out = {};
  for (const id of businessIds) out[id] = { validHours: DEFAULT_SETTINGS.validHours, reminderAfterHours: DEFAULT_SETTINGS.reminderAfterHours };
  if (businessIds.length === 0) return out;
  const { data, error } = await supabase.from('travel_quote_settings').select('business_id, valid_hours, reminder_after_hours').in('business_id', businessIds);
  if (error) throw error;
  for (const row of data || []) out[row.business_id] = { validHours: row.valid_hours, reminderAfterHours: row.reminder_after_hours };
  return out;
};

const loadByIds = async (table, ids, columns = '*') => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.from(table).select(columns).in('id', unique);
  if (error) throw error;
  return new Map((data || []).map(r => [r.id, r]));
};

/** The business as the senders need it, or null (gone / inactive / WhatsApp not connected). Cached per pass. */
const makeBusinessLoader = () => {
  const cache = new Map();
  return async (businessId) => {
    if (!cache.has(businessId)) {
      const business = await businessService.getBusinessById(businessId);
      cache.set(businessId, business && business.isActive !== false ? business : null);
    }
    return cache.get(businessId);
  };
};

// ── Expiry ──────────────────────────────────────────────────────────────────────────────────────

/** Only quotes never accepted: one UPDATE, 'sent' -> 'expired'. */
const expireQuotes = async (now) => {
  const { data, error } = await supabase.from('travel_quotes').update({ status: 'expired' })
    .eq('status', 'sent').lte('expires_at', iso(now)).select('id');
  if (error) throw error;
  return (data || []).length;
};

// ── Reminder ────────────────────────────────────────────────────────────────────────────────────

const sendReminders = async (now, summary, ctx) => {
  const nowMs = now.getTime();
  // Reminders are whole hours (>= 1): nothing younger than an hour can be due.
  const { data: rows, error } = await supabase.from('travel_quotes').select('*')
    .eq('status', 'sent').is('reminder_sent_at', null).gt('expires_at', iso(now)).lte('sent_at', iso(nowMs - HOUR_MS))
    .order('sent_at', { ascending: true }).limit(BATCH_MAX);
  if (error) throw error;
  if (!rows || rows.length === 0) return;

  const settings = await loadSettings([...new Set(rows.map(r => r.business_id))]);
  const customers = await loadByIds('customers', rows.map(r => r.customer_id));

  for (const quote of rows) {
    if (ctx.overBudget()) { summary.budgetStopped = true; return; }
    try {
      const reminderHours = settings[quote.business_id].reminderAfterHours;
      const sentMs = new Date(quote.sent_at).getTime();
      const dueMs = sentMs + reminderHours * HOUR_MS;
      // 0 = no reminder; one that would fall at or after this quote's own expiry is never sent.
      if (!(reminderHours > 0) || dueMs >= new Date(quote.expires_at).getTime()) { count(summary.reminderSkipped, 'not_applicable'); continue; }
      if (dueMs > nowMs) { count(summary.reminderSkipped, 'not_due'); continue; }

      const customer = customers.get(quote.customer_id);
      if (!customer) { count(summary.reminderSkipped, 'customer_gone'); continue; }
      if (customer.is_blocked) { count(summary.reminderSkipped, 'blocked'); continue; }
      if (customer.opted_out_at) { count(summary.reminderSkipped, 'opted_out'); continue; }
      if (isBotPausedAt(customer, now)) { count(summary.reminderSkipped, 'bot_paused'); continue; }
      // WhatsApp only allows free text inside the customer's 24 hours; outside it nothing is sent, quietly.
      if (!isWindowOpen(customer, nowMs)) { count(summary.reminderSkipped, 'window_closed'); continue; }
      const business = await ctx.loadBusiness(quote.business_id);
      if (!business || !isConnected(business)) { count(summary.reminderSkipped, 'business_unavailable'); continue; }

      // The claim: only one runner gets the row back.
      const { data: claimed, error: claimErr } = await supabase.from('travel_quotes').update({ reminder_sent_at: iso(now) })
        .eq('id', quote.id).eq('status', 'sent').is('reminder_sent_at', null).select('id');
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) { count(summary.reminderSkipped, 'claimed_elsewhere'); continue; }

      const result = await sendWindowAwareMessage(business, customer, {
        textFor: (lang) => buildReminderText(quote, lang),
        template: null,
        templateParams: [],
        templateText: '',
        billing: { referenceId: quote.id, notes: 'Travel quote reminder', refundNotes: 'Refund: travel quote reminder not sent' }
      });
      if (result.sent) summary.remindersSent += 1;
      else count(summary.reminderSkipped, `send_${result.code}`);
    } catch (err) {
      summary.errors += 1;
      logger.error('Quote sweep: reminder failed', { quoteId: quote.id, error: err.message });
    }
  }
};

// ── Overdue advance ─────────────────────────────────────────────────────────────────────────────

const notifyOverdue = async (now, summary, ctx) => {
  const nowMs = now.getTime();
  const { data: rows, error } = await supabase.from('travel_quotes').select('*')
    .eq('status', 'accepted').is('overdue_notified_at', null).is('paid_at', null).not('advance_amount', 'is', null)
    .gte('accepted_at', iso(nowMs - OVERDUE_LOOKBACK_DAYS * DAY_MS)).lte('accepted_at', iso(nowMs - HOUR_MS))
    .order('accepted_at', { ascending: true }).limit(BATCH_MAX);
  if (error) throw error;
  if (!rows || rows.length === 0) return;

  const settings = await loadSettings([...new Set(rows.map(r => r.business_id))]);
  const bookings = await loadByIds('bookings', rows.map(r => r.booking_id), 'id, status, payment_status');
  const customers = await loadByIds('customers', rows.map(r => r.customer_id), 'id, name, whatsapp_number');

  for (const quote of rows) {
    if (ctx.overBudget()) { summary.budgetStopped = true; return; }
    try {
      const dueMs = new Date(quote.accepted_at).getTime() + settings[quote.business_id].validHours * HOUR_MS;
      if (dueMs > nowMs) { count(summary.overdueSkipped, 'not_due'); continue; }

      const booking = quote.booking_id ? bookings.get(quote.booking_id) : null;
      if (!booking) { count(summary.overdueSkipped, 'booking_gone'); continue; }
      if (booking.status === 'cancelled') { count(summary.overdueSkipped, 'booking_cancelled'); continue; }
      if (booking.payment_status !== 'pending') { count(summary.overdueSkipped, 'not_pending'); continue; }
      if (!(await ctx.loadBusiness(quote.business_id))) { count(summary.overdueSkipped, 'business_unavailable'); continue; }

      // The claim: the owner is told once.
      const { data: claimed, error: claimErr } = await supabase.from('travel_quotes').update({ overdue_notified_at: iso(now) })
        .eq('id', quote.id).eq('status', 'accepted').is('overdue_notified_at', null).select('id');
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) { count(summary.overdueSkipped, 'claimed_elsewhere'); continue; }

      const customer = customers.get(quote.customer_id);
      notificationService.notify(quote.business_id, 'quote_advance_overdue', {
        bookingId: booking.id,
        customerId: quote.customer_id,
        customerName: customer ? customer.name : null,
        customerNumber: customer ? customer.whatsapp_number : null,
        amount: quote.advance_amount
      });
      summary.overdueNotified += 1;
    } catch (err) {
      summary.errors += 1;
      logger.error('Quote sweep: overdue alert failed', { quoteId: quote.id, error: err.message });
    }
  }
};

// ── One pass ────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ now?: Date, budgetMs?: number }} [opts]
 * @returns {Promise<Object>} counts: expired, remindersSent, overdueNotified, reminderSkipped / overdueSkipped by reason, errors
 */
const runSweep = async ({ now = new Date(), budgetMs = BUDGET_MS } = {}) => {
  const startedAt = Date.now();
  const summary = { expired: 0, remindersSent: 0, reminderSkipped: {}, overdueNotified: 0, overdueSkipped: {}, errors: 0, budgetStopped: false, ms: 0 };
  const ctx = { loadBusiness: makeBusinessLoader(), overBudget: () => Date.now() - startedAt > budgetMs };

  // Each part on its own: one failing never stops the others.
  for (const [name, run] of [
    ['expiry', async () => { summary.expired = await expireQuotes(now); }],
    ['reminders', () => sendReminders(now, summary, ctx)],
    ['overdue', () => notifyOverdue(now, summary, ctx)]
  ]) {
    try {
      await run();
    } catch (err) {
      summary.errors += 1;
      logger.error(`Quote sweep: ${name} failed`, { error: err.message });
    }
  }
  summary.ms = Date.now() - startedAt;
  if (summary.expired || summary.remindersSent || summary.overdueNotified || summary.errors) logger.info('Quote sweep', summary);
  return summary;
};

/** What server.js calls: never throws, so it can never affect the follow-up sweep that runs before it. */
const runSweepSafely = async (opts) => {
  try {
    return await runSweep(opts);
  } catch (err) {
    logger.error('Quote sweep failed:', err);
    return null;
  }
};

module.exports = { runSweep, runSweepSafely, BATCH_MAX, OVERDUE_LOOKBACK_DAYS };
