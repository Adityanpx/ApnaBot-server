// Follow-up automations — the sweeper. One pass (runSweep) finds every
// customer an active automation is due for and messages them. server.js runs
// it every 15 minutes when ENABLE_FOLLOWUP_SWEEPER is on;
// scripts/runFollowupSweep.js runs one pass by hand.
//
// Per send, in this order:
//   1. CLAIM  — insert followup_sends (status 'claimed'); the unique
//               (automation_id, customer_id, trigger_key) makes a second
//               sweep skip the same occurrence, so nothing is sent twice.
//   2. RE-CHECK the customer as they are now (they may have replied, booked,
//               sent STOP… since the candidate query) → 'skipped' + reason.
//   3. SEND   — windowAwareSend.service.js: free text while the 24-hour
//               window is open, else the approved template (wallet-charged).
//   4. RECORD — sent_text | sent_template | skipped | failed (+ reason).
// A claim left behind by a crash is marked failed ('interrupted') by a later
// sweep and never re-sent.
//
// A customer gets at most one follow-up per India-time day per business,
// across all its automations: skipped before claiming when already contacted
// today, and re-checked after claiming ('daily_limit_customer' — the earliest
// claim of the day wins).
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const categoryFeatureService = require('./categoryFeature.service');
const { isConnected, isWindowOpen, sendWindowAwareMessage } = require('./windowAwareSend.service');
const {
  dueRange, triggerKeyFor, isBookingTrigger, renderText, renderTemplateParams, renderTemplateText, WINDOW_MARGIN_MINUTES
} = require('../utils/followup');
const { isWithinSendHours, istDayStart } = require('../utils/ist');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const STALE_CLAIM_MS = 30 * MINUTE_MS;
const SWEEP_MAX_SENDS = 300;            // claims per sweep, all businesses together
const CANDIDATE_PAGE_MAX = 200;         // keeps each `in (...)` filter a sensible URL length
const CANDIDATE_PAGES_MAX = 5;          // per automation per sweep
const CLAIMED_TODAY_STATUSES = ['claimed', 'sent_text', 'sent_template'];
const SENT_STATUSES = ['sent_text', 'sent_template'];
// Which automation goes first within a business. With one follow-up per
// customer per day, the first automation due for a customer wins them, so
// time-sensitive triggers go first: an after_last_inbound nudge is lost when
// the 24-hour window closes, a payment reminder is about money owed, a review
// request can wait a day, a win-back longest. Unknown triggers last.
const TRIGGER_PRIORITY = { after_last_inbound: 0, after_payment_requested: 1, after_completed: 2, inactive_for: 3 };
const OPEN_BOOKING_STATUSES = ['pending', 'confirmed'];
const PAST_CUSTOMER_STATUSES = ['confirmed', 'completed'];
const CUSTOMER_COLUMNS = 'id, business_id, whatsapp_number, name, last_message_at, opted_in, opted_out_at, is_blocked, bot_paused_until, preferred_language';

const iso = (d) => new Date(d).toISOString();

