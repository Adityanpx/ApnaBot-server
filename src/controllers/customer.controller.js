const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const logger = require('../utils/logger');

const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;

// A booking only counts toward VIP status (either criteria) once it actually
// went through — cancelled/pending bookings aren't "business done" with this
// customer. Confirmed with the user rather than guessed.
const BOOKING_STATUSES_FOR_VIP = ['confirmed', 'completed'];

// Manual-override values for updateCustomer's pipelineStage — always allowed
// regardless of the current stage. This is the explicit human action that
// customerPipeline.service.js's rank guard exists to defer to, so no
// forward-only check applies here.
const PIPELINE_STAGES = ['new', 'contacted', 'converted', 'lost'];

// windowExpiresAt is derived, not stored — recomputed at read time from last_message_at
const withWindowExpiresAt = (customer) => ({
  ...customer,
  windowExpiresAt: customer.lastMessageAt
    ? new Date(new Date(customer.lastMessageAt).getTime() + WINDOW_DURATION_MS).toISOString()
    : null
});

// Mirrors broadcast.controller.js's exact send-audience filter
// (opted_in=true AND is_blocked=false) — kept in one place so the two can't
// drift apart. Takes a raw (snake_case) customer row.
const isBroadcastEligible = (customer) => customer.opted_in === true && customer.is_blocked !== true;

const buildBookingStatsByCustomer = (bookingRows) => {
  const stats = {};
  for (const row of bookingRows || []) {
    const stat = stats[row.customer_id] || { count: 0, spend: 0 };
    stat.count += 1;
    stat.spend += Number(row.fare_amount) || 0;
    stats[row.customer_id] = stat;
  }
  return stats;
};

// isVip is never stored — always computed live against the business's
// current vip_enabled/vip_criteria/vip_threshold. Uses fare_amount (the
// booking's actual value) for 'spend', not payment_amount (which is only the
// advance-payment-due amount and is 0/unset for most bookings).
const computeIsVip = (business, stat) => {
  if (!business?.vipEnabled || !business.vipCriteria || business.vipThreshold === null || business.vipThreshold === undefined) {
    return false;
  }
  const value = business.vipCriteria === 'spend' ? stat.spend : stat.count;
  return value >= business.vipThreshold;
};

/**
 * GET /api/customers
 * List all customers for business — paginated + searchable by name or number.
 * Optional filters: isBlocked ('true'/'false'), optedIn ('true'/'false'),
 * broadcastEligible ('true'), isVip ('true').
 */
const getCustomers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, isBlocked, optedIn, broadcastEligible, isVip } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    // isVip depends on aggregated booking data, not a real column, so it
    // can't be a .eq() filter — we have to know every matching row's VIP
    // status before we can correctly slice a page. When it's requested we
    // fetch the full filtered set (no .range()) and paginate in memory
    // instead of at the query level.
    const filterVip = isVip === 'true';

    let query = supabase.from('customers').select('*', { count: 'exact' }).eq('business_id', businessId);

    if (search) {
      // PostgREST's .or() parses commas/parens as filter syntax — strip them
      // so the search term can't break out of these two conditions.
      const safeSearch = search.replace(/[,()%*]/g, '');
      query = query.or(`name.ilike.%${safeSearch}%,whatsapp_number.ilike.%${safeSearch}%`);
    }
    if (isBlocked !== undefined) {
      query = query.eq('is_blocked', isBlocked === 'true');
    }
    if (optedIn !== undefined) {
      query = query.eq('opted_in', optedIn === 'true');
    }
    if (broadcastEligible === 'true') {
      // Mirrors isBroadcastEligible() below — opted_in && !is_blocked are
      // both real columns, so this filters at the query level like isBlocked.
      query = query.eq('opted_in', true).eq('is_blocked', false);
    }

    query = query.order('last_message_at', { ascending: false });
    if (!filterVip) {
      query = query.range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const business = await businessService.getBusinessById(businessId);

    // One grouped query for just the fetched customer ids, not one query per row.
    let bookingStatsByCustomer = {};
    if (business?.vipEnabled && data && data.length > 0) {
      const customerIds = data.map((c) => c.id);
      const { data: bookingRows, error: bookingErr } = await supabase
        .from('bookings').select('customer_id, fare_amount')
        .eq('business_id', businessId).in('customer_id', customerIds).in('status', BOOKING_STATUSES_FOR_VIP);
      if (bookingErr) throw bookingErr;
      bookingStatsByCustomer = buildBookingStatsByCustomer(bookingRows);
    }

    let customers = (data || []).map((c) => withWindowExpiresAt({
      ...toCamelCase(c),
      isVip: computeIsVip(business, bookingStatsByCustomer[c.id] || { count: 0, spend: 0 }),
      broadcastEligible: isBroadcastEligible(c)
    }));

    let total = count || 0;
    if (filterVip) {
      customers = customers.filter((c) => c.isVip);
      total = customers.length;
      customers = customers.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    }

    const pagination = getPagination(total, pageNum, limitNum);
    return successResponse(res, 200, { customers, pagination });
  } catch (error) {
    logger.error('Error in getCustomers:', error);
    next(error);
  }
};

/**
 * GET /api/customers/summary
 * Aggregate counts (total/vip/optedIn/broadcastEligible) against the
 * business's FULL customer set — independent of whatever page/limit the
 * list view is currently using.
 */
