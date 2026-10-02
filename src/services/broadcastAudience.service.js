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
  let query = supabase.from('bookings').select('customer_id').eq('business_id', businessId)
    .in('form_key', params.form === 'any' ? ['demo', 'admission'] : [params.form]);
  if (params.course) query = query.eq('fields->>course', params.course);
  if (params.skipClosed) query = query.neq('status', 'cancelled');
  const { data, error } = await query;
  if (error) throw error;
  return [...new Set((data || []).map(r => r.customer_id).filter(Boolean))];
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
    const { data, error } = await base();
    if (error) throw error;
    return data || [];
  }
  const ids = await requestCustomerIds(businessId, params || { form: 'any', course: null, skipClosed: true });
  const customers = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await base().in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    customers.push(...(data || []));
  }
  return customers;
};

module.exports = { AUDIENCE_FILTERS, normalizeAudience, resolveAudience };
