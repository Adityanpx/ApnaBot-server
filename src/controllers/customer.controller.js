const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const optInLinkService = require('../services/optInLink.service');
const contactGroupService = require('../services/contactGroup.service');
const { PIPELINE_STAGES, applyTagsAny, parseTagsParam } = require('../utils/customerFilters');
const logger = require('../utils/logger');

const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;
// PostgREST returns at most max_rows rows per request (1000 on the hosted
// project, measured 2026-10-04) and silently drops the rest — unbounded
// reads below go in pages of this size.
const PAGE = 1000;

// A booking only counts toward VIP status (either criteria) once it actually
// went through — cancelled/pending bookings aren't "business done" with this
// customer. Confirmed with the user rather than guessed.
const BOOKING_STATUSES_FOR_VIP = ['confirmed', 'completed'];

// PIPELINE_STAGES (utils/customerFilters.js): manual-override values for
// updateCustomer's pipelineStage — always allowed regardless of the current
// stage. This is the explicit human action that customerPipeline.service.js's
// rank guard exists to defer to, so no forward-only check applies here.

// windowExpiresAt is derived, not stored — recomputed at read time from last_message_at
const withWindowExpiresAt = (customer) => ({
  ...customer,
  windowExpiresAt: customer.lastMessageAt
    ? new Date(new Date(customer.lastMessageAt).getTime() + WINDOW_DURATION_MS).toISOString()
    : null
});

// Mirrors broadcastAudience.service.js#resolveAudience's MARKETING send-audience
// filter (opted_in=true AND marketing_blocked_at IS NULL AND is_blocked=false AND
// opted_out_at IS NULL). It has no template, so it stays marketing-strict: a
// UTILITY broadcast also reaches
// customers this flag calls ineligible (resolveAudience drops opted_in for
// UTILITY, see requiresMarketingOptIn). Takes a raw (snake_case) customer row.
const isBroadcastEligible = (customer) =>
  customer.opted_in === true && customer.is_blocked !== true && !customer.opted_out_at && !customer.marketing_blocked_at;

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

