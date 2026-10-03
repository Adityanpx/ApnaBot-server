// Who a broadcast goes to (broadcasts.audience_filter / audience_params,
// 20261002140000_broadcast_audiences.sql). One function used by both the
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
const supabase = require('../config/supabase');

const AUDIENCE_FILTERS = ['all_customers', 'coaching_requests'];
const FORM_CHOICES = ['demo', 'admission', 'any'];
const ID_CHUNK = 500; // keeps each `in (...)` filter a sensible URL length
// PostgREST returns at most max_rows rows per request (1000 on the hosted
// project, measured 2026-10-04) and silently drops the rest, so every
// unbounded select here is read in pages of this size.
const PAGE = 1000;

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

/**
 * The opted-in, non-blocked, not-opted-out customers a broadcast with this
 * audience reaches.
 * @returns {Promise<{ id, whatsapp_number, name }[]>}
 */
const resolveAudience = async (businessId, filter, params) => {
  const base = () => supabase.from('customers').select('id, whatsapp_number, name')
    .eq('business_id', businessId).eq('opted_in', true).eq('is_blocked', false).is('opted_out_at', null);
  if (filter !== 'coaching_requests') {
    return fetchAllPages(() => base().order('id', { ascending: true }));
  }
  const ids = await requestCustomerIds(businessId, params || { form: 'any', course: null, skipClosed: true });
  const customers = [];
  // ID_CHUNK (500) ids per request — under the 1000-row cap, so no paging here.
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await base().in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    customers.push(...(data || []));
  }
  return customers;
};

module.exports = { AUDIENCE_FILTERS, normalizeAudience, resolveAudience };
