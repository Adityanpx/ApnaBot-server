// src/scripts/verifyReportAggregates.js
//
// Verification for the move of reports.service.js (summary revenue,
// revenue-by-tag, funnel, response time) and customer.controller.js's
// fetchBookingStatsByCustomer from "fetch rows into Node and aggregate" to
// Postgres-side aggregation (RPCs in migration
// 20260927120000_report_aggregate_rpcs.sql, head counts for the funnel).
//
// For every business, computes each report the OLD way (the pre-RPC JS
// logic, kept below verbatim as the reference — including
// computeResponseTimeSamples) and the NEW way (the live service functions /
// RPCs), and diffs them. The old-way fetchers page with .range() so the
// reference itself stays correct past PostgREST's 1000-row max_rows; the
// "rows" column in the output shows whether a business is over that cap
// (where the pre-RPC production code would have been silently wrong).
//
// Comparison rules (approved deviations from the old code):
//   - numbers compared with a relative epsilon (numeric vs float summing,
//     avg/percentile_cont vs JS reduce/median);
//   - revenue-by-tag compared per tag, plus a check that the new list is
//     sorted by revenue desc — the new tie-break order (by tag) isn't
//     compared against the old arbitrary one.
//   - response time is also compared over extra windows (each of the last 3
//     calendar months, and all time) by calling the RPC directly, since the
//     live week/month windows may hold few or no samples.
//
// Read-only: writes nothing. Requires the migration to be applied.
//
// Usage:
//   node src/scripts/verifyReportAggregates.js
//   node src/scripts/verifyReportAggregates.js <businessId>   (one business)

require('dotenv').config();
const supabase = require('../config/supabase');
const reportsService = require('../services/reports.service');

const CONFIRMED_STATUSES = ['confirmed', 'completed'];
const PIPELINE_STAGES = ['new', 'contacted', 'converted', 'lost'];
const RESPONSE_TIME_MAX_WAIT_MS = 3 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Reference (pre-RPC) logic — pure functions over rows, copied from
// reports.service.js / customer.controller.js before the change.
// ---------------------------------------------------------------------------

const legacyPeriodRanges = (period, now) => {
  if (period === 'week') {
    const currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { currentStart, currentEnd: now, previousStart, previousEnd: currentStart };
  }
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const elapsedMs = now.getTime() - currentStart.getTime();
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const previousEnd = new Date(previousStart.getTime() + elapsedMs);
  return { currentStart, currentEnd: now, previousStart, previousEnd };
};

const legacySumFare = (fareRows) =>
  (fareRows || []).reduce((sum, row) => sum + (Number(row.fare_amount) || 0), 0);

const legacyRevenueByTag = (customerRows, bookingRows) => {
  const revenueByCustomer = {};
  for (const row of bookingRows || []) {
    revenueByCustomer[row.customer_id] = (revenueByCustomer[row.customer_id] || 0) + (Number(row.fare_amount) || 0);
  }
  const taggedCustomers = (customerRows || []).filter((c) => (c.tags || []).length > 0);
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

const legacyFunnel = (customerRows) => {
  const counts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, 0]));
  for (const row of customerRows || []) {
    if (counts[row.pipeline_stage] !== undefined) counts[row.pipeline_stage] += 1;
  }
  return PIPELINE_STAGES.map((stage) => ({ stage, count: counts[stage] }));
};

const groupMessagesByCustomer = (rows) => {
  const byCustomer = new Map();
  for (const row of rows) {
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
    byCustomer.get(row.customer_id).push(row);
  }
  return byCustomer;
};

// Rows must be sorted by customer_id, then created_at ascending.
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

const legacyResponseTime = (messageRows, windowStart, windowEnd) => {
  const waitMinutes = computeResponseTimeSamples(messageRows, windowStart, windowEnd);
  return { averageMinutes: average(waitMinutes), medianMinutes: median(waitMinutes), sampleSize: waitMinutes.length };
};

const legacyBookingStatsByCustomer = (bookingRows) => {
  const stats = {};
  for (const row of bookingRows || []) {
    const stat = stats[row.customer_id] || { count: 0, spend: 0 };
    stat.count += 1;
    stat.spend += Number(row.fare_amount) || 0;
    stats[row.customer_id] = stat;
  }
  return stats;
};

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

const numbersMatch = (a, b) => {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (a === b) return true;
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
};

