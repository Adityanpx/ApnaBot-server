const supabase = require('../config/supabase');

const CONFIRMED_STATUSES = ['confirmed', 'completed'];

const PIPELINE_STAGES = ['new', 'contacted', 'converted', 'lost'];

// Longest gap between an unanswered inbound message and the human reply that
// finally resolves it that we'll still count as "the reply to that message."
// Chosen to comfortably span a normal weekend/overnight gap (Fri night ->
// Mon morning is ~60h) without pairing an inbound message with an unrelated
// staff message sent to the same customer days/weeks later for a different
// reason. Only affects whether a resolved wait is counted in the average —
// see computeResponseTimeSamples.
const RESPONSE_TIME_MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Returns {currentStart, currentEnd, previousStart, previousEnd} for a
 * reports period. "week" is a rolling last-7-days window vs. the preceding
 * 7 days. "month" is calendar-month-to-date vs. the same elapsed duration
 * into the previous calendar month (not the previous month's full total) —
 * this keeps the comparison duration-matched rather than penalizing early-
 * month lookups against a full prior month.
 */
const getPeriodRanges = (period) => {
  const now = new Date();

  if (period === 'week') {
    const currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { currentStart, currentEnd: now, previousStart, previousEnd: currentStart };
  }

  // month
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const elapsedMs = now.getTime() - currentStart.getTime();
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const previousEnd = new Date(previousStart.getTime() + elapsedMs);
  return { currentStart, currentEnd: now, previousStart, previousEnd };
};

const countInRange = async (table, businessId, start, end, statusIn) => {
  let query = supabase.from(table).select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (statusIn) query = query.in('status', statusIn);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
};

const sumFareInRange = async (businessId, start, end) => {
  const { data, error } = await supabase.from('bookings').select('fare_amount')
    .eq('business_id', businessId)
    .in('status', CONFIRMED_STATUSES)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + (Number(row.fare_amount) || 0), 0);
};

const computeRangeStats = async (businessId, start, end) => {
  const [leads, bookingsConfirmed, revenue] = await Promise.all([
    countInRange('booking_leads', businessId, start, end),
    countInRange('bookings', businessId, start, end, CONFIRMED_STATUSES),
    sumFareInRange(businessId, start, end)
  ]);
  const conversionRate = leads === 0 ? 0 : bookingsConfirmed / leads;
  return { leads, bookingsConfirmed, revenue, conversionRate };
};

const growthPercent = (current, previous) =>
  previous === 0 ? null : ((current - previous) / previous) * 100;

const getReportsSummary = async (businessId, period) => {
  const { currentStart, currentEnd, previousStart, previousEnd } = getPeriodRanges(period);

  const [current, previous] = await Promise.all([
    computeRangeStats(businessId, currentStart, currentEnd),
    computeRangeStats(businessId, previousStart, previousEnd)
  ]);

  return {
    current,
    previous,
    growth: {
      leads: growthPercent(current.leads, previous.leads),
      bookingsConfirmed: growthPercent(current.bookingsConfirmed, previous.bookingsConfirmed),
      revenue: growthPercent(current.revenue, previous.revenue),
      conversionRate: growthPercent(current.conversionRate, previous.conversionRate)
    }
  };
};

const buildRevenueByCustomer = (bookingRows) => {
  const revenue = {};
  for (const row of bookingRows || []) {
    revenue[row.customer_id] = (revenue[row.customer_id] || 0) + (Number(row.fare_amount) || 0);
  }
  return revenue;
};

/**
 * For each distinct tag across this business's customers, sums fare_amount
 * across that tag's customers' confirmed/completed bookings. A customer with
 * multiple tags contributes its full revenue to each tag (not split). A
 * customer with zero tags is excluded entirely.
 */
const getRevenueByTag = async (businessId) => {
  const [customersRes, bookingsRes] = await Promise.all([
    supabase.from('customers').select('id, tags').eq('business_id', businessId),
    supabase.from('bookings').select('customer_id, fare_amount')
      .eq('business_id', businessId).in('status', CONFIRMED_STATUSES)
  ]);
  if (customersRes.error) throw customersRes.error;
  if (bookingsRes.error) throw bookingsRes.error;

  const revenueByCustomer = buildRevenueByCustomer(bookingsRes.data);
  const taggedCustomers = (customersRes.data || []).filter((c) => (c.tags || []).length > 0);

  const statsByTag = {};
  for (const customer of taggedCustomers) {
    const revenue = revenueByCustomer[customer.id] || 0;
    for (const tag of customer.tags) {
      const stat = statsByTag[tag] || { tag, customerCount: 0, revenue: 0 };
      stat.customerCount += 1;
      stat.revenue += revenue;
      statsByTag[tag] = stat;
    }
  }

  return Object.values(statsByTag).sort((a, b) => b.revenue - a.revenue);
};

/**
 * GET /reports/funnel — current snapshot count of customers per pipeline
 * stage, business-wide. Deliberately a point-in-time count, not a true
 * time-scoped funnel (which would need a stage-history table tracking when
 * each customer entered each stage) — that's real added schema/write cost
 * for a trend nobody's asked to see yet; revisit if that changes.
 * Always returns all 4 stages, even ones with 0 customers, so the frontend
 * can draw a complete funnel without special-casing missing entries.
 */
const getPipelineFunnel = async (businessId) => {
  const { data, error } = await supabase
    .from('customers').select('pipeline_stage').eq('business_id', businessId);
  if (error) throw error;

  const counts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, 0]));
  for (const row of data || []) {
    if (counts[row.pipeline_stage] !== undefined) counts[row.pipeline_stage] += 1;
  }

  return PIPELINE_STAGES.map((stage) => ({ stage, count: counts[stage] }));
};

