// Sync a business's message templates from WhatsApp (GET /{waba}/message_templates)
// into message_templates. Meta wins on status, category, rejection reason,
// quality and components for any row that has a meta_template_id; our own
// header_image_url / header_image_r2_key are never touched.
//
// Matching: meta_template_id first; else (name, language) among this
// business's rows that have no meta_template_id yet (adopts a draft that was
// submitted but never got its id stored). AUTHENTICATION templates (and any
// other category the table doesn't allow) are skipped, never stored. A stored
// template with a meta_template_id that's missing from a COMPLETE listing is
// soft-deleted (status 'deleted' + meta_deleted_at) and un-deleted if it
// reappears; a failed / partial listing flags nothing.
//
// planSync is pure (rows in, plan out); syncBusinessTemplates does the
// Meta call and the writes (none on a dry run); runSync adds the per-business
// cooldown that the endpoint and the post-connect auto-sync share.
const axios = require('axios');
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const { META_API_BASE } = require('./whatsapp.service');
const { decrypt } = require('../utils/crypto');
const { templateStatusFromMeta } = require('../utils/templateStatus');
const logger = require('../utils/logger');

const SYNC_COOLDOWN_MS = 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
// Meta's "invalid cursor" paging error — restart the listing once.
const INVALID_CURSOR_CODE = 131059;
const LISTING_FIELDS = 'id,name,language,status,category,rejected_reason,quality_score,components,parameter_format';

const STORED_CATEGORIES = ['MARKETING', 'UTILITY'];
const STORED_HEADER_TYPES = ['IMAGE', 'TEXT', 'VIDEO', 'DOCUMENT', 'LOCATION'];
const POSITIONAL_VARIABLE = /\{\{\s*\d+\s*\}\}/g;
const NAMED_VARIABLE = /\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/gi;

// ── Component helpers ──

const componentsOf = (t) => (Array.isArray(t.components) ? t.components : []);
const componentOfType = (t, type) => componentsOf(t).find(c => c && c.type === type) || null;
const headerFormat = (t) => {
  const header = componentOfType(t, 'HEADER');
  return header && typeof header.format === 'string' ? header.format.toUpperCase() : null;
};

const countPositionalVariables = (text) =>
  new Set(((text || '').match(POSITIONAL_VARIABLE) || []).map(m => m.replace(/\D/g, ''))).size;
const countNamedVariables = (text) =>
  new Set(((text || '').match(NAMED_VARIABLE) || []).map(m => m.replace(/[{}\s]/g, '').toLowerCase())).size;

/** message_templates.header_type for a listed template ('NONE' when it has no / an unknown header). */
const headerTypeOf = (t) => {
  const format = headerFormat(t);
  return STORED_HEADER_TYPES.includes(format) ? format : 'NONE';
};

/**
 * Can today's sender send this template? Today's sender fills BODY variables
 * and one IMAGE header from a stored image URL — nothing else.
 *   unsupported_named_params  parameter_format NAMED ({{name}} variables)
 *   unsupported_component     any BUTTONS (or other non header/body/footer)
 *                             component, a header with its own variable, or a
 *                             LOCATION / unknown header format
 *   needs_header_media        IMAGE header with no stored image, or VIDEO / DOCUMENT
 *   ok                        everything else (FOOTER and a variable-free TEXT
 *                             header are added by Meta, nothing to send)
 * Checked in that order when several apply.
 * @param {Object} t  Meta listing entry ({ components, parameter_format })
 * @param {{ headerImageUrl?: string|null }} [own]  what we already store for the row
 */
const computeSendSupport = (t, { headerImageUrl = null } = {}) => {
  const body = componentOfType(t, 'BODY');
  const named = String(t.parameter_format || '').toUpperCase() === 'NAMED'
    || countNamedVariables(body && body.text) > 0;
  if (named) return 'unsupported_named_params';

  const components = componentsOf(t);
  if (components.some(c => c && !['HEADER', 'BODY', 'FOOTER'].includes(c.type))) return 'unsupported_component';

  const header = componentOfType(t, 'HEADER');
  if (header) {
    const format = headerFormat(t);
    if (format === 'TEXT') {
      if (countPositionalVariables(header.text) > 0 || countNamedVariables(header.text) > 0) return 'unsupported_component';
    } else if (format === 'IMAGE') {
      if (!headerImageUrl) return 'needs_header_media';
    } else if (format === 'VIDEO' || format === 'DOCUMENT') {
      return 'needs_header_media';
    } else {
      return 'unsupported_component';
    }
  }
  return 'ok';
};

