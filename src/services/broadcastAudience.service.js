// Who a broadcast goes to (broadcasts.audience_filter / audience_params,
// 20261002140000_broadcast_audiences.sql, 20261004120000_contact_import_groups.sql,
// 20261007120000_broadcast_audience_builder.sql). One function used by both the
// recipients preview and the send (broadcast.controller.js), so the count an
// owner sees is exactly who gets the message.
//
//   all_customers      every opted-in, non-blocked customer who hasn't sent
//                      STOP (customers.opted_out_at, cleared by START)
//   coaching_requests  those of them with a matching Free demo / Admission
//                      request (bookings.form_key), optionally for one
//                      course (bookings.fields.course), optionally skipping
//                      requests marked cancelled ("Not interested" /
//                      "Not joining"). A parent with several requests counts once.
//   groups             those of them in any of the chosen customer groups
//                      (contact_groups, 20261004120000_contact_import_groups.sql);
//                      only this business's groups count. A customer in
//                      several of the groups counts once.
//   customers          those of them among the chosen customers (up to
//                      MAX_CUSTOMER_IDS ids; only this business's customers count).
//   segment            those of them matching ALL the filters given: any of
//                      the tags (exact), any of the pipeline stages, a
//                      last_message_at within N days, never messaged.
//
// Every audience, whatever its type, also drops customers whose
// whatsapp_number isn't 8-15 digits (hasValidNumber) — Meta would refuse them.
//
// "Opted-in" above is the MARKETING rule. A UTILITY template (payment reminder,
// booking update …) doesn't need marketing consent, so for it opted_in is not
// required — opted_out_at, is_blocked and the number check still apply. The
// template's category is read from the stored message_templates row by the
// caller (never the request body) and passed as `category`; anything that isn't
// UTILITY, including no category at all, keeps the marketing rule
// (requiresMarketingOptIn).
//
// The same rules exist in SQL (broadcast_audience, 20261007120000) for the
// summary / skipped list: that function says WHY a selected customer is
// skipped. resolveAudience stays the send path; scripts/checkAudienceParity.js
// compares the two against a real business.
const supabase = require('../config/supabase');
const { PIPELINE_STAGES, normalizeTags, applyTagsAny } = require('../utils/customerFilters');