const getCustomerSummary = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const [totalRes, optedInRes, broadcastEligibleRes] = await Promise.all([
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('opted_in', true),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('opted_in', true).eq('is_blocked', false)
    ]);
    if (totalRes.error) throw totalRes.error;
    if (optedInRes.error) throw optedInRes.error;
    if (broadcastEligibleRes.error) throw broadcastEligibleRes.error;

    const business = await businessService.getBusinessById(businessId);

    let vip = 0;
    if (business?.vipEnabled && business.vipCriteria && business.vipThreshold !== null && business.vipThreshold !== undefined) {
      const { data: bookingRows, error: bookingErr } = await supabase
        .from('bookings').select('customer_id, fare_amount')
        .eq('business_id', businessId).in('status', BOOKING_STATUSES_FOR_VIP);
      if (bookingErr) throw bookingErr;

      const statsByCustomer = buildBookingStatsByCustomer(bookingRows);
      vip = Object.values(statsByCustomer).filter((stat) => computeIsVip(business, stat)).length;
    }

    return successResponse(res, 200, {
      total: totalRes.count || 0,
      vip,
      optedIn: optedInRes.count || 0,
      broadcastEligible: broadcastEligibleRes.count || 0
    });
  } catch (error) {
    logger.error('Error in getCustomerSummary:', error);
    next(error);
  }
};

/**
 * GET /api/customers/:id
 * Customer detail + last 50 messages
 */
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: customer, error: custErr } = await supabase
      .from('customers').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (custErr) throw custErr;
    if (!customer) return errorResponse(res, 404, 'Customer not found');

    const { data: messages, error: msgErr } = await supabase
      .from('messages').select('*').eq('business_id', businessId).eq('customer_id', id)
      .order('created_at', { ascending: false }).limit(50);
    if (msgErr) throw msgErr;

    return successResponse(res, 200, {
      customer: withWindowExpiresAt(toCamelCase(customer)),
      messages: (messages || []).map(toCamelCase).reverse()
    });
  } catch (error) {
    logger.error('Error in getCustomerById:', error);
    next(error);
  }
};

/**
 * PUT /api/customers/:id
 * Update customer name, tags, notes, pipelineStage
 */
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, tags, notes, pipelineStage } = req.body;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');

    const updateData = {};
    if (name !== undefined) {
      if (name === null) {
        updateData.name = null;
      } else if (typeof name === 'string' && name.trim()) {
        updateData.name = name.trim();
      } else {
        return errorResponse(res, 400, 'name must be a non-empty string or null');
      }
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return errorResponse(res, 400, 'Tags must be an array');
      updateData.tags = tags.map(t => t.trim()).filter(Boolean);
    }
    if (notes !== undefined) updateData.notes = notes;
    if (pipelineStage !== undefined) {
      if (!PIPELINE_STAGES.includes(pipelineStage)) {
        return errorResponse(res, 400, `pipelineStage must be one of: ${PIPELINE_STAGES.join(', ')}`);
      }
      updateData.pipeline_stage = pipelineStage;
    }

    const { data: customer, error } = await supabase
      .from('customers').update(updateData).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(customer));
  } catch (error) {
    logger.error('Error in updateCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/block
 * Block customer — bot stops replying to them
 */
const blockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('is_blocked').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');
    if (existing.is_blocked) return errorResponse(res, 400, 'Customer is already blocked');

    const { data: customer, error } = await supabase
      .from('customers').update({ is_blocked: true }).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} blocked for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Customer blocked successfully');
  } catch (error) {
    logger.error('Error in blockCustomer:', error);
    next(error);
  }
};

/**
 * POST /api/customers/:id/unblock
 * Unblock a customer
 */
const unblockCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('is_blocked').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');
    if (!existing.is_blocked) return errorResponse(res, 400, 'Customer is not blocked');

    const { data: customer, error } = await supabase
      .from('customers').update({ is_blocked: false }).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} unblocked for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Customer unblocked successfully');
  } catch (error) {
    logger.error('Error in unblockCustomer:', error);
    next(error);
  }
};

const OPT_IN_SOURCES = ['customer_initiated', 'manual', 'website_form'];

/**
 * PATCH /api/customers/:id/opt-in
 * Set marketing opt-in status. 'customer_initiated' only proves consent for
 * service-window replies, not marketing — callers must not pass optedIn=true
 * with that source.
 */
const toggleCustomerOptIn = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { optedIn, source } = req.body;
    const businessId = req.user.businessId;

    if (typeof optedIn !== 'boolean') {
      return errorResponse(res, 400, 'optedIn must be a boolean');
    }
    if (!source || !OPT_IN_SOURCES.includes(source)) {
      return errorResponse(res, 400, `source must be one of: ${OPT_IN_SOURCES.join(', ')}`);
    }
    if (optedIn && source === 'customer_initiated') {
      return errorResponse(res, 400, 'customer_initiated only establishes service-window consent and cannot be used to set marketing opt-in to true');
    }

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');

    const { data: customer, error } = await supabase
      .from('customers').update({
        opted_in: optedIn,
        opted_in_at: optedIn ? new Date().toISOString() : null,
        opt_in_source: source
      }).eq('id', id).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} opt-in set to ${optedIn} (source: ${source}) for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Customer opt-in status updated');
  } catch (error) {
    logger.error('Error in toggleCustomerOptIn:', error);
    next(error);
  }
};

module.exports = {
  getCustomers,
  getCustomerSummary,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer,
  toggleCustomerOptIn,
  withWindowExpiresAt,
  isBroadcastEligible
};
