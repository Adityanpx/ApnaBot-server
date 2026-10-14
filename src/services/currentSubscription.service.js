// src/services/currentSubscription.service.js
// The single place that decides which subscriptions row is "the current one"
// for a business. A business can briefly (or, after a bug, durably) have more
// than one live row; every .maybeSingle() lookup on that throws PGRST116, which
// took down SG Travels' webhook on 2026-08-31 and the billing page on
// 2026-10-14. Keep this module dependency-light (supabase + logger only):
// tenant.service and subscription.service both import it.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');

const PENDING_STATUS = 'pending_start';

const toTime = (value) => {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
};

// Pick rule: non-pending first, then latest end_date, then latest created_at.
const compareCurrent = (a, b) => {
  const pendingDiff = (a.status === PENDING_STATUS ? 1 : 0) - (b.status === PENDING_STATUS ? 1 : 0);
  if (pendingDiff !== 0) return pendingDiff;
  return (toTime(b.end_date) - toTime(a.end_date)) || (toTime(b.created_at) - toTime(a.created_at));
};

/**
 * Pure: choose the current row from a list. Logs a warning when there is more
 * than one candidate so the duplicate stays visible. Never throws.
 */
const pickCurrentSubscription = (rows, businessId) => {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort(compareCurrent);
  if (sorted.length > 1) {
    logger.warn(`Business ${businessId} has ${sorted.length} candidate subscriptions (${sorted.map(r => `${r.id}:${r.status}`).join(', ')}) — using ${sorted[0].id} (end_date ${sorted[0].end_date}). Duplicate live rows should be investigated.`);
  }
  return sorted[0];
};

/**
 * Current subscription (with plan) for a business among `statuses`.
 * Returns { data, error } like supabase-js and never throws, so callers keep
 * their own "a real DB error is an error" handling (tenant.service must not
 * cache a null subscription for an hour because of a transient failure).
 */
const getCurrentSubscriptionRow = async (businessId, { statuses = ['active'] } = {}) => {
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*, plan:plans(*)')
      .eq('business_id', businessId)
      .in('status', statuses);
    if (error) return { data: null, error };
    return { data: pickCurrentSubscription(data, businessId), error: null };
  } catch (error) {
    return { data: null, error };
  }
};

/**
 * Pure: among `rows` (each with a joined `plan`), the live paid row whose plan
 * is priced strictly above `newPlan` and whose period has not ended — the row
 * that makes a switch to `newPlan` a downgrade. Same or higher price is fine.
 * Plan price (plans.price) is the only tier ordering that exists in the schema.
 */
const findHigherActiveSubscription = (rows, newPlan, now = new Date()) => {
  const newPrice = Number(newPlan?.price) || 0;
  const higher = (rows || []).filter(r =>
    r.status === 'active' &&
    new Date(r.end_date) > now &&
    (Number(r.plan?.price) || 0) > newPrice);
  higher.sort((a, b) => toTime(b.end_date) - toTime(a.end_date));
  return higher[0] || null;
};

const getHigherActiveSubscription = async (businessId, newPlan) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, plan:plans(*)')
    .eq('business_id', businessId)
    .eq('status', 'active');
  if (error) throw error;
  return findHigherActiveSubscription(data, newPlan);
};

module.exports = {
  pickCurrentSubscription,
  getCurrentSubscriptionRow,
  findHigherActiveSubscription,
  getHigherActiveSubscription
};
