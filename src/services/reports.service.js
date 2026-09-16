const supabase = require('../config/supabase');

const CONFIRMED_STATUSES = ['confirmed', 'completed'];

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

module.exports = {
  getReportsSummary,
  getRevenueByTag
};