const qualityOf = (t) => {
  const score = t.quality_score && typeof t.quality_score === 'object' ? t.quality_score.score : t.quality_score;
  return typeof score === 'string' && score ? score.toUpperCase() : null;
};

const samplesOf = (t) => {
  const body = componentOfType(t, 'BODY');
  const sample = body && body.example && Array.isArray(body.example.body_text) ? body.example.body_text[0] : null;
  return Array.isArray(sample) && sample.length > 0 ? sample.map(String) : null;
};

/**
 * The Meta-owned columns for a listed template. `existing` is the matched row
 * (or null): its status is kept when Meta's isn't one we map, its body when
 * Meta sent none, its sample values when it already has some, and its
 * header_image_url decides whether an IMAGE header can be sent. Never sets
 * header_image_url / header_image_r2_key.
 */
const metaFields = (t, existing, nowIso) => {
  const mappedStatus = templateStatusFromMeta(t.status);
  const status = mappedStatus || (existing ? existing.status : null);
  const body = componentOfType(t, 'BODY');
  const bodyText = body && typeof body.text === 'string' ? body.text : (existing ? existing.body_text : '');
  const reason = status === 'rejected' && t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null;
  const fields = {
    meta_template_id: String(t.id),
    status,
    meta_status: t.status || null,
    category: t.category,
    rejection_reason: reason,
    quality_score: qualityOf(t),
    meta_components: componentsOf(t),
    body_text: bodyText,
    variable_count: countPositionalVariables(bodyText) || countNamedVariables(bodyText),
    header_type: headerTypeOf(t),
    send_support: computeSendSupport(t, { headerImageUrl: existing ? existing.header_image_url : null }),
    meta_deleted_at: status === 'deleted' ? ((existing && existing.meta_deleted_at) || nowIso) : null
  };
  const samples = samplesOf(t);
  if (samples && !(existing && existing.variable_samples)) fields.variable_samples = samples;
  return fields;
};

const sameValue = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

/** Keys of `fields` whose value differs from the stored row; columns the row doesn't have yet (migration not applied) are ignored. */
const changedKeys = (existing, fields) =>
  Object.keys(fields).filter(k => k in existing && !sameValue(existing[k], fields[k]));

// ── The plan ──

/**
 * @param {Object[]} existingRows  this business's message_templates rows
 * @param {Object[]} listed        Meta's listing entries
 * @param {{ complete: boolean, now?: Date }} opts  complete = every page fetched with no error
 */
const planSync = (existingRows, listed, { complete, now = new Date() }) => {
  const nowIso = now.toISOString();
  const byMetaId = new Map();
  const unregistered = new Map(); // `${name}\u0000${language}` → row, rows with no meta_template_id
  for (const row of existingRows) {
    if (row.meta_template_id) byMetaId.set(String(row.meta_template_id), row);
    else unregistered.set(`${row.name}\u0000${row.language}`, row);
  }

  const plan = { creates: [], updates: [], adopts: [], restores: [], unchanged: [], markDeleted: [], skipped: [], unsupported: [] };
  const seenIds = new Set();
  const matchedRowIds = new Set();

  for (const t of listed) {
    if (!t || !t.id || !t.name || !t.language) {
      plan.skipped.push({ name: t && t.name, language: t && t.language, reason: 'malformed listing entry' });
      continue;
    }
    seenIds.add(String(t.id));
    if (!STORED_CATEGORIES.includes(t.category)) {
      plan.skipped.push({ name: t.name, language: t.language, reason: `category ${t.category}` });
      continue;
    }

    let existing = byMetaId.get(String(t.id)) || null;
    let adopted = false;
    if (!existing) {
      const key = `${t.name}\u0000${t.language}`;
      const candidate = unregistered.get(key);
      if (candidate && !matchedRowIds.has(candidate.id)) {
        existing = candidate;
        adopted = true;
      }
    }

    if (!existing && !templateStatusFromMeta(t.status)) {
      plan.skipped.push({ name: t.name, language: t.language, reason: `status ${t.status}` });
      continue;
    }

    const fields = metaFields(t, existing, nowIso);
    if (fields.send_support !== 'ok') {
      plan.unsupported.push({ name: t.name, language: t.language, sendSupport: fields.send_support });
    }

    if (!existing) {
      plan.creates.push({ name: t.name, language: t.language, row: { ...fields, name: t.name, language: t.language, source: 'meta_sync' } });
      continue;
    }

    matchedRowIds.add(existing.id);
    const changes = changedKeys(existing, fields);
    const entry = { id: existing.id, name: existing.name, language: existing.language, fields, changes };
    if (adopted) plan.adopts.push(entry);
    else if (existing.status === 'deleted' && fields.status !== 'deleted') plan.restores.push(entry);
    else if (changes.length > 0) plan.updates.push(entry);
    else plan.unchanged.push(entry);
  }

  // Only a complete listing can say a template is gone — and an empty one for
  // a business that has registered templates is treated as a Meta glitch, not
  // as "everything was deleted".
  plan.emptyListingSkipped = false;
  if (complete) {
    const registered = existingRows.filter(r => r.meta_template_id && r.status !== 'deleted');
    if (listed.length === 0 && registered.length > 0) {
      plan.emptyListingSkipped = true;
      logger.warn('Template sync: Meta returned an empty listing for a business with registered templates - not soft-deleting anything', { registered: registered.length });
    }
    for (const row of plan.emptyListingSkipped ? [] : existingRows) {
      if (row.meta_template_id && row.status !== 'deleted' && !seenIds.has(String(row.meta_template_id))) {
        plan.markDeleted.push({ id: row.id, name: row.name, language: row.language, metaTemplateId: row.meta_template_id });
      }
    }
  }
  return plan;
};