// One grouped query for just the given customer ids, not one query per row.
// Counted/summed in Postgres (customer_booking_stats) rather than fetching
// booking rows — an un-ranged select silently caps at PostgREST's 1000-row
// max_rows, and heavy repeat customers are exactly the VIP case. The RPC's
// own result (one row per customer) is capped the same way, so ids go in
// chunks of PAGE.
const fetchBookingStatsByCustomer = async (businessId, customerIds) => {
  const stats = {};
  for (let i = 0; i < customerIds.length; i += PAGE) {
    const { data, error } = await supabase.rpc('customer_booking_stats', {
      p_business_id: businessId,
      p_customer_ids: customerIds.slice(i, i + PAGE),
      p_statuses: BOOKING_STATUSES_FOR_VIP
    });
    if (error) throw error;
    for (const row of data || []) {
      stats[row.customer_id] = { count: Number(row.booking_count), spend: Number(row.spend) };
    }
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
 * Filters of GET /api/customers and GET /api/customers/ids from a request's
 * query string → { filters } or { error } (a message for a 400).
 */
const parseCustomerFilters = (query) => {
  const { search, isBlocked, optedIn, broadcastEligible, isVip, pipelineStage, neverMessaged, groupId } = query;
  if (pipelineStage !== undefined && !PIPELINE_STAGES.includes(pipelineStage)) {
    return { error: `pipelineStage must be one of: ${PIPELINE_STAGES.join(', ')}` };
  }
  if (groupId !== undefined && !contactGroupService.isUuid(groupId)) {
    return { error: 'groupId must be a group id' };
  }
  const parsedTags = parseTagsParam(query.tags);
  if (parsedTags.error) return { error: parsedTags.error };
  return { filters: { search, isBlocked, optedIn, broadcastEligible, isVip, pipelineStage, neverMessaged, groupId, tags: parsedTags.tags } };
};

/**
 * A fresh customers query for these filters (parseCustomerFilters), newest
 * inbound first. `columns` is what to select; `options` go to select() (an
 * exact count by default). Everything but isVip is applied here — isVip
 * depends on aggregated booking data, so callers handle it.
 */
const buildCustomerQuery = (businessId, filters, columns = '*', options = { count: 'exact' }) => {
  const { search, isBlocked, optedIn, broadcastEligible, pipelineStage, neverMessaged, groupId, tags } = filters;
  // groupId: an inner embed keeps only customers with a membership in
  // that group (customers are already this business's, so a foreign
  // group id simply matches nobody). The embed is dropped from the rows by the caller.
  let query = supabase.from('customers')
    .select(groupId !== undefined ? `${columns}, contact_group_members!inner(group_id)` : columns, options)
    .eq('business_id', businessId);
  if (groupId !== undefined) {
    query = query.eq('contact_group_members.group_id', groupId);
  }

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
    // Mirrors isBroadcastEligible() above — opted_in, marketing_blocked_at,
    // is_blocked and opted_out_at are all real columns, so this filters at the
    // query level like isBlocked.
    query = query.eq('opted_in', true).is('marketing_blocked_at', null).eq('is_blocked', false).is('opted_out_at', null);
  }
  if (pipelineStage !== undefined) {
    query = query.eq('pipeline_stage', pipelineStage);
  }
  if (neverMessaged === 'true') {
    query = query.is('last_message_at', null);
  }
  // Customers with ANY of these tags (exact match); a no-op for none.
  query = applyTagsAny(query, tags);

  // nullsFirst: false — imported contacts who never messaged go last,
  // not first (Postgres puts NULLs first in a descending sort).
  return query.order('last_message_at', { ascending: false, nullsFirst: false });
};

/**
 * GET /api/customers
 * List all customers for business — paginated + searchable by name or number.
 * Optional filters: isBlocked ('true'/'false'), optedIn ('true'/'false'),
 * broadcastEligible ('true'), isVip ('true'), pipelineStage
 * ('new'/'contacted'/'converted'/'lost'), neverMessaged ('true' — imported
 * contacts who haven't messaged yet, last_message_at null), groupId (members
 * of one customer group), tags (customers with ANY of these exact tags:
 * ?tags=a&tags=b or ?tags=a,b). Each row carries groups: [{ id, name }].
 * Customers who never messaged sort last.
 */
const getCustomers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    // isVip depends on aggregated booking data, not a real column, so it
    // can't be a .eq() filter — we have to know every matching row's VIP
    // status before we can correctly slice a page. When it's requested we
    // fetch the full filtered set (no .range()) and paginate in memory
    // instead of at the query level.
    const filterVip = req.query.isVip === 'true';

    const parsed = parseCustomerFilters(req.query);
    if (parsed.error) return errorResponse(res, 400, parsed.error);

    // A fresh query per call — the VIP path below reads it page by page.
    const buildQuery = () => buildCustomerQuery(businessId, parsed.filters);

    let data;
    let count;
    if (filterVip) {
      // Every matching row, paged past the 1000-row cap; id breaks
      // last_message_at ties so pages don't overlap.
      data = [];
      for (let from = 0; ; from += PAGE) {
        const { data: rows, error } = await buildQuery().order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (error) throw error;
        data.push(...(rows || []));
        if (!rows || rows.length < PAGE) break;
      }
    } else {
      const result = await buildQuery().range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
      if (result.error) throw result.error;
      data = result.data;
      count = result.count;
    }

    const business = await businessService.getBusinessById(businessId);

    let bookingStatsByCustomer = {};
    if (business?.vipEnabled && data && data.length > 0) {
      bookingStatsByCustomer = await fetchBookingStatsByCustomer(businessId, data.map((c) => c.id));
    }

    // "Opted in via <link name>" — a second query rather than a PostgREST
    // embed: opt_in_link_events also links customers to opt_in_links, which
    // would make the embed ambiguous.
    const linkNames = await optInLinkService.fetchLinkNames(businessId, (data || []).map((c) => c.opt_in_link_id));

    let customers = (data || []).map(({ contact_group_members: _membership, ...c }) => withWindowExpiresAt({
      ...toCamelCase(c),
      isVip: computeIsVip(business, bookingStatsByCustomer[c.id] || { count: 0, spend: 0 }),
      broadcastEligible: isBroadcastEligible(c),
      optInLinkName: linkNames.get(c.opt_in_link_id) || null
    }));

    let total = count || 0;
    if (filterVip) {
      customers = customers.filter((c) => c.isVip);
      total = customers.length;
      customers = customers.slice((pageNum - 1) * limitNum, pageNum * limitNum);
    }

    // Group names for just the rows on this page.
    const groups = await contactGroupService.groupsByCustomer(businessId, customers.map((c) => c.id));
    customers = customers.map((c) => ({ ...c, groups: groups.get(c.id) || [] }));

    const pagination = getPagination(total, pageNum, limitNum);
    return successResponse(res, 200, { customers, pagination });
  } catch (error) {
    logger.error('Error in getCustomers:', error);
    next(error);
  }
};

