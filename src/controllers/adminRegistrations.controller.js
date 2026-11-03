const supabase = require('../config/supabase');
const { successResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { sanitizeSearchTerm } = require('../utils/searchTerm');
const { toCsv } = require('../utils/csv');
const { fetchAllPages: fetchAll } = require('../utils/fetchAllPages');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;

const CSV_COLUMNS = [
  { key: 'name', header: 'Name' },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'verified', header: 'Verified' },
  { key: 'registeredAt', header: 'Registered' },
  { key: 'daysSince', header: 'Days since' },
  { key: 'lastLoginAt', header: 'Last login' }
];

/** The filters a list / export request carries, normalised (query-string booleans are 'true'). */
const parseFilters = (query = {}) => ({
  search: sanitizeSearchTerm(query.search),
  includeInactive: query.includeInactive === 'true',
  unverifiedOnly: query.unverifiedOnly === 'true'
});

/** Owner accounts (role 'owner') matching the filters, newest first. */
const fetchOwners = ({ search, includeInactive, unverifiedOnly }) => fetchAll((from, to) => {
  let q = supabase.from('users')
    .select('id, name, email, phone, is_verified, is_active, created_at, last_login_at')
    .eq('role', 'owner');
  if (!includeInactive) q = q.eq('is_active', true);
  if (unverifiedOnly) q = q.eq('is_verified', false);
  if (search) q = q.or(`name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
  return q.order('created_at', { ascending: false }).range(from, to);
});

/** Ids of every user who owns at least one business. */
const fetchOwnerIdsWithBusiness = async () => {
  const rows = await fetchAll((from, to) => supabase.from('businesses')
    .select('owner_user_id').not('owner_user_id', 'is', null).order('id').range(from, to));
  return new Set(rows.map((b) => b.owner_user_id));
};

const toRow = (u, nowMs) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone || null,
  verified: u.is_verified === true,
  isActive: u.is_active !== false,
  registeredAt: u.created_at,
  daysSince: Math.max(0, Math.floor((nowMs - new Date(u.created_at).getTime()) / DAY_MS)),
  lastLoginAt: u.last_login_at || null
});

/** Owners with no business, as list rows. */
const findNoBusinessOwners = async (filters) => {
  const [owners, withBusiness] = await Promise.all([fetchOwners(filters), fetchOwnerIdsWithBusiness()]);
  const nowMs = Date.now();
  return owners.filter((u) => !withBusiness.has(u.id)).map((u) => toRow(u, nowMs));
};

/**
 * GET /api/admin/registrations/no-business
 * Owners who registered but never created a business. Query: page, limit, search (name / email /
 * phone), includeInactive=true (default hides deactivated accounts), unverifiedOnly=true.
 */
const listNoBusiness = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const rows = await findNoBusinessOwners(parseFilters(req.query));
    const registrations = rows.slice((page - 1) * limit, page * limit);
    return successResponse(res, 200, { registrations, pagination: getPagination(rows.length, page, limit) });
  } catch (error) {
    logger.error('Error in listNoBusiness:', error);
    next(error);
  }
};

/** GET /api/admin/registrations/no-business/export.csv - same filters, all rows; logs who exported what. */
const exportNoBusinessCsv = async (req, res, next) => {
  try {
    const filters = parseFilters(req.query);
    const rows = await findNoBusinessOwners(filters);
    logger.info(`[admin-export] no-business registrations: user=${req.user.userId} filters=${JSON.stringify(filters)} rows=${rows.length}`);
    const csv = toCsv(CSV_COLUMNS, rows.map((r) => ({ ...r, verified: r.verified ? 'yes' : 'no' })));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="registered-no-business.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    logger.error('Error in exportNoBusinessCsv:', error);
    next(error);
  }
};

module.exports = { listNoBusiness, exportNoBusinessCsv, findNoBusinessOwners };