// ── Meta listing ──

const isInvalidCursor = (err) => {
  const e = err && err.response && err.response.data && err.response.data.error;
  return !!e && (Number(e.code) === INVALID_CURSOR_CODE || Number(e.error_subcode) === INVALID_CURSOR_CODE);
};

const fetchListingOnce = async (wabaId, accessToken, http) => {
  const templates = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await http.get(`${META_API_BASE}/${wabaId}/message_templates`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: LISTING_FIELDS, limit: PAGE_SIZE, ...(after ? { after } : {}) }
    });
    templates.push(...(Array.isArray(data && data.data) ? data.data : []));
    if (!(data && data.paging && data.paging.next)) return templates;
    after = data.paging.cursors && data.paging.cursors.after;
    if (!after) throw new Error('Meta listing has a next page but no cursor');
  }
  throw new Error(`Meta listing still paging after ${MAX_PAGES} pages`);
};

/**
 * Every template Meta lists for the WABA. Resolves only with a COMPLETE
 * listing: an invalid-cursor error (131059) restarts from the first page once,
 * any other error — or a second invalid cursor — rejects.
 */
const fetchAllTemplates = async (wabaId, accessToken, http = axios) => {
  try {
    return await fetchListingOnce(wabaId, accessToken, http);
  } catch (err) {
    if (!isInvalidCursor(err)) throw err;
    logger.warn('Template sync: Meta rejected a paging cursor (131059), restarting the listing once', { wabaId });
    return fetchListingOnce(wabaId, accessToken, http);
  }
};

// ── Apply ──

const failureNote = (err) => (err && err.message) || String(err);

/**
 * @param {Object} business  camelCase business (businessService.getBusinessById): id, wabaId, accessToken (encrypted)
 * @param {{ dryRun?: boolean, now?: Date, fetchTemplates?: Function }} [opts]
 * @returns {Promise<{ summary: Object, details: Object[] }>}
 */
