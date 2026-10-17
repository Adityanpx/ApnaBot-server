const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const countRows = async (table, { eq = {}, gteColumn, gteValue } = {}) => {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  for (const [column, value] of Object.entries(eq)) {
    query = query.eq(column, value);
  }
  if (gteColumn) query = query.gte(gteColumn, gteValue);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
};

const sumPlanPrice = (subscriptions) =>
  subscriptions.reduce((total, sub) => total + (sub.plan?.price || 0), 0);

/**
 * Get platform-wide stats for admin dashboard
 */
const getPlatformStats = async () => {
  try {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalBusinesses,
      activeBusinesses,
      totalUsers,
      activeSubscriptions,
      trialSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueSubs
    ] = await Promise.all([
      countRows('businesses'),
      countRows('businesses', { eq: { is_active: true } }),
      supabase.from('users').select('*', { count: 'exact', head: true }).in('role', ['owner', 'staff'])
        .then(({ count, error }) => { if (error) throw error; return count || 0; }),
      countRows('subscriptions', { eq: { status: 'active' } }),
      countRows('subscriptions', { eq: { status: 'trial' } }),
      countRows('messages', { gteColumn: 'created_at', gteValue: startOfMonth.toISOString() }),
      countRows('bookings', { gteColumn: 'created_at', gteValue: startOfMonth.toISOString() }),
      supabase.from('subscriptions').select('plan:plans(price)')
        .eq('status', 'active').gte('created_at', startOfMonth.toISOString())
        .then(({ data, error }) => { if (error) throw error; return data || []; })
    ]);

    return {
      totalBusinesses,
      activeBusinesses,
      inactiveBusinesses: totalBusinesses - activeBusinesses,
      totalUsers,
      activeSubscriptions,
      trialSubscriptions,
      totalMessagesThisMonth,
      totalBookingsThisMonth,
      revenueThisMonth: sumPlanPrice(revenueSubs),
      month: currentMonth
    };
  } catch (error) {
    logger.error('Error in getPlatformStats:', error);
    throw error;
  }
};

/**
 * Get monthly revenue report
 */
const getRevenueReport = async (months = 6) => {
  try {
    const report = [];
    const now = new Date();

    for (let i = 0; i < months; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const endDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      const { data: subs, error } = await supabase
        .from('subscriptions')
        .select('plan:plans(price)')
        .in('status', ['active', 'expired'])
        .gte('created_at', date.toISOString())
        .lte('created_at', endDate.toISOString());
      if (error) throw error;

      report.push({
        month: monthKey,
        revenue: sumPlanPrice(subs || []),
        subscriptions: (subs || []).length
      });
    }

    return report.reverse();
  } catch (error) {
    logger.error('Error in getRevenueReport:', error);
    throw error;
  }
};

module.exports = {
  getPlatformStats,
  getRevenueReport
};