/** Trigger priority, then oldest first, then id — a fixed order every sweep. */
const triggerPriority = (a) => (a.trigger_type in TRIGGER_PRIORITY ? TRIGGER_PRIORITY[a.trigger_type] : Number.MAX_SAFE_INTEGER);
const compareAutomations = (a, b) =>
  (triggerPriority(a) - triggerPriority(b)) ||
  (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Whether a template-path send for this automation needs marketing opt-in. */
const needsOptIn = (automation) => automation.message_category === 'marketing';

// ── Candidates (shared with followup.service.js#previewAudience) ──

/**
 * One page of customers whose last inbound puts them in the automation's due
 * range, with the guards SQL can check. Newest last inbound first.
 */
const fetchCandidatePage = async (automation, now, offset, limit) => {
  const { before, after } = dueRange(automation, now);
  let query = supabase.from('customers').select(CUSTOMER_COLUMNS)
    .eq('business_id', automation.business_id)
    .lte('last_message_at', before.toISOString())
    .gt('last_message_at', after.toISOString())
    .eq('is_blocked', false)
    .is('opted_out_at', null)
    .or(`bot_paused_until.is.null,bot_paused_until.lte.${iso(now)}`);
  // inactive_for always sends a template (the window has long closed).
  if (automation.trigger_type === 'inactive_for' && needsOptIn(automation)) query = query.eq('opted_in', true);
  const { data, error } = await query
    .order('last_message_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
};

/** Drops customers the automation's booking rules exclude — one bookings query per page. */
const applyBookingRules = async (automation, customers, now) => {
  if (customers.length === 0) return customers;
  const ids = customers.map(c => c.id);
  const params = automation.trigger_params || {};
  if (automation.trigger_type === 'after_last_inbound') {
    const days = params.recentBookingDays === undefined ? 7 : params.recentBookingDays;
    let query = supabase.from('bookings').select('customer_id')
      .eq('business_id', automation.business_id).in('customer_id', ids);
    query = days > 0
      ? query.or(`status.in.(${OPEN_BOOKING_STATUSES.join(',')}),created_at.gte.${iso(new Date(now).getTime() - days * DAY_MS)}`)
      : query.in('status', OPEN_BOOKING_STATUSES);
    const { data, error } = await query;
    if (error) throw error;
    const excluded = new Set((data || []).map(r => r.customer_id));
    return customers.filter(c => !excluded.has(c.id));
  }
  if (automation.trigger_type === 'inactive_for' && params.onlyPastCustomers) {
    const { data, error } = await supabase.from('bookings').select('customer_id')
      .eq('business_id', automation.business_id).in('customer_id', ids).in('status', PAST_CUSTOMER_STATUSES);
    if (error) throw error;
    const past = new Set((data || []).map(r => r.customer_id));
    return customers.filter(c => past.has(c.id));
  }
  return customers;
};

const BOOKING_COLUMNS = 'id, customer_id, booking_code, payment_amount, status, payment_status, completed_at, payment_requested_at';
const BOOKING_TIME_COLUMN = { after_completed: 'completed_at', after_payment_requested: 'payment_requested_at' };

const isBotPausedAt = (customer, now) =>
  !!customer.bot_paused_until && new Date(customer.bot_paused_until).getTime() > new Date(now).getTime();

/**
 * One page of bookings whose completed_at / payment_requested_at puts them
 * in the automation's due range (bookings.completed_at / payment_requested_at,
 * stamped by trg_stamp_followup_times), each with its customer. Newest first.
 */
const fetchBookingCandidatePage = async (automation, now, offset, limit) => {
  const { before, after } = dueRange(automation, now);
  const column = BOOKING_TIME_COLUMN[automation.trigger_type];
  let query = supabase.from('bookings').select(`${BOOKING_COLUMNS}, customer:customers(${CUSTOMER_COLUMNS})`)
    .eq('business_id', automation.business_id)
    .lte(column, before.toISOString())
    .gt(column, after.toISOString());
  query = automation.trigger_type === 'after_completed'
    ? query.eq('status', 'completed')
    : query.eq('payment_status', 'pending').neq('status', 'cancelled');
  const { data, error } = await query
    .order(column, { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
};

/**
 * Whether a booking's customer can get this follow-up (the same guards the
 * customer query checks in SQL). A payment reminder also waits out a customer
 * who has messaged since the request — e.g. sending the payment screenshot.
 */
const bookingCustomerOk = (automation, booking, now) => {
  const c = booking.customer;
  if (!c || c.is_blocked || c.opted_out_at || isBotPausedAt(c, now)) return false;
  if (automation.trigger_type === 'after_payment_requested' && c.last_message_at &&
      new Date(c.last_message_at).getTime() > new Date(booking.payment_requested_at).getTime()) return false;
  return true;
};

/**
 * One page of what's due: { rows (page size, for paging), due: [{ customer, booking }] }.
 * Customer triggers: booking is null.
 */
const fetchDuePage = async (automation, now, offset, limit) => {
  if (isBookingTrigger(automation.trigger_type)) {
    const rows = await fetchBookingCandidatePage(automation, now, offset, limit);
    const due = rows.filter(b => bookingCustomerOk(automation, b, now)).map(({ customer, ...booking }) => ({ customer, booking }));
    return { rows: rows.length, due };
  }
  const rows = await fetchCandidatePage(automation, now, offset, limit);
  const eligible = await applyBookingRules(automation, rows, now);
  return { rows: rows.length, due: eligible.map(customer => ({ customer, booking: null })) };
};

/**
 * How many are due now under `automation` (no caps, no send hours) — for the
 * wizard's audience count. Booking triggers count bookings (one message each).
 */
const countDueCustomers = async (automation, now = new Date(), { max = 5000 } = {}) => {
  let count = 0;
  for (let offset = 0; offset < max; offset += CANDIDATE_PAGE_MAX) {
    const page = await fetchDuePage(automation, now, offset, CANDIDATE_PAGE_MAX);
    count += page.due.length;
    if (page.rows < CANDIDATE_PAGE_MAX) return { count, capped: false };
  }
  return { count, capped: true };
};

// ── Per-automation bookkeeping ──

/** customer_id → { keys: Set<trigger_key>, sent: number } for this automation. */
const loadSendHistory = async (automationId, customerIds) => {
  const history = new Map();
  if (customerIds.length === 0) return history;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('followup_sends').select('customer_id, trigger_key, status')
      .eq('automation_id', automationId).in('customer_id', customerIds)
      .range(from, from + 999);
    if (error) throw error;
    for (const r of data || []) {
      const h = history.get(r.customer_id) || { keys: new Set(), sent: 0 };
      h.keys.add(r.trigger_key);
      if (SENT_STATUSES.includes(r.status)) h.sent += 1;
      history.set(r.customer_id, h);
    }
    if (!data || data.length < 1000) break;
  }
  return history;
};

// ── One follow-up per customer per India-time day, across all automations ──

/** Ids of these customers who already have a follow-up claimed / sent today (any automation). */
const loadContactedToday = async (businessId, customerIds, now) => {
  const contacted = new Set();
  if (customerIds.length === 0) return contacted;
  const { data, error } = await supabase.from('followup_sends').select('customer_id')
    .eq('business_id', businessId).in('customer_id', customerIds)
    .gte('created_at', istDayStart(now).toISOString())
    .in('status', CLAIMED_TODAY_STATUSES);
  if (error) throw error;
  for (const r of data || []) contacted.add(r.customer_id);
  return contacted;
};

/**
 * Whether another of today's claims for this customer (any automation)
 * comes before `sendRow` — the earliest claim wins, so two sweeps that each
 * claimed the customer for a different automation don't both send.
 */
const hasEarlierClaimToday = async (sendRow, now) => {
  const { data, error } = await supabase.from('followup_sends').select('id, created_at')
    .eq('business_id', sendRow.business_id).eq('customer_id', sendRow.customer_id)
    .gte('created_at', istDayStart(now).toISOString())
    .in('status', CLAIMED_TODAY_STATUSES)
    .neq('id', sendRow.id);
  if (error) throw error;
  const mine = new Date(sendRow.created_at).getTime();
  return (data || []).some((r) => {
    const t = new Date(r.created_at).getTime();
    return t < mine || (t === mine && r.id < sendRow.id);
  });
};

const countClaimedToday = async (automation, now) => {
  const { count, error } = await supabase.from('followup_sends').select('id', { count: 'exact', head: true })
    .eq('automation_id', automation.id)
    .gte('created_at', istDayStart(now).toISOString())
    .in('status', CLAIMED_TODAY_STATUSES);
  if (error) throw error;
  return count || 0;
};

const updateSend = async (sendId, fields) => {
  const { error } = await supabase.from('followup_sends').update(fields).eq('id', sendId);
  if (error) logger.error('Follow-up: could not record send outcome', { sendId, error: error.message });
};

/** Claims left 'claimed' by an interrupted sweep → failed, never re-sent. */
const failStaleClaims = async (now, businessId = null) => {
  let query = supabase.from('followup_sends')
    .update({ status: 'failed', reason: 'interrupted' })
    .eq('status', 'claimed')
    .lt('created_at', iso(new Date(now).getTime() - STALE_CLAIM_MS));
  if (businessId) query = query.eq('business_id', businessId);
  const { data, error } = await query.select('id');
  if (error) throw error;
  return (data || []).length;
};

// ── Business checks (once per business per sweep) ──

/** @returns {Promise<{ business } | { skip: string }>} */
const checkBusiness = async (businessId) => {
  const business = await businessService.getBusinessById(businessId);
  if (!business) return { skip: 'business_gone' };
  if (business.isActive === false) return { skip: 'business_inactive' };
  if (!isConnected(business)) return { skip: 'not_connected' };
  const { data: subs, error } = await supabase.from('subscriptions').select('id')
    .eq('business_id', businessId).eq('status', 'active').limit(1);
  if (error) throw error;
  if (!subs || subs.length === 0) return { skip: 'no_active_subscription' };
  if (!(await categoryFeatureService.isEnabled(business.businessCategory, 'followups', businessId))) {
    return { skip: 'feature_off' };
  }
  return { business };
};

// ── One send ──

const loadTemplate = async (automation) => {
  if (!automation.template_id) return null;
  const { data, error } = await supabase.from('message_templates').select('*')
    .eq('id', automation.template_id).eq('business_id', automation.business_id).maybeSingle();
  if (error) throw error;
  return data;
};

/** Why this booking's follow-up must not go now (booking triggers), or null. */
const bookingGuard = (automation, fresh, booking, sendRow) => {
  if (!booking) return 'booking_gone';
  if (automation.trigger_type === 'after_completed') {
    return booking.status === 'completed' ? null : 'booking_reopened';
  }
  if (booking.payment_status === 'paid') return 'paid';
  if (booking.status === 'cancelled') return 'booking_cancelled';
  if (booking.payment_status !== 'pending' || !booking.payment_requested_at ||
      triggerKeyFor(automation, fresh, booking) !== sendRow.trigger_key) return 'payment_changed';
  if (fresh.last_message_at && new Date(fresh.last_message_at).getTime() > new Date(booking.payment_requested_at).getTime()) {
    return 'customer_replied';
  }
  return null;
};

/** Why this customer must not get this follow-up now, or null. */
const freshGuard = async (automation, fresh, sendRow, now, booking = null) => {
  if (!fresh) return 'customer_gone';
  if (fresh.is_blocked) return 'blocked';
  if (fresh.opted_out_at) return 'opted_out';
  if (isBotPausedAt(fresh, now)) return 'bot_paused';
  if (isBookingTrigger(automation.trigger_type)) {
    const reason = bookingGuard(automation, fresh, booking, sendRow);
    if (reason) return reason;
  } else if (!fresh.last_message_at || triggerKeyFor(automation, fresh) !== sendRow.trigger_key) {
    return 'customer_replied';
  }
  // Another automation (this sweep or an overlapping one) got to them first today.
  if (await hasEarlierClaimToday(sendRow, now)) return 'daily_limit_customer';
  const nowMs = new Date(now).getTime();
  if (automation.trigger_type === 'after_last_inbound') {
    if (!isWindowOpen(fresh, nowMs + WINDOW_MARGIN_MINUTES * MINUTE_MS)) return 'window_closing';
    const [kept] = await applyBookingRules(automation, [fresh], now);
    if (!kept) return 'booked';
  }
  if (!isWindowOpen(fresh, nowMs)) {
    if (!automation.template_id) return 'no_template';
    if (needsOptIn(automation) && !fresh.opted_in) return 'not_opted_in';
  }
  return null;
};

// windowAwareSend codes that mean "not sent, nothing went wrong" vs a failure.
const SKIP_CODES = ['not_connected', 'blocked', 'no_template', 'low_balance'];

/** Re-checks, sends and records one claimed follow-up. @returns {'sent'|'skipped'|'failed'} */
const sendClaimed = async (automation, business, sendRow, now) => {
  const { data: fresh, error } = await supabase.from('customers').select('*').eq('id', sendRow.customer_id).maybeSingle();
  if (error) throw error;
  let booking = null;
  if (isBookingTrigger(automation.trigger_type) && sendRow.booking_id) {
    const { data, error: bookingErr } = await supabase.from('bookings').select(BOOKING_COLUMNS)
      .eq('id', sendRow.booking_id).eq('business_id', automation.business_id).maybeSingle();
    if (bookingErr) throw bookingErr;
    booking = data;
  }
  const guard = await freshGuard(automation, fresh, sendRow, now, booking);
  if (guard) {
    await updateSend(sendRow.id, { status: 'skipped', reason: guard });
    return 'skipped';
  }

  const customer = toCamelCase(fresh);
  let templateRow = null;
  let templateParams = [];
  let templateText = '';
  if (!isWindowOpen(fresh, new Date(now).getTime())) {
    templateRow = await loadTemplate(automation);
    if (!templateRow || templateRow.status !== 'approved') {
      await updateSend(sendRow.id, { status: 'skipped', reason: 'no_template' });
      return 'skipped';
    }
    templateParams = renderTemplateParams(automation.template_variable_mapping, business, customer, templateRow.language, booking);
    templateText = renderTemplateText(templateRow.body_text, templateParams);
  }

  const result = await sendWindowAwareMessage(business, fresh, {
    textFor: (lang) => renderText(automation, business, customer, lang, booking),
    template: templateRow,
    templateParams,
    templateText,
    billing: {
      referenceId: sendRow.id,
      notes: `Follow-up "${automation.name}"`,
      refundNotes: `Refund: follow-up "${automation.name}" not sent`
    },
    bookingId: booking ? booking.id : null
  });
  if (result.sent) {
    await updateSend(sendRow.id, {
      status: result.sent === 'text' ? 'sent_text' : 'sent_template',
      message_id: result.messageId || null,
      cost_paise: result.costPaise || 0
    });
    return 'sent';
  }
  const failed = !SKIP_CODES.includes(result.code);
  await updateSend(sendRow.id, { status: failed ? 'failed' : 'skipped', reason: result.code });
  return failed ? 'failed' : 'skipped';
};

// ── One automation ──

const processAutomation = async (automation, business, now, ctx) => {
  if (!isWithinSendHours(now, automation.send_start_minute, automation.send_end_minute)) {
    ctx.summary.outsideHours += 1;
    return;
  }
  let remaining = automation.daily_cap - await countClaimedToday(automation, now);
  if (remaining <= 0) {
    ctx.summary.capReached += 1;
    return;
  }

  const pageSize = Math.min(remaining * 3, CANDIDATE_PAGE_MAX);
  for (let page = 0; page < CANDIDATE_PAGES_MAX && remaining > 0 && ctx.claims < ctx.maxSends; page += 1) {
    const { rows, due } = await fetchDuePage(automation, now, page * pageSize, pageSize);
    const customerIds = [...new Set(due.map(d => d.customer.id))];
    const history = await loadSendHistory(automation.id, customerIds);
    const contactedToday = await loadContactedToday(automation.business_id, customerIds, now);

    for (const { customer: candidate, booking } of due) {
      if (remaining <= 0 || ctx.claims >= ctx.maxSends) break;
      const triggerKey = triggerKeyFor(automation, candidate, booking);
      const h = history.get(candidate.id);
      if (h && h.keys.has(triggerKey)) continue;              // this occurrence already handled
      if (h && h.sent >= automation.per_customer_cap) continue; // lifetime cap reached
      // One follow-up per customer per India-time day across all automations:
      // earlier sweeps (contactedToday) and earlier automations in this sweep.
      if (contactedToday.has(candidate.id) || ctx.claimedCustomers.has(candidate.id)) continue;
      ctx.summary.candidates += 1;

      if (ctx.dryRun) {
        ctx.summary.planned.push({
          automationId: automation.id,
          automationName: automation.name,
          businessId: automation.business_id,
          customerId: candidate.id,
          customerNumber: candidate.whatsapp_number,
          customerName: candidate.name,
          bookingCode: booking ? booking.booking_code : null,
          triggerKey,
          via: isWindowOpen(candidate, new Date(now).getTime()) ? 'text' : 'template'
        });
        remaining -= 1;
        ctx.claims += 1;
        ctx.claimedCustomers.add(candidate.id);
        continue;
      }

      const { data: sendRow, error: claimErr } = await supabase.from('followup_sends').insert({
        automation_id: automation.id,
        business_id: automation.business_id,
        customer_id: candidate.id,
        booking_id: booking ? booking.id : null,
        trigger_key: triggerKey,
        status: 'claimed'
      }).select().single();
      if (claimErr) {
        if (claimErr.code === '23505') continue; // another sweep claimed it first
        throw claimErr;
      }
      remaining -= 1;
      ctx.claims += 1;
      ctx.claimedCustomers.add(candidate.id);

      try {
        const outcome = await sendClaimed(automation, business, sendRow, now);
        ctx.summary[outcome] += 1;
      } catch (sendErr) {
        logger.error('Follow-up: send failed', { automationId: automation.id, sendId: sendRow.id, error: sendErr.message });
        await updateSend(sendRow.id, { status: 'failed', reason: 'error' });
        ctx.summary.failed += 1;
      }
    }
    if (rows < pageSize) break;
  }
};

/**
 * One sweep over every active automation.
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {string} [opts.businessId]  only this business (scripts/runFollowupSweep.js)
 * @param {boolean} [opts.dryRun]     find who is due; claim and send nothing
 * @returns {Promise<Object>} summary
 */
const runSweep = async ({ now = new Date(), businessId = null, dryRun = false, maxSends = SWEEP_MAX_SENDS } = {}) => {
  const startedAt = Date.now();
  const summary = {
    automations: 0, candidates: 0, sent: 0, skipped: 0, failed: 0,
    staleClaims: 0, outsideHours: 0, capReached: 0, businessesSkipped: {}, dryRun, planned: [], ms: 0
  };
  // claimedCustomers: customer ids claimed in this sweep (any automation) — customers
  // belong to one business, so ids alone are enough.
  const ctx = { summary, dryRun, claims: 0, maxSends, claimedCustomers: new Set() };

  if (!dryRun) summary.staleClaims = await failStaleClaims(now, businessId);

  let query = supabase.from('followup_automations').select('*').eq('is_active', true);
  if (businessId) query = query.eq('business_id', businessId);
  const { data: automations, error } = await query;
  if (error) throw error;

  const byBusiness = new Map();
  for (const a of [...(automations || [])].sort(compareAutomations)) {
    if (!byBusiness.has(a.business_id)) byBusiness.set(a.business_id, []);
    byBusiness.get(a.business_id).push(a);
  }

  for (const [bizId, list] of byBusiness) {
    if (ctx.claims >= maxSends) break;
    let check;
    try {
      check = await checkBusiness(bizId);
    } catch (err) {
      logger.error('Follow-up: business check failed', { businessId: bizId, error: err.message });
      continue;
    }
    if (check.skip) {
      summary.businessesSkipped[bizId] = check.skip;
      continue;
    }
    for (const automation of list) {
      if (ctx.claims >= maxSends) break;
      summary.automations += 1;
      try {
        await processAutomation(automation, check.business, now, ctx);
      } catch (err) {
        logger.error('Follow-up: automation failed', { automationId: automation.id, error: err.message });
      }
    }
  }

  summary.ms = Date.now() - startedAt;
  const { planned, ...logged } = summary;
  logger.info('Follow-up sweep done', { ...logged, planned: planned.length });
  return summary;
};

module.exports = {
  SWEEP_MAX_SENDS,
  TRIGGER_PRIORITY,
  compareAutomations,
  runSweep,
  countDueCustomers,
  fetchCandidatePage,
  applyBookingRules
};
