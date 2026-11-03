const supabase = require('../config/supabase');
const businessCategoryService = require('../services/businessCategory.service');
const adminBusinessList = require('../services/adminBusinessList.service');
const { successResponse } = require('../utils/response');
const { toCsv } = require('../utils/csv');
const { fetchAllPages } = require('../utils/fetchAllPages');
const logger = require('../utils/logger');

const CSV_COLUMNS = [
  { key: 'name', header: 'Business' },
  { key: 'category', header: 'Category' },
  { key: 'categoryDetail', header: 'Category detail' },
  { key: 'ownerName', header: 'Owner' },
  { key: 'ownerEmail', header: 'Owner email' },
  { key: 'ownerPhone', header: 'Owner phone' },
  { key: 'city', header: 'City' },
  { key: 'whatsappNumber', header: 'WhatsApp number' },
  { key: 'connected', header: 'WhatsApp connected' },
  { key: 'plan', header: 'Plan' },
  { key: 'subscriptionStatus', header: 'Status' },
  { key: 'active', header: 'Active' },
  { key: 'createdAt', header: 'Created' }
];

const yesNo = (v) => (v ? 'yes' : 'no');

/**
 * GET /api/admin/businesses/category-summary
 * How many businesses are in each category (all businesses, active or not), biggest first. A category
 * value missing from business_categories is listed under its raw value.
 */
const categorySummary = async (req, res, next) => {
  try {
    const [rows, categories] = await Promise.all([
      fetchAllPages((from, to) => supabase.from('businesses').select('business_category').order('id').range(from, to)),
      businessCategoryService.getAllCategories()
    ]);
    const labels = Object.fromEntries(categories.map((c) => [c.value, c.label]));
    const counts = {};
    for (const r of rows) counts[r.business_category] = (counts[r.business_category] || 0) + 1;
    const list = Object.entries(counts)
      .map(([value, count]) => ({ value, label: labels[value] || value, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return successResponse(res, 200, { total: rows.length, categories: list });
  } catch (error) {
    logger.error('Error in categorySummary:', error);
    next(error);
  }
};

/** What the Category column cannot say: the typed-in category for 'general', the sub-categories for 'multi_brand'. */
const categoryDetail = (b, labels) => {
  if (b.business_category === 'general') return b.requested_category_text || null;
  if (b.business_category === 'multi_brand') {
    return (b.sub_categories || []).map((v) => labels[v] || v).join('; ') || null;
  }
  return null;
};

const toExportRow = (b, ctx) => {
  const owner = ctx.owners[b.owner_user_id];
  const sub = ctx.subscriptions[b.id];
  return {
    name: b.name,
    category: ctx.labels[b.business_category] || b.business_category,
    categoryDetail: categoryDetail(b, ctx.labels),
    ownerName: owner ? owner.name : null,
    ownerEmail: owner ? owner.email : null,
    ownerPhone: owner ? owner.phone : null,
    city: b.city,
    whatsappNumber: b.whatsapp_number,
    connected: yesNo(b.is_whatsapp_connected),
    plan: sub && sub.plan ? sub.plan.displayName || sub.plan.name : null,
    subscriptionStatus: sub ? sub.status : null,
    active: yesNo(b.is_active),
    createdAt: b.created_at
  };
};

/** GET /api/admin/businesses/export.csv - same filters as the list, all rows; logs who exported what. */
const exportBusinessesCsv = async (req, res, next) => {
  try {
    const filters = adminBusinessList.parseBusinessFilters(req.query);
    const apply = await adminBusinessList.buildBusinessFilter(filters);
    const rows = await fetchAllPages((from, to) => apply(supabase.from('businesses')
      .select('id, name, business_category, requested_category_text, sub_categories, owner_user_id, city, whatsapp_number, is_whatsapp_connected, is_active, created_at'))
      .order('created_at', { ascending: false }).order('id').range(from, to));
    const [owners, subscriptions, categories] = await Promise.all([
      adminBusinessList.loadOwners(rows),
      adminBusinessList.loadCurrentSubscriptions(rows.map((b) => b.id)),
      businessCategoryService.getAllCategories()
    ]);
    const ctx = { owners, subscriptions, labels: Object.fromEntries(categories.map((c) => [c.value, c.label])) };
    logger.info(`[admin-export] businesses: user=${req.user.userId} filters=${JSON.stringify(filters)} rows=${rows.length}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="businesses.csv"');
    return res.status(200).send(toCsv(CSV_COLUMNS, rows.map((b) => toExportRow(b, ctx))));
  } catch (error) {
    logger.error('Error in exportBusinessesCsv:', error);
    next(error);
  }
};

module.exports = { categorySummary, exportBusinessesCsv };