const syncBusinessTemplates = async (business, { dryRun = false, now = new Date(), fetchTemplates = fetchAllTemplates } = {}) => {
  if (!business || !business.wabaId || !business.accessToken) {
    const err = new Error('Business is not connected to WhatsApp. Please connect WhatsApp first.');
    err.status = 400;
    throw err;
  }
  const businessId = business.id;
  const nowIso = now.toISOString();

  const listed = await fetchTemplates(business.wabaId, decrypt(business.accessToken));
  const { data: existingRows, error: loadErr } = await supabase.from('message_templates').select('*').eq('business_id', businessId);
  if (loadErr) throw loadErr;

  const plan = planSync(existingRows || [], listed, { complete: true, now });
  const details = [
    ...plan.creates.map(c => ({ action: 'create', name: c.name, language: c.language, status: c.row.status, sendSupport: c.row.send_support })),
    ...plan.adopts.map(a => ({ action: 'adopt', name: a.name, language: a.language, changes: a.changes })),
    ...plan.restores.map(r => ({ action: 'restore', name: r.name, language: r.language, changes: r.changes })),
    ...plan.updates.map(u => ({ action: 'update', name: u.name, language: u.language, changes: u.changes })),
    ...plan.markDeleted.map(d => ({ action: 'mark_deleted', name: d.name, language: d.language })),
    ...plan.skipped.map(s => ({ action: 'skip', name: s.name, language: s.language, reason: s.reason }))
  ];
  const summary = {
    created: plan.creates.length,
    updated: plan.updates.length,
    adopted: plan.adopts.length,
    restored: plan.restores.length,
    markedDeleted: plan.markDeleted.length,
    skipped: plan.skipped.length,
    failed: 0,
    emptyListingSkipped: plan.emptyListingSkipped,
    unsupported: plan.unsupported,
    lastSyncedAt: null
  };
  if (dryRun) return { summary, details };

  const fail = (what, entry, err) => {
    summary.failed += 1;
    logger.error(`Template sync: could not ${what}`, { businessId, name: entry.name, language: entry.language, error: failureNote(err) });
  };

  for (const c of plan.creates) {
    const { error } = await supabase.from('message_templates')
      .insert({ ...c.row, business_id: businessId, last_synced_at: nowIso });
    if (error) { summary.created -= 1; fail('create a synced template', c, error); }
  }
  for (const [list, key] of [[plan.adopts, 'adopted'], [plan.restores, 'restored'], [plan.updates, 'updated']]) {
    for (const u of list) {
      const { error } = await supabase.from('message_templates')
        .update({ ...u.fields, last_synced_at: nowIso }).eq('id', u.id).eq('business_id', businessId);
      if (error) { summary[key] -= 1; fail('update a synced template', u, error); }
    }
  }
  if (plan.unchanged.length > 0) {
    const { error } = await supabase.from('message_templates')
      .update({ last_synced_at: nowIso }).in('id', plan.unchanged.map(u => u.id)).eq('business_id', businessId);
    if (error) logger.error('Template sync: could not stamp last_synced_at on unchanged templates', { businessId, error: failureNote(error) });
  }
  for (const d of plan.markDeleted) {
    const { error } = await supabase.from('message_templates')
      .update({ status: 'deleted', meta_deleted_at: nowIso, last_synced_at: nowIso }).eq('id', d.id).eq('business_id', businessId);
    if (error) { summary.markedDeleted -= 1; fail('mark a template deleted', d, error); }
  }

  summary.lastSyncedAt = nowIso;
  logger.info('Template sync finished', { businessId, ...summary, unsupported: summary.unsupported.length });
  return { summary, details };
};

// ── Cooldown + entry point for the endpoint / post-connect auto-sync ──

const lastStartedAt = new Map(); // businessId → ms
const inFlight = new Set();

class SyncThrottledError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'SyncThrottledError';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Sync one business, at most once per SYNC_COOLDOWN_MS (in memory, per server
 * process) and never two at once. Throws SyncThrottledError (429) when too soon.
 */
const runSync = async (businessId, { now = new Date(), ...opts } = {}) => {
  const key = String(businessId);
  if (inFlight.has(key)) {
    throw new SyncThrottledError('A template sync is already running for this business. Please wait a moment.', 5);
  }
  const last = lastStartedAt.get(key);
  if (last !== undefined && now.getTime() - last < SYNC_COOLDOWN_MS) {
    const wait = Math.ceil((SYNC_COOLDOWN_MS - (now.getTime() - last)) / 1000);
    throw new SyncThrottledError(`Templates were synced a moment ago. Please try again in ${wait} seconds.`, wait);
  }
  inFlight.add(key);
  lastStartedAt.set(key, now.getTime());
  try {
    const business = await businessService.getBusinessById(businessId);
    return await syncBusinessTemplates(business, { now, ...opts });
  } finally {
    inFlight.delete(key);
  }
};

const resetCooldownForTests = () => { lastStartedAt.clear(); inFlight.clear(); };

module.exports = {
  SYNC_COOLDOWN_MS,
  SyncThrottledError,
  computeSendSupport,
  headerTypeOf,
  planSync,
  fetchAllTemplates,
  syncBusinessTemplates,
  runSync,
  resetCooldownForTests
};
