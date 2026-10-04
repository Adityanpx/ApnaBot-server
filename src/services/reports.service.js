const supabase = require('../config/supabase');
const { istMonthStart } = require('../utils/ist');

const CONFIRMED_STATUSES = ['confirmed', 'completed'];

const PIPELINE_STAGES = ['new', 'contacted', 'converted', 'lost'];

// Longest gap between an unanswered inbound message and the human reply that
// finally resolves it that we'll still count as "the reply to that message."
// Chosen to comfortably span a normal weekend/overnight gap (Fri night ->
// Mon morning is ~60h) without pairing an inbound message with an unrelated
// staff message sent to the same customer days/weeks later for a different
// reason. Only affects whether a resolved wait is counted in the average —
// see the pairing rules above getResponseTimeStats.
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

  // month (India-time calendar months; the server runs in UTC)
  const currentStart = istMonthStart(now);
  const elapsedMs = now.getTime() - currentStart.getTime();
  const previousStart = istMonthStart(now, -1);
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

// Summed in Postgres (report_sum_fare) rather than fetching fare rows — an
// un-ranged select silently caps at PostgREST's 1000-row max_rows.
const sumFareInRange = async (businessId, start, end) => {
  const { data, error } = await supabase.rpc('report_sum_fare', {
    p_business_id: businessId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
    p_statuses: CONFIRMED_STATUSES
  });
  if (error) throw error;
  return Number(data) || 0;
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

/**
 * For each distinct tag across this business's customers, sums fare_amount
 * across that tag's customers' confirmed/completed bookings. A customer with
 * multiple tags contributes its full revenue to each tag (not split). A
 * customer with zero tags is excluded entirely. Aggregated in Postgres
 * (report_revenue_by_tag), sorted by revenue desc then tag.
 */
const getRevenueByTag = async (businessId) => {
  const { data, error } = await supabase.rpc('report_revenue_by_tag', {
    p_business_id: businessId,
    p_statuses: CONFIRMED_STATUSES
  });
  if (error) throw error;

  return (data || []).map((row) => ({
    tag: row.tag,
    customerCount: Number(row.customer_count),
    revenue: Number(row.revenue)
  }));
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
  const results = await Promise.all(PIPELINE_STAGES.map((stage) =>
    supabase.from('customers').select('*', { count: 'exact', head: true })
      .eq('business_id', businessId).eq('pipeline_stage', stage)
  ));

  return PIPELINE_STAGES.map((stage, i) => {
    const { count, error } = results[i];
    if (error) throw error;
    return { stage, count: count || 0 };
  });
};

/*
 * Response-time pairing rules (see PR discussion for full reasoning),
 * implemented in SQL by report_response_time_stats (migration
 * 20260927120000_report_aggregate_rpcs.sql): walk each
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
 * The original JS implementation of these rules is kept as the reference in
 * src/scripts/verifyReportAggregates.js.
 */

/**
 * How long customers typically wait for a genuine human reply (as opposed to
 * the bot's near-instant auto-replies — see the pairing rules above) after
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

  const { data, error } = await supabase.rpc('report_response_time_stats', {
    p_business_id: businessId,
    p_fetch_start: fetchStart.toISOString(),
    p_fetch_end: fetchEnd.toISOString(),
    p_window_start: currentStart.toISOString(),
    p_window_end: currentEnd.toISOString(),
    p_max_wait_ms: RESPONSE_TIME_MAX_WAIT_MS
  });
  if (error) throw error;

  const stats = (data || [])[0] || {};
  const sampleSize = Number(stats.sample_size) || 0;

  return {
    averageMinutes: sampleSize === 0 ? null : Number(stats.average_minutes),
    medianMinutes: sampleSize === 0 ? null : Number(stats.median_minutes),
    sampleSize,
    note: 'Measures wall-clock time to a human reply; does not account for business hours, so overnight/weekend waits will show as large numbers.'
  };
};

module.exports = {
  getReportsSummary,
  getRevenueByTag,
  getResponseTimeStats,
  getPipelineFunnel
};