// Deep compare with epsilon on numbers; returns a list of mismatch paths.
const diff = (a, b, path = '') => {
  if (typeof a === 'number' || typeof b === 'number') {
    return numbersMatch(a, b) ? [] : [`${path}: old=${a} new=${b}`];
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? [] : [`${path}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`];
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (JSON.stringify(keysA) !== JSON.stringify(keysB)) {
    return [`${path}: keys old=${JSON.stringify(keysA)} new=${JSON.stringify(keysB)}`];
  }
  return keysA.flatMap((k) => diff(a[k], b[k], `${path}.${k}`));
};

const diffRevenueByTag = (oldList, newList) => {
  const problems = [];
  const byTag = (list) => Object.fromEntries(list.map((s) => [s.tag, s]));
  if (oldList.length !== newList.length) problems.push(`length old=${oldList.length} new=${newList.length}`);
  const oldByTag = byTag(oldList);
  const newByTag = byTag(newList);
  for (const tag of new Set([...Object.keys(oldByTag), ...Object.keys(newByTag)])) {
    problems.push(...diff(oldByTag[tag] || null, newByTag[tag] || null, `[${tag}]`));
  }
  for (let i = 1; i < newList.length; i++) {
    if (newList[i].revenue > newList[i - 1].revenue) problems.push(`new list not sorted by revenue desc at index ${i}`);
  }
  if (newList.length > 0 && JSON.stringify(Object.keys(newList[0])) !== JSON.stringify(['tag', 'customerCount', 'revenue'])) {
    problems.push(`new item keys ${JSON.stringify(Object.keys(newList[0]))}`);
  }
  return problems;
};

// ---------------------------------------------------------------------------
// Live fetchers (paged, deterministic order)
// ---------------------------------------------------------------------------

const fetchAll = async (buildQuery) => {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
};

const fetchBusinessRows = async (businessId) => {
  const [customers, confirmedBookings, messages] = await Promise.all([
    fetchAll(() => supabase.from('customers').select('id, tags, pipeline_stage')
      .eq('business_id', businessId).order('id')),
    fetchAll(() => supabase.from('bookings').select('id, customer_id, fare_amount, created_at')
      .eq('business_id', businessId).in('status', CONFIRMED_STATUSES).order('id')),
    fetchAll(() => supabase.from('messages').select('id, customer_id, direction, sender_type, created_at')
      .eq('business_id', businessId)
      .order('customer_id').order('created_at').order('id'))
  ]);
  return { customers, confirmedBookings, messages };
};

const inRange = (row, start, end) => {
  const t = new Date(row.created_at);
  return t >= start && t < end;
};

const newResponseTimeForWindow = async (businessId, windowStart, windowEnd) => {
  const { data, error } = await supabase.rpc('report_response_time_stats', {
    p_business_id: businessId,
    p_fetch_start: new Date(windowStart.getTime() - RESPONSE_TIME_MAX_WAIT_MS).toISOString(),
    p_fetch_end: new Date(windowEnd.getTime() + RESPONSE_TIME_MAX_WAIT_MS).toISOString(),
    p_window_start: windowStart.toISOString(),
    p_window_end: windowEnd.toISOString(),
    p_max_wait_ms: RESPONSE_TIME_MAX_WAIT_MS
  });
  if (error) throw error;
  const stats = data[0];
  const sampleSize = Number(stats.sample_size) || 0;
  return {
    averageMinutes: sampleSize === 0 ? null : Number(stats.average_minutes),
    medianMinutes: sampleSize === 0 ? null : Number(stats.median_minutes),
    sampleSize
  };
};

// Mirrors customer.controller.js's fetchBookingStatsByCustomer (not exported).
const newBookingStatsByCustomer = async (businessId, customerIds) => {
  const { data, error } = await supabase.rpc('customer_booking_stats', {
    p_business_id: businessId,
    p_customer_ids: customerIds,
    p_statuses: CONFIRMED_STATUSES
  });
  if (error) throw error;
  const stats = {};
  for (const row of data || []) {
    stats[row.customer_id] = { count: Number(row.booking_count), spend: Number(row.spend) };
  }
  return stats;
};

// Extra response-time windows: each of the last 3 calendar months + all time.
const extraWindows = (now) => {
  const windows = [];
  for (let back = 0; back < 3; back++) {
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const end = back === 0 ? now : new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
    windows.push({ label: `month-${start.toISOString().slice(0, 7)}`, start, end });
  }
  windows.push({ label: 'all-time', start: new Date('2020-01-01T00:00:00Z'), end: now });
  return windows;
};

// ---------------------------------------------------------------------------

const verifyBusiness = async (business) => {
  const businessId = business.id;
  const rows = await fetchBusinessRows(businessId);
  const results = []; // { check, problems }
  const check = (name, problems) => results.push({ check: name, problems });

  for (const period of ['week', 'month']) {
    const now = new Date();
    const newSummary = await reportsService.getReportsSummary(businessId, period);
    const ranges = legacyPeriodRanges(period, now);
    // Leads/bookings counts were head counts before and after — unchanged code
    // path — so only revenue (and the growth derived from it) is compared.
    const oldCurrentRevenue = legacySumFare(rows.confirmedBookings.filter((b) => inRange(b, ranges.currentStart, ranges.currentEnd)));
    const oldPreviousRevenue = legacySumFare(rows.confirmedBookings.filter((b) => inRange(b, ranges.previousStart, ranges.previousEnd)));
    const oldGrowth = oldPreviousRevenue === 0 ? null : ((oldCurrentRevenue - oldPreviousRevenue) / oldPreviousRevenue) * 100;
    check(`summary.${period}.revenue`, [
      ...diff(oldCurrentRevenue, newSummary.current.revenue, 'current.revenue'),
      ...diff(oldPreviousRevenue, newSummary.previous.revenue, 'previous.revenue'),
      ...diff(oldGrowth, newSummary.growth.revenue, 'growth.revenue'),
      ...diff(['current', 'previous', 'growth'], Object.keys(newSummary), 'keys'),
      ...diff(['leads', 'bookingsConfirmed', 'revenue', 'conversionRate'], Object.keys(newSummary.current), 'current.keys')
    ]);

    const newRt = await reportsService.getResponseTimeStats(businessId, period);
    const oldRt = legacyResponseTime(rows.messages, ranges.currentStart, ranges.currentEnd);
    const { note, ...newRtNoNote } = newRt;
    check(`responseTime.${period} (n=${oldRt.sampleSize})`, [
      ...diff(oldRt, newRtNoNote),
      ...(typeof note === 'string' ? [] : ['note missing'])
    ]);
  }

  for (const w of extraWindows(new Date())) {
    const oldRt = legacyResponseTime(rows.messages, w.start, w.end);
    const newRt = await newResponseTimeForWindow(businessId, w.start, w.end);
    check(`responseTime.${w.label} (n=${oldRt.sampleSize})`, diff(oldRt, newRt));
  }

  const newTags = await reportsService.getRevenueByTag(businessId);
  const oldTags = legacyRevenueByTag(rows.customers, rows.confirmedBookings);
  check(`revenueByTag (tags=${oldTags.length})`, diffRevenueByTag(oldTags, newTags));

  const newFunnel = await reportsService.getPipelineFunnel(businessId);
  check('funnel', diff(legacyFunnel(rows.customers), newFunnel));

  const customerIds = rows.customers.map((c) => c.id);
  const newStats = {};
  for (let i = 0; i < customerIds.length; i += 200) {
    Object.assign(newStats, await newBookingStatsByCustomer(businessId, customerIds.slice(i, i + 200)));
  }
  const oldStats = legacyBookingStatsByCustomer(rows.confirmedBookings);
  check(`customerBookingStats (customers w/ bookings=${Object.keys(oldStats).length})`, diff(
    Object.fromEntries(Object.keys(oldStats).sort().map((k) => [k, oldStats[k]])),
    Object.fromEntries(Object.keys(newStats).sort().map((k) => [k, newStats[k]]))
  ));

  return {
    rowCounts: `customers=${rows.customers.length} confirmedBookings=${rows.confirmedBookings.length} messages=${rows.messages.length}`,
    overCap: [rows.customers.length, rows.confirmedBookings.length, rows.messages.length].some((n) => n > 1000),
    results
  };
};

const main = async () => {
  const onlyId = process.argv[2];
  let query = supabase.from('businesses').select('id, name').order('name');
  if (onlyId) query = query.eq('id', onlyId);
  const { data: businesses, error } = await query;
  if (error) throw error;

  let failures = 0;
  for (const business of businesses) {
    const { rowCounts, overCap, results } = await verifyBusiness(business);
    console.log(`\n${business.name} (${business.id})  ${rowCounts}${overCap ? '  ** over 1000-row cap **' : ''}`);
    for (const { check, problems } of results) {
      console.log(`  ${problems.length === 0 ? 'OK      ' : 'MISMATCH'} ${check}`);
      for (const p of problems) console.log(`             ${p}`);
      if (problems.length > 0) failures += 1;
    }
  }
  console.log(`\n${failures === 0 ? 'ALL MATCH' : `${failures} MISMATCHED CHECK(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
};

module.exports = {
  legacySumFare,
  legacyRevenueByTag,
  legacyFunnel,
  legacyResponseTime,
  legacyBookingStatsByCustomer,
  computeResponseTimeSamples,
  diff,
  diffRevenueByTag
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