const AUDIENCE_FILTERS = ['all_customers', 'coaching_requests', 'groups', 'customers', 'segment'];
const MAX_GROUPS = 20;
const MAX_CUSTOMER_IDS = 2000;
const MAX_ACTIVE_WITHIN_DAYS = 3650;
const SEGMENT_KEYS = ['tags', 'pipelineStages', 'activeWithinDays', 'neverMessaged'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORM_CHOICES = ['demo', 'admission', 'any'];
const DAY_MS = 24 * 60 * 60 * 1000;
// Why a selected customer is skipped, in the order they are checked
// (broadcast_audience in SQL uses the same order).
const SKIP_REASONS = ['no_number', 'blocked', 'opted_out', 'not_opted_in'];
const VALID_NUMBER = /^[0-9]{8,15}$/;
// Ids per `in (...)` filter. The URL has a hard ceiling — measured on the
// hosted project 2026-10-07: 350 UUIDs work, 400 fail ("fetch failed") — so
// this stays well under it (200 ≈ 7.5 KB).
const ID_CHUNK = 200;
// PostgREST returns at most max_rows rows per request (1000 on the hosted
// project, measured 2026-10-04) and silently drops the rest, so every
// unbounded select here is read in pages of this size.
const PAGE = 1000;

const hasValidNumber = (number) => typeof number === 'string' && VALID_NUMBER.test(number);

/**
 * Whether a broadcast with a template of this category needs customers.opted_in.
 * False ONLY for UTILITY (case-insensitive); MARKETING, AUTHENTICATION, an
 * unknown category or none all keep the strict marketing rule.
 */
const requiresMarketingOptIn = (category) => !(typeof category === 'string' && category.trim().toLowerCase() === 'utility');

/**
 * The stored category of one of this business's templates, or null when no id
 * was given or it isn't this business's template (callers then apply the strict
 * marketing rule). Never trusts a category from the request.
 */
const templateCategory = async (businessId, templateId) => {
  if (typeof templateId !== 'string' || !UUID_PATTERN.test(templateId)) return null;
  const { data, error } = await supabase
    .from('message_templates').select('category').eq('id', templateId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data ? data.category : null;
};

/**
 * Every row of a query, paged past the max_rows cap. `build` returns a fresh
 * query each call, ordered by a unique column so pages never overlap.
 */
const fetchAllPages = async (build) => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
};

/** Validated, de-duplicated uuid list (1..max) or { error }. */
const normalizeIdList = (input, { field, noun, max }) => {
  if (!Array.isArray(input) || input.length === 0) return { error: `audienceParams.${field} must list at least one ${noun}` };
  const ids = [...new Set(input)];
  if (!ids.every(id => typeof id === 'string' && UUID_PATTERN.test(id))) return { error: `audienceParams.${field} must be ${noun} ids` };
  if (ids.length > max) return { error: `audienceParams.${field} can list at most ${max} ${noun}s` };
  return { ids };
};

/** The segment part of normalizeAudience → { params } or { error }. */
const normalizeSegment = (p) => {
  const unknown = Object.keys(p).filter(k => !SEGMENT_KEYS.includes(k));
  if (unknown.length > 0) return { error: `audienceParams.${unknown[0]} isn't a segment filter (use: ${SEGMENT_KEYS.join(', ')})` };
  const params = {};
  if (p.tags !== undefined && p.tags !== null) {
    const t = normalizeTags(p.tags, 'audienceParams.tags');
    if (t.error) return t;
    if (t.tags.length > 0) params.tags = t.tags;
  }
  if (p.pipelineStages !== undefined && p.pipelineStages !== null) {
    if (!Array.isArray(p.pipelineStages) || !p.pipelineStages.every(s => PIPELINE_STAGES.includes(s))) {
      return { error: `audienceParams.pipelineStages must be a list of: ${PIPELINE_STAGES.join(', ')}` };
    }
    if (p.pipelineStages.length > 0) params.pipelineStages = [...new Set(p.pipelineStages)];
  }
  if (p.activeWithinDays !== undefined && p.activeWithinDays !== null) {
    if (!Number.isInteger(p.activeWithinDays) || p.activeWithinDays < 1 || p.activeWithinDays > MAX_ACTIVE_WITHIN_DAYS) {
      return { error: `audienceParams.activeWithinDays must be a whole number of days from 1 to ${MAX_ACTIVE_WITHIN_DAYS}` };
    }
    params.activeWithinDays = p.activeWithinDays;
  }
  if (p.neverMessaged !== undefined && p.neverMessaged !== null) {
    if (typeof p.neverMessaged !== 'boolean') return { error: 'audienceParams.neverMessaged must be true or false' };
    if (p.neverMessaged) params.neverMessaged = true;
  }
  if (Object.keys(params).length === 0) return { error: 'A segment needs at least one filter (tags, pipelineStages, activeWithinDays or neverMessaged)' };
  if (params.activeWithinDays !== undefined && params.neverMessaged) {
    return { error: 'activeWithinDays and neverMessaged can\'t be combined — nobody has messaged recently and never messaged' };
  }
  return { params };
};

/**
 * Checks and normalizes an audience from a request body.
 * @returns {{ filter: string, params: Object|null }|{ error: string }}
 */
const normalizeAudience = (audienceFilter, audienceParams) => {
  const filter = audienceFilter === undefined || audienceFilter === null ? 'all_customers' : audienceFilter;
  if (!AUDIENCE_FILTERS.includes(filter)) return { error: `audienceFilter must be one of: ${AUDIENCE_FILTERS.join(', ')}` };
  if (filter === 'all_customers') return { filter, params: null };
  const p = audienceParams || {};
  if (typeof p !== 'object' || Array.isArray(p)) return { error: 'audienceParams must be an object' };
  if (filter === 'groups') {
    const r = normalizeIdList(p.groupIds, { field: 'groupIds', noun: 'group', max: MAX_GROUPS });
    return r.error ? r : { filter, params: { groupIds: r.ids } };
  }
  if (filter === 'customers') {
    const r = normalizeIdList(p.customerIds, { field: 'customerIds', noun: 'customer', max: MAX_CUSTOMER_IDS });
    return r.error ? r : { filter, params: { customerIds: r.ids } };
  }
  if (filter === 'segment') {
    const r = normalizeSegment(p);
    return r.error ? r : { filter, params: r.params };
  }
  const form = p.form === undefined ? 'any' : p.form;
  if (!FORM_CHOICES.includes(form)) return { error: `audienceParams.form must be one of: ${FORM_CHOICES.join(', ')}` };
  if (p.course !== undefined && p.course !== null && typeof p.course !== 'string') return { error: 'audienceParams.course must be text' };
  if (p.skipClosed !== undefined && typeof p.skipClosed !== 'boolean') return { error: 'audienceParams.skipClosed must be true or false' };
  return {
    filter,
    params: {
      form,
      course: typeof p.course === 'string' && p.course.trim() ? p.course.trim() : null,
      skipClosed: p.skipClosed === undefined ? true : p.skipClosed
    }
  };
};

/** Ids of customers with a matching Free demo / Admission request. */
const requestCustomerIds = async (businessId, params) => {
  const rows = await fetchAllPages(() => {
    let query = supabase.from('bookings').select('customer_id').eq('business_id', businessId)
      .in('form_key', params.form === 'any' ? ['demo', 'admission'] : [params.form]);
    if (params.course) query = query.eq('fields->>course', params.course);
    if (params.skipClosed) query = query.neq('status', 'cancelled');
    return query.order('id', { ascending: true });
  });
  return [...new Set(rows.map(r => r.customer_id).filter(Boolean))];
};

/** Which of these group ids are this business's groups. */
const businessGroupIds = async (businessId, groupIds) => {
  if (!groupIds || groupIds.length === 0) return [];
  const { data, error } = await supabase
    .from('contact_groups').select('id').eq('business_id', businessId).in('id', groupIds);
  if (error) throw error;
  return (data || []).map(r => r.id);
};

/** Which of these customer ids are customers of this business. */
const businessCustomerIds = async (businessId, customerIds) => {
  const found = [];
  for (let i = 0; i < (customerIds || []).length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('customers').select('id').eq('business_id', businessId).in('id', customerIds.slice(i, i + ID_CHUNK));
    if (error) throw error;
    found.push(...(data || []).map(r => r.id));
  }
  return found;
};

/** Ids of customers in any of these groups (of this business only). */
const groupCustomerIds = async (businessId, params) => {
  const groupIds = await businessGroupIds(businessId, (params && params.groupIds) || []);
  if (groupIds.length === 0) return [];
  const rows = await fetchAllPages(() => supabase.from('contact_group_members').select('customer_id')
    .in('group_id', groupIds)
    .order('customer_id', { ascending: true }).order('group_id', { ascending: true }));
  return [...new Set(rows.map(r => r.customer_id))];
};

/** `query` (customers) narrowed by a segment's filters — all of them must hold. */
const applySegment = (query, params, now = Date.now()) => {
  let q = applyTagsAny(query, params.tags);
  if (params.pipelineStages && params.pipelineStages.length > 0) q = q.in('pipeline_stage', params.pipelineStages);
  if (params.activeWithinDays) q = q.gte('last_message_at', new Date(now - params.activeWithinDays * DAY_MS).toISOString());
  if (params.neverMessaged) q = q.is('last_message_at', null);
  return q;
};

/**
 * The non-blocked, not-opted-out customers with a valid number that a
 * broadcast with this audience reaches — opted-in ones only, unless the
 * template's `category` is UTILITY (requiresMarketingOptIn).
 * @returns {Promise<{ id, whatsapp_number, name }[]>}
 */
const resolveAudience = async (businessId, filter, params, { category = null } = {}) => {
  const base = () => {
    const query = supabase.from('customers').select('id, whatsapp_number, name').eq('business_id', businessId);
    return (requiresMarketingOptIn(category) ? query.eq('opted_in', true) : query).eq('is_blocked', false).is('opted_out_at', null);
  };
  let customers = [];
  if (filter === 'segment') {
    customers = await fetchAllPages(() => applySegment(base(), params || {}).order('id', { ascending: true }));
  } else if (filter !== 'coaching_requests' && filter !== 'groups' && filter !== 'customers') {
    customers = await fetchAllPages(() => base().order('id', { ascending: true }));
  } else {
    let ids;
    if (filter === 'groups') ids = await groupCustomerIds(businessId, params);
    else if (filter === 'customers') ids = [...new Set((params && params.customerIds) || [])];
    else ids = await requestCustomerIds(businessId, params || { form: 'any', course: null, skipClosed: true });
    // ID_CHUNK ids per request — under the 1000-row cap, so no paging here.
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await base().in('id', ids.slice(i, i + ID_CHUNK));
      if (error) throw error;
      customers.push(...(data || []));
    }
  }
  return customers.filter(c => hasValidNumber(c.whatsapp_number));
};

