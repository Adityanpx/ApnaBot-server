// Opt-in links (wa.me link / QR poster → JOIN-<code> → consent buttons).
// Owner CRUD + stats for optInLink.controller.js, and the small lookups /
// writes webhook.controller.js needs (Step 11.7 and the lang_ handler).
// Links are never hard-deleted — only switched off (is_active).

const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('./business.service');
const categoryFeatureService = require('./categoryFeature.service');
const logger = require('../utils/logger');
const {
  DEFAULT_GREETING, generateCode, normalizeGreeting, buildPrefillText, buildWaMeUrl
} = require('../utils/optInLink');

const FEATURE = 'opt_in_links';
const NAME_MAX_LENGTH = 60;
const MAX_CODE_TRIES = 10;
const PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A JOIN message still counts as waiting for an answer this long after it
// arrived — long enough for the language picker in between.
const PENDING_WINDOW_MS = 30 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Webhook side ────────────────────────────────────────────────────────

/** Whether the 'opt_in_links' switch is on for the tenant's business. */
const isFeatureEnabled = (tenant) =>
  categoryFeatureService.isEnabled(tenant.businessCategory, FEATURE, tenant.businessId);

/** The business's link with this code (active or not), raw row, or null. */
const findLinkByCode = async (businessId, code) => {
  const { data, error } = await supabase
    .from('opt_in_links').select('*').eq('business_id', businessId).eq('code', code).maybeSingle();
  if (error) throw error;
  return data;
};