/**
 * Groups messages by customer_id, preserving input order within each group.
 * Rows must already be sorted by created_at ascending within each customer
 * (the caller's query does this via .order('customer_id').order('created_at')).
 */
const groupMessagesByCustomer = (rows) => {
  const byCustomer = new Map();
  for (const row of rows) {
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
    byCustomer.get(row.customer_id).push(row);
  }
  return byCustomer;
};

/**
 * Pairing algorithm (see PR discussion for full reasoning): walk each
 * customer's messages chronologically tracking `pendingSince`, the created_at
 * of the oldest currently-unanswered inbound message.
 * - inbound: only sets pendingSince if it's currently null — a burst of
 *   follow-up messages before any reply is one wait episode, not several, so
 *   only the first message in the burst starts the clock.
 * - outbound, sender_type 'bot': ignored. Doesn't count as a reply and
 *   doesn't touch pendingSince. NOTE: this used to be triggered_rule_id IS
 *   NULL, which turned out to be unreliable — several fully-automated
 *   webhook.controller.js paths (language picker, STOP/START acks, the
 *   "no rule matched" fallback, etc.) never set triggered_rule_id since
 *   there's no specific matched rule to record, so they read as human under
 *   that rule. sender_type is set explicitly at every outbound insert site
 *   instead (see the messages_sender_type migration) specifically so this
 *   predicate has a real signal to key off.
 * - outbound, sender_type 'human': resolves the pending wait (if
 *   any). A sample is only recorded if the pending wait's start falls inside
 *   [windowStart, windowEnd) — this is what scopes a sample to a reporting
 *   period, not the reply's own timestamp, so a message that waits overnight
 *   across a period boundary still gets attributed to the period it was sent
 *   in — and only if the gap is within RESPONSE_TIME_MAX_WAIT_MS. Either way
 *   pendingSince is cleared: the wait is resolved (even if too old to count),
 *   so a later inbound message starts a fresh episode rather than merging
 *   into a stale one.
 * - A human reply with nothing pending (pendingSince null — e.g. staff
 *   messaged proactively) is ignored: no sample.
 * - An inbound message that never gets a human reply within the fetched
 *   range simply never resolves pendingSince, so it never emits a sample —
 *   excluded from the average entirely, not counted as 0.
 *
 * @param {Array<{customer_id: string, direction: string, sender_type: string, created_at: string}>} rows
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @returns {number[]} wait durations in minutes
 */
const computeResponseTimeSamples = (rows, windowStart, windowEnd) => {
  const byCustomer = groupMessagesByCustomer(rows);
  const samples = [];

  for (const messages of byCustomer.values()) {
    let pendingSince = null;

    for (const msg of messages) {
      const createdAt = new Date(msg.created_at);

      if (msg.direction === 'inbound') {
        if (pendingSince === null) pendingSince = createdAt;
        continue;
      }

      // outbound
      if (msg.sender_type === 'bot') continue; // bot reply — doesn't resolve the wait
      if (pendingSince === null) continue; // human reply with nothing pending

      const waitMs = createdAt.getTime() - pendingSince.getTime();
      const startedInWindow = pendingSince >= windowStart && pendingSince < windowEnd;
      if (startedInWindow && waitMs <= RESPONSE_TIME_MAX_WAIT_MS) {
        samples.push(waitMs / 60000);
      }
      pendingSince = null;
    }
  }

  return samples;
};

const average = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

/**
 * How long customers typically wait for a genuine human reply (as opposed to
 * the bot's near-instant auto-replies — see computeResponseTimeSamples) after
 * messaging in, for a given reports period.
 *
 * Fetches messages padded by RESPONSE_TIME_MAX_WAIT_MS on both sides of the
 * period so a wait that starts inside the window can still be matched to a
 * reply that lands after it ends (a message sent near period-end answered
 * the next morning still counts), without an unbounded per-customer history
 * scan (the backward pad only needs to cover the same max-wait cutoff, since
 * a pending wait older than that could never produce a countable sample
 * anyway).
 *
 * Does not account for business hours — a message sent at 11pm and answered
 * at 9am the next day shows as a large wait, which is an overnight gap, not
 * a measurement bug.
 */
const getResponseTimeStats = async (businessId, period) => {
  const { currentStart, currentEnd } = getPeriodRanges(period);
  const fetchStart = new Date(currentStart.getTime() - RESPONSE_TIME_MAX_WAIT_MS);
  const fetchEnd = new Date(currentEnd.getTime() + RESPONSE_TIME_MAX_WAIT_MS);

  const { data, error } = await supabase.from('messages')
    .select('customer_id, direction, sender_type, created_at')
    .eq('business_id', businessId)
    .gte('created_at', fetchStart.toISOString())
    .lt('created_at', fetchEnd.toISOString())
    .order('customer_id', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;

  const waitMinutes = computeResponseTimeSamples(data || [], currentStart, currentEnd);

  return {
    averageMinutes: average(waitMinutes),
    medianMinutes: median(waitMinutes),
    sampleSize: waitMinutes.length,
    note: 'Measures wall-clock time to a human reply; does not account for business hours, so overnight/weekend waits will show as large numbers.'
  };
};

module.exports = {
  getReportsSummary,
  getRevenueByTag,
  getResponseTimeStats,
  getPipelineFunnel
};