// ── Summary + skipped list (SQL: broadcast_audience / broadcast_audience_summary) ──

/** 919876543210 → 91******3210 — enough to recognise a number, not to copy it. */
const maskNumber = (number) => {
  const s = String(number === null || number === undefined ? '' : number);
  return s.length <= 6 ? '*'.repeat(s.length) : `${s.slice(0, 2)}${'*'.repeat(s.length - 6)}${s.slice(-4)}`;
};

/**
 * How many customers an audience selects, how many of them will receive the
 * broadcast and how many are skipped, by reason. `category` is the template's
 * stored category (UTILITY never skips anyone for not_opted_in).
 * @returns {Promise<{ selected: number, willReceive: number, skipped: Object<string, number> }>}
 */
const audienceSummary = async (businessId, filter, params, { category = null } = {}) => {
  const { data, error } = await supabase.rpc('broadcast_audience_summary', {
    p_business_id: businessId, p_filter: filter, p_params: params || {}, p_require_opt_in: requiresMarketingOptIn(category)
  });
  if (error) throw error;
  const skipped = {};
  for (const reason of SKIP_REASONS) skipped[reason] = Number((data && data.skipped && data.skipped[reason]) || 0);
  return { selected: Number((data && data.selected) || 0), willReceive: Number((data && data.willReceive) || 0), skipped };
};