/** The business's link with this id (active or not), raw row, or null. */
const findLinkById = async (businessId, linkId) => {
  if (!linkId || !UUID_PATTERN.test(linkId)) return null;
  const { data, error } = await supabase
    .from('opt_in_links').select('*').eq('id', linkId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

/**
 * Log a link event. Never throws — a failed stats row must not stop the
 * customer's reply.
 * @param {'message'|'opted_in'|'declined'} event
 */
const logEvent = async (link, customerId, event) => {
  const { error } = await supabase.from('opt_in_link_events').insert({
    link_id: link.id,
    business_id: link.business_id,
    customer_id: customerId,
    event
  });
  if (error) logger.error(`Error logging opt-in link event '${event}':`, error);
};

/** Opted in (any source) and not opted out since — nothing to ask. camelCase customer. */
const isOptedIn = (customer) => customer.optedIn === true && !customer.optedOutAt;

/**
 * Record a "Yes" tap. opted_out_at is cleared — the tap is an explicit opt-in,
 * same as START. linkId may be null (link gone).
 * @returns {Promise<Object>} camelCase customer row
 */
const recordLinkOptIn = async (customerId, linkId) => {
  const { data, error } = await supabase.from('customers').update({
    opted_in: true,
    opted_in_at: new Date().toISOString(),
    opt_in_source: 'opt_in_link',
    opt_in_link_id: linkId,
    opted_out_at: null
  }).eq('id', customerId).select().single();
  if (error) throw error;
  return toCamelCase(data);
};

/**
 * An optin_yes / optin_no tap. A "Yes" is honoured even when the link was
 * switched off (or deleted) since the question went out — the customer said
 * yes; the link is only recorded on the customer, and the event only logged,
 * if the row still exists for this business. Already opted in (any source)
 * and not opted out → no write and no second 'opted_in' event. A "No"
 * changes nothing on the customer.
 * @param {string} businessId
 * @param {Object} customer - camelCase customer row
 * @param {{ answer: 'yes'|'no', linkId: string|null }} tap - utils/optInLink.js#parseOptInTapId
 * @returns {Promise<{ newlyOptedIn: boolean, customer: Object }>} customer = updated row when written
 */
const handleConsentTap = async (businessId, customer, tap) => {
  const link = await findLinkById(businessId, tap.linkId);
  if (tap.answer !== 'yes') {
    if (link) await logEvent(link, customer.id, 'declined');
    return { newlyOptedIn: false, customer };
  }
  if (isOptedIn(customer)) return { newlyOptedIn: false, customer };
  const updated = await recordLinkOptIn(customer.id, link ? link.id : null);
  if (link) await logEvent(link, customer.id, 'opted_in');
  return { newlyOptedIn: true, customer: updated };
};

/**
 * The link a customer messaged a JOIN code for and hasn't answered yet: their
 * latest link event is a 'message' from the last PENDING_WINDOW_MS. Used
 * after the language picker, which sits between the JOIN message and the
 * consent question for a new customer. Raw row or null.
 */
const findPendingLink = async (businessId, customerId) => {
  const { data, error } = await supabase
    .from('opt_in_link_events').select('link_id, event, created_at')
    .eq('business_id', businessId).eq('customer_id', customerId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  if (!data || data.event !== 'message') return null;
  if (Date.now() - new Date(data.created_at).getTime() > PENDING_WINDOW_MS) return null;
  const link = await findLinkById(businessId, data.link_id);
  return link && link.is_active ? link : null;
};

/** Map of link id → name, for the Customers page ("Opted in via …"). */
const fetchLinkNames = async (businessId, linkIds) => {
  const ids = [...new Set((linkIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('opt_in_links').select('id, name').eq('business_id', businessId).in('id', ids);
  if (error) throw error;
  return new Map((data || []).map(r => [r.id, r.name]));
};

// ── Owner API ───────────────────────────────────────────────────────────

const emptyCounts = () => ({ messages: 0, optedIn: 0, declined: 0 });
const EVENT_TO_COUNT = { message: 'messages', opted_in: 'optedIn', declined: 'declined' };

/**
 * Distinct customers per event type, per link, for the last 30 days and all
 * time. Pure — takes raw event rows.
 * @returns {Map<string, { last30Days, allTime }>}
 */
const computeStats = (events, now = Date.now()) => {
  const since = now - 30 * DAY_MS;
  const seen = new Map(); // link_id → { allTime: {event: Set}, last30Days: {event: Set} }
  for (const e of events) {
    const key = EVENT_TO_COUNT[e.event];
    if (!key) continue;
    if (!seen.has(e.link_id)) seen.set(e.link_id, { allTime: {}, last30Days: {} });
    const s = seen.get(e.link_id);
    (s.allTime[key] = s.allTime[key] || new Set()).add(e.customer_id);
    if (new Date(e.created_at).getTime() >= since) {
      (s.last30Days[key] = s.last30Days[key] || new Set()).add(e.customer_id);
    }
  }
  const stats = new Map();
  for (const [linkId, s] of seen) {
    const toCounts = (sets) => {
      const c = emptyCounts();
      for (const k of Object.keys(sets)) c[k] = sets[k].size;
      return c;
    };
    stats.set(linkId, { last30Days: toCounts(s.last30Days), allTime: toCounts(s.allTime) });
  }
  return stats;
};

/** Every event row for these links (paged past PostgREST's 1000-row cap). */
const fetchEvents = async (businessId, linkIds) => {
  const rows = [];
  if (linkIds.length === 0) return rows;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('opt_in_link_events').select('id, link_id, customer_id, event, created_at')
      .eq('business_id', businessId).in('link_id', linkIds)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
};

/** API shape for a link: full prefill text, wa.me URL (null if not connected), stats. */
const shapeLink = (row, business, stats) => {
  const prefillText = buildPrefillText(row.prefill_text, row.code, business?.displayName || business?.name);
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    greeting: row.prefill_text,
    prefillText,
    waMeUrl: buildWaMeUrl(business?.whatsappNumber, prefillText),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: stats || { last30Days: emptyCounts(), allTime: emptyCounts() }
  };
};

const shapeWithStats = async (businessId, rows) => {
  const [business, events] = await Promise.all([
    businessService.getBusinessById(businessId),
    fetchEvents(businessId, rows.map(r => r.id))
  ]);
  const stats = computeStats(events);
  return rows.map(r => shapeLink(r, business, stats.get(r.id)));
};

/** Validated { name } or { status, error }. */
const validateName = (input) => {
  if (typeof input !== 'string' || !input.trim()) return { status: 400, error: 'name is required' };
  const name = input.trim();
  if (name.length > NAME_MAX_LENGTH) return { status: 400, error: `name must be at most ${NAME_MAX_LENGTH} characters` };
  return { name };
};

/** GET / — every link, newest first, with stats. */
const list = async (businessId) => {
  const { data, error } = await supabase
    .from('opt_in_links').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
  if (error) throw error;
  return { links: await shapeWithStats(businessId, data || []) };
};

/** GET /:id */
const get = async (businessId, id) => {
  const row = await findLinkById(businessId, id);
  if (!row) return { status: 404, error: 'Opt-in link not found' };
  const [link] = await shapeWithStats(businessId, [row]);
  return { link };
};

/**
 * POST / — Body { name, greeting? }. A fresh random code; retried on the
 * (business_id, code) unique conflict, up to MAX_CODE_TRIES.
 */
const create = async (businessId, userId, body = {}) => {
  const nameCheck = validateName(body.name);
  if (nameCheck.error) return nameCheck;
  const greetingCheck = normalizeGreeting(body.greeting === undefined || body.greeting === null ? DEFAULT_GREETING : body.greeting);
  if (greetingCheck.error) return { status: 400, error: greetingCheck.error };

  for (let attempt = 1; attempt <= MAX_CODE_TRIES; attempt++) {
    const { data, error } = await supabase.from('opt_in_links').insert({
      business_id: businessId,
      name: nameCheck.name,
      code: generateCode(),
      prefill_text: greetingCheck.greeting,
      created_by: userId || null
    }).select().single();
    if (!error) {
      const [link] = await shapeWithStats(businessId, [data]);
      return { link };
    }
    if (error.code !== '23505') throw error;
    logger.warn(`Opt-in link code collision for business ${businessId} (attempt ${attempt})`);
  }
  throw new Error(`Could not generate a unique opt-in link code after ${MAX_CODE_TRIES} tries`);
};

/** PUT /:id — Body: any of { name, greeting, isActive }. The code never changes. */
const update = async (businessId, id, body = {}) => {
  const existing = await findLinkById(businessId, id);
  if (!existing) return { status: 404, error: 'Opt-in link not found' };

  const fields = {};
  if (body.name !== undefined) {
    const nameCheck = validateName(body.name);
    if (nameCheck.error) return nameCheck;
    fields.name = nameCheck.name;
  }
  if (body.greeting !== undefined) {
    const greetingCheck = normalizeGreeting(body.greeting);
    if (greetingCheck.error) return { status: 400, error: greetingCheck.error };
    fields.prefill_text = greetingCheck.greeting;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { status: 400, error: 'isActive must be a boolean' };
    fields.is_active = body.isActive;
  }
  if (Object.keys(fields).length === 0) return { status: 400, error: 'Nothing to update (name, greeting, isActive)' };

  const { data, error } = await supabase
    .from('opt_in_links').update(fields).eq('id', id).eq('business_id', businessId).select().single();
  if (error) throw error;
  const [link] = await shapeWithStats(businessId, [data]);
  return { link };
};

module.exports = {
  FEATURE,
  PENDING_WINDOW_MS,
  isFeatureEnabled,
  findLinkByCode,
  findLinkById,
  logEvent,
  isOptedIn,
  recordLinkOptIn,
  handleConsentTap,
  findPendingLink,
  fetchLinkNames,
  computeStats,
  list,
  get,
  create,
  update
};
