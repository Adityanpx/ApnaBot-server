// Super Admin businesses list: the filters (shared by the list and the CSV export), and the owner /
// subscription lookups that decorate the rows.
const supabase = require('../config/supabase');
const { sanitizeSearchTerm } = require('../utils/searchTerm');
const { fetchByIds } = require('../utils/fetchAllPages');
const { pickCurrentSubscription } = require('./currentSubscription.service');

const OWNER_LOOKUP_LIMIT = 200;

/** The filters a list / export request carries, normalised (query-string booleans are 'true' / 'false'). */
const parseBusinessFilters = (query = {}) => {
  const bool = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);
  return {
    search: sanitizeSearchTerm(query.search),
    isActive: bool(query.isActive),
    connected: bool(query.connected),
    businessCategory: typeof query.businessCategory === 'string' && query.businessCategory ? query.businessCategory : undefined
  };
};

/** Ids of owners whose name or email contains `term`, or whose phone contains its 4+ digits. */
const findOwnerIdsBySearch = async (term) => {
  const clauses = [`name.ilike.%${term}%`, `email.ilike.%${term}%`];
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 4) clauses.push(`phone.ilike.%${digits}%`);
  const { data, error } = await supabase
    .from('users').select('id').eq('role', 'owner').or(clauses.join(',')).limit(OWNER_LOOKUP_LIMIT);
  if (error) throw error;
  return (data || []).map((u) => u.id);
};

/**
 * Resolves the filters once (the owner lookup is a query) and returns `apply(query)`, which adds them to a
 * businesses query. Search: business name / city, plus the owner's name, email or phone (ids come from the
 * database, not the request).
 */
const buildBusinessFilter = async (filters) => {
  const { search, isActive, connected, businessCategory } = filters;
  const clauses = search ? [`name.ilike.%${search}%`, `city.ilike.%${search}%`] : [];
  if (search) {
    const ownerIds = await findOwnerIdsBySearch(search);
    if (ownerIds.length > 0) clauses.push(`owner_user_id.in.(${ownerIds.join(',')})`);
  }
  return (query) => {
    let q = query;
    if (clauses.length > 0) q = q.or(clauses.join(','));
    if (isActive !== undefined) q = q.eq('is_active', isActive);
    if (connected !== undefined) q = q.eq('is_whatsapp_connected', connected);
    if (businessCategory) q = q.eq('business_category', businessCategory);
    return q;
  };
};

/** { [userId]: { id, name, email, phone } } for the owners of `rows` (snake_case business rows). */
const loadOwners = async (rows) => {
  const ids = [...new Set(rows.map((b) => b.owner_user_id).filter(Boolean))];
  const owners = await fetchByIds(supabase, 'users', 'id, name, email, phone', 'id', ids);
  return Object.fromEntries(owners.map((o) => [o.id, o]));
};

/**
 * { [businessId]: { status, plan: { id, name, displayName } } } - the newest active-or-trial subscription
 * of each business (same pick rule as the rest of the app: latest end_date, then latest created_at).
 * A business with none is absent from the map.
 */
const loadCurrentSubscriptions = async (businessIds) => {
  const rows = await fetchByIds(
    supabase, 'subscriptions', 'id, business_id, status, end_date, created_at, plan:plans(id, name, display_name)',
    'business_id', businessIds, (q) => q.in('status', ['active', 'trial'])
  );
  const byBusiness = {};
  for (const r of rows) (byBusiness[r.business_id] = byBusiness[r.business_id] || []).push(r);
  const out = {};
  for (const [businessId, list] of Object.entries(byBusiness)) {
    const sub = pickCurrentSubscription(list, businessId);
    const plan = sub.plan || null;
    out[businessId] = {
      status: sub.status,
      plan: plan ? { id: plan.id, name: plan.name, displayName: plan.display_name } : null
    };
  }
  return out;
};

module.exports = { parseBusinessFilters, buildBusinessFilter, loadOwners, loadCurrentSubscriptions };