/**
 * One page of the selected-but-skipped customers (name A→Z, then id), optionally
 * for one reason. Numbers are masked. `category` as for audienceSummary.
 * @returns {Promise<{ items: { customerId, name, number, reason }[], total: number }>}
 */
const audienceSkipped = async (businessId, filter, params, { reason = null, page = 1, limit = 50, category = null } = {}) => {
  let query = supabase.rpc('broadcast_audience', {
    p_business_id: businessId, p_filter: filter, p_params: params || {}, p_require_opt_in: requiresMarketingOptIn(category)
  }, { count: 'exact' });
  query = reason ? query.eq('skip_reason', reason) : query.not('skip_reason', 'is', null);
  const from = (page - 1) * limit;
  const { data, count, error } = await query
    .order('name', { ascending: true, nullsFirst: false })
    .order('customer_id', { ascending: true })
    .range(from, from + limit - 1);
  if (error) throw error;
  return {
    items: (data || []).map(r => ({ customerId: r.customer_id, name: r.name, number: maskNumber(r.whatsapp_number), reason: r.skip_reason })),
    total: count || 0
  };
};

module.exports = {
  AUDIENCE_FILTERS,
  SKIP_REASONS,
  MAX_CUSTOMER_IDS,
  ID_CHUNK,
  hasValidNumber,
  requiresMarketingOptIn,
  templateCategory,
  normalizeAudience,
  resolveAudience,
  businessGroupIds,
  businessCustomerIds,
  maskNumber,
  audienceSummary,
  audienceSkipped
};