// Most customer ids GET /api/customers/ids returns (the broadcast picker's
// 'customers' audience takes at most this many).
const MAX_CUSTOMER_IDS = 2000;

/**
 * GET /api/customers/ids?<same filters as the list>
 * The ids of every customer matching the filters, in the list's order, for
 * "select all N matching" in the broadcast picker. At most MAX_CUSTOMER_IDS
 * ids come back: { ids, total, truncated } where total is how many match and
 * truncated says ids is only the first MAX_CUSTOMER_IDS of them.
 */
const getCustomerIds = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const parsed = parseCustomerFilters(req.query);
    if (parsed.error) return errorResponse(res, 400, parsed.error);

    let ids;
    let total;
    if (req.query.isVip === 'true') {
      // VIP depends on bookings, so — like the list — read every matching
      // customer (paged past the 1000-row cap), then keep the VIPs.
      const business = await businessService.getBusinessById(businessId);
      const all = [];
      if (business?.vipEnabled) {
        for (let from = 0; ; from += PAGE) {
          const { data: rows, error } = await buildCustomerQuery(businessId, parsed.filters, 'id', {})
            .order('id', { ascending: true }).range(from, from + PAGE - 1);
          if (error) throw error;
          all.push(...(rows || []).map((r) => r.id));
          if (!rows || rows.length < PAGE) break;
        }
      }
      const stats = all.length > 0 ? await fetchBookingStatsByCustomer(businessId, all) : {};
      const vipIds = all.filter((id) => computeIsVip(business, stats[id] || { count: 0, spend: 0 }));
      total = vipIds.length;
      ids = vipIds.slice(0, MAX_CUSTOMER_IDS);
    } else {
      // Read in pages of PAGE (PostgREST caps one response at 1000 rows and
      // silently drops the rest). id breaks last_message_at ties so pages
      // never overlap and the same filters always give the same ids.
      ids = [];
      total = 0;
      for (let from = 0; from < MAX_CUSTOMER_IDS; from += PAGE) {
        const to = Math.min(from + PAGE, MAX_CUSTOMER_IDS) - 1;
        const { data: rows, count, error } = await buildCustomerQuery(businessId, parsed.filters, 'id')
          .order('id', { ascending: true }).range(from, to);
        if (error) throw error;
        if (from === 0) total = count || 0;
        ids.push(...(rows || []).map((r) => r.id));
        if (!rows || rows.length < to - from + 1) break;
      }
    }

    return successResponse(res, 200, { ids, total, truncated: total > ids.length });
  } catch (error) {
    logger.error('Error in getCustomerIds:', error);
    next(error);
  }
};

/**
 * GET /api/customers/tags
 * Every distinct tag on this business's customers, A→Z — for the tag picker.
 */
const getCustomerTags = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const tags = new Set();
    for (let from = 0; ; from += PAGE) {
      const { data: rows, error } = await supabase.from('customers').select('id, tags')
        .eq('business_id', businessId).not('tags', 'eq', '[]')
        .order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw error;
      for (const row of rows || []) {
        for (const tag of Array.isArray(row.tags) ? row.tags : []) {
          if (typeof tag === 'string' && tag.trim()) tags.add(tag);
        }
      }
      if (!rows || rows.length < PAGE) break;
    }
    return successResponse(res, 200, { tags: [...tags].sort((a, b) => a.localeCompare(b)) });
  } catch (error) {
    logger.error('Error in getCustomerTags:', error);
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

    const [totalRes, optedInRes, broadcastEligibleRes, consentAskedRes, consentYesRes, consentNoRes] = await Promise.all([
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('opted_in', true),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('opted_in', true).is('marketing_blocked_at', null).eq('is_blocked', false).is('opted_out_at', null),
      // Post-booking consent question (services/bookingConsent.service.js), all time.
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).not('consent_prompted_at', 'is', null),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('consent_prompt_result', 'yes'),
      supabase.from('customers').select('*', { count: 'exact', head: true }).eq('business_id', businessId).eq('consent_prompt_result', 'no')
    ]);
    if (totalRes.error) throw totalRes.error;
    if (optedInRes.error) throw optedInRes.error;
    if (broadcastEligibleRes.error) throw broadcastEligibleRes.error;
    if (consentAskedRes.error) throw consentAskedRes.error;
    if (consentYesRes.error) throw consentYesRes.error;
    if (consentNoRes.error) throw consentNoRes.error;

    const business = await businessService.getBusinessById(businessId);

    let vip = 0;
    if (business?.vipEnabled && business.vipCriteria && business.vipThreshold !== null && business.vipThreshold !== undefined) {
      // Paged past the 1000-row cap — a capped read would undercount VIPs.
      const bookingRows = [];
      for (let from = 0; ; from += PAGE) {
        const { data: rows, error: bookingErr } = await supabase
          .from('bookings').select('customer_id, fare_amount')
          .eq('business_id', businessId).in('status', BOOKING_STATUSES_FOR_VIP)
          .order('id', { ascending: true }).range(from, from + PAGE - 1);
        if (bookingErr) throw bookingErr;
        bookingRows.push(...(rows || []));
        if (!rows || rows.length < PAGE) break;
      }

      const statsByCustomer = buildBookingStatsByCustomer(bookingRows);
      vip = Object.values(statsByCustomer).filter((stat) => computeIsVip(business, stat)).length;
    }

    return successResponse(res, 200, {
      total: totalRes.count || 0,
      vip,
      optedIn: optedInRes.count || 0,
      broadcastEligible: broadcastEligibleRes.count || 0,
      consentAsked: consentAskedRes.count || 0,
      consentYes: consentYesRes.count || 0,
      consentNo: consentNoRes.count || 0
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

    const business = await businessService.getBusinessById(businessId);
    const bookingStatsByCustomer = business?.vipEnabled
      ? await fetchBookingStatsByCustomer(businessId, [customer.id])
      : {};
    const linkNames = await optInLinkService.fetchLinkNames(businessId, [customer.opt_in_link_id]);
    const groups = await contactGroupService.groupsByCustomer(businessId, [customer.id]);

    return successResponse(res, 200, {
      customer: withWindowExpiresAt({
        ...toCamelCase(customer),
        isVip: computeIsVip(business, bookingStatsByCustomer[customer.id] || { count: 0, spend: 0 }),
        broadcastEligible: isBroadcastEligible(customer),
        optInLinkName: linkNames.get(customer.opt_in_link_id) || null,
        groups: groups.get(customer.id) || []
      }),
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

/**
 * POST /api/customers/:id/resume-marketing
 * The owner lifts a stopped-marketing flag (Meta 131050 / the customer's own
 * choice in WhatsApp) - e.g. the customer told them they want offers again.
 * Meta may still refuse a marketing message if the customer has not resumed on
 * their side; the flag is set again by the next 131050.
 */
const resumeMarketing = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('customers').select('marketing_blocked_at').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Customer not found');
    if (!existing.marketing_blocked_at) return errorResponse(res, 400, 'Customer has not stopped marketing messages');

    const { data: customer, error } = await supabase
      .from('customers').update({ marketing_blocked_at: null }).eq('id', id).eq('business_id', businessId).select().single();
    if (error) throw error;

    logger.info(`Customer ${id} marketing messages resumed by the owner for business ${businessId}`);
    return successResponse(res, 200, toCamelCase(customer), 'Marketing messages resumed');
  } catch (error) {
    logger.error('Error in resumeMarketing:', error);
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
        opt_in_source: source,
        // A manual toggle replaces whatever link the customer opted in through.
        opt_in_link_id: null
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
  getCustomerIds,
  getCustomerTags,
  MAX_CUSTOMER_IDS,
  getCustomerSummary,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer,
  resumeMarketing,
  toggleCustomerOptIn,
  withWindowExpiresAt,
  isBroadcastEligible
};
