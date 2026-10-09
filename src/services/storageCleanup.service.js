// Storage cleanup, write side: previews, runs (mark -> 24h pending -> purge by
// the sweeper), cancel, CSV export, retention settings and the orphan scan.
//
// Marking only writes rows in storage_cleanup_runs / storage_cleanup_items.
// Nothing is deleted here; storageCleanupSweeper.service.js purges after
// pending_delete_at. Reads R2 and ApnaBot's own database only - never Meta.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const inventory = require('./storageInventory.service');
const { CHAT_KINDS, KINDS, PREFIX_KIND, KNOWN_PREFIXES } = require('../utils/storageKinds');
const { istDayStart, istMonthStart } = require('../utils/ist');

const PENDING_MS = 24 * 60 * 60 * 1000;
const INSERT_CHUNK = 500;
const MAX_RUN_ITEMS = 50000;
const ALL_BUSINESSES_PHRASE = 'DELETE ALL BUSINESSES MEDIA';
const RETENTION_SETTING = 'chat_media_retention_days';
const MIN_RETENTION_DAYS = 7;
const UNIQUE_VIOLATION = '23505';
const PREVIEW_SAMPLE = 100;

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// ── Filters ──

/**
 * Validates the request's filters into the internal shape.
 * Body keys: kinds[], from, to ('YYYY-MM-DD', India time, inclusive), businessId (id | 'all'),
 * minBytes, includeInUse, orphanMode.
 */
const parseFilters = (body = {}) => {
  const kinds = body.kinds === undefined || body.kinds === null ? [] : body.kinds;
  if (!Array.isArray(kinds) || kinds.some(k => !KINDS.includes(k))) throw httpError(400, `kinds must be a list of: ${KINDS.join(', ')}`);
  for (const f of ['from', 'to']) {
    if (body[f] && !inventory.istDateStart(body[f])) throw httpError(400, `${f} must be a date like 2026-10-09`);
  }
  if (body.from && body.to && body.from > body.to) throw httpError(400, 'from must not be after to');
  const minBytes = body.minBytes === undefined || body.minBytes === null ? 0 : Number(body.minBytes);
  if (!Number.isFinite(minBytes) || minBytes < 0) throw httpError(400, 'minBytes must be 0 or more');
  const orphanMode = !!body.orphanMode;
  const businessId = body.businessId || (orphanMode ? 'all' : null);
  if (!businessId) throw httpError(400, "businessId is required (a business id, or 'all')");
  return {
    kinds, from: body.from || null, to: body.to || null, businessId,
    minBytes, includeInUse: !!body.includeInUse, orphanMode
  };
};

/** The stored/returned snake_case form of the filters. */
const filtersJson = (f) => ({
  kinds: f.kinds, from: f.from, to: f.to, business_id: f.businessId,
  min_bytes: f.minBytes, include_in_use: f.includeInUse, orphan_mode: f.orphanMode
});

/**
 * The typed confirmations a run needs.
 *  - all businesses: the phrase DELETE ALL BUSINESSES MEDIA
 *  - in-use files: that one business's exact name (never combined with 'all')
 * @returns {Promise<string|null>} the confirmed business name, when one was required
 */
const checkConfirmations = async (filters, body = {}) => {
  if (filters.businessId === 'all') {
    if (filters.includeInUse) throw httpError(400, 'In-use files can only be included for one business at a time.');
    if (body.confirmPhrase !== ALL_BUSINESSES_PHRASE) throw httpError(400, `Type ${ALL_BUSINESSES_PHRASE} to run this on all businesses.`);
  }
  if (!filters.includeInUse) return null;
  const { data, error } = await supabase.from('businesses').select('id, name').eq('id', filters.businessId).maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, 'Business not found');
  if (String(body.confirmBusinessName || '').trim() !== String(data.name).trim()) {
    throw httpError(400, `Type the business name exactly (${data.name}) to include files that are in use.`);
  }
  return data.name;
};

/** Keys already waiting in an open run (so two runs never claim the same object). */
const openRunKeys = async () => {
  const keys = new Set();
  const { data: runs, error } = await supabase.from('storage_cleanup_runs').select('id').in('status', ['pending', 'purging']);
  if (error) throw error;
  for (const run of runs || []) {
    for (let from = 0; ; from += 1000) {
      const { data, error: itemErr } = await supabase.from('storage_cleanup_items').select('r2_key')
        .eq('run_id', run.id).in('status', ['pending', 'failed']).order('id', { ascending: true }).range(from, from + 999);
      if (itemErr) throw itemErr;
      (data || []).forEach(i => keys.add(i.r2_key));
      if (!data || data.length < 1000) break;
    }
  }
  return keys;
};

const scanPrefixes = (filters) => {
  if (filters.orphanMode || !filters.kinds.length) return KNOWN_PREFIXES;
  if (filters.kinds.every(k => CHAT_KINDS.includes(k))) return KNOWN_PREFIXES.filter(p => CHAT_KINDS.includes(PREFIX_KIND[p]));
  return KNOWN_PREFIXES;
};

const publicItem = (e) => ({
  key: e.key, url: e.url, businessId: e.businessId, kind: e.kind, sizeBytes: e.sizeBytes, objectDate: e.objectDate,
  inUse: e.inUse, protected: e.protected, protectedReason: e.protectedReason, usedBy: e.usedBy
});

const selectForFilters = async (filters, now = new Date()) => {
  const businessId = filters.businessId !== 'all' ? filters.businessId : null;
  const { entries, truncated, businesses } = await inventory.scan({ businessId, prefixes: scanPrefixes(filters) });
  const { selected, excluded } = inventory.selectItems(entries, filters, { now, excludeKeys: await openRunKeys() });
  return { selected, excluded, truncated, businesses };
};

/** POST /preview - what these filters would select. Writes nothing. */
const preview = async (body) => {
  const filters = parseFilters(body);
  const { selected, excluded, truncated, businesses } = await selectForFilters(filters);
  return {
    filters: filtersJson(filters),
    ...inventory.summarize(selected, businesses),
    excluded,
    truncated,
    tooMany: selected.length > MAX_RUN_ITEMS,
    sample: selected.slice(0, PREVIEW_SAMPLE).map(publicItem)
  };
};

// ── Runs ──

const insertItems = async (runId, entries, pendingAt) => {
  for (const chunk of chunksOf(entries, INSERT_CHUNK)) {
    const { error } = await supabase.from('storage_cleanup_items').insert(chunk.map(e => ({
      run_id: runId, r2_key: e.key, url: e.url, business_id: e.businessId, kind: e.kind,
      size_bytes: e.sizeBytes, object_date: e.objectDate, in_use: e.inUse, used_by: e.usedBy,
      status: 'pending', pending_delete_at: pendingAt
    })));
    if (error) throw error;
  }
};

/**
 * Creates a run (status 'pending', purge in 24h) from entries already selected.
 * Throws a 23505 for a second automatic run on the same India-time day.
 */
const createRun = async ({ createdBy = null, filters, entries, isAutomatic = false, confirmedBusinessName = null, now = new Date() }) => {
  const pendingAt = new Date(now.getTime() + PENDING_MS).toISOString();
  const { data: run, error } = await supabase.from('storage_cleanup_runs').insert({
    created_by: createdBy,
    filters: filtersJson(filters),
    is_automatic: isAutomatic,
    automatic_day: isAutomatic ? istDayStart(now).toISOString().slice(0, 10) : null,
    status: 'pending',
    pending_delete_at: pendingAt,
    confirmed_business_name: confirmedBusinessName,
    file_count: entries.length,
    total_bytes: entries.reduce((s, e) => s + e.sizeBytes, 0)
  }).select().single();
  if (error) throw error;
  try {
    await insertItems(run.id, entries, pendingAt);
  } catch (err) {
    // A half-marked run must not purge: cancel it rather than leave some items.
    await supabase.from('storage_cleanup_runs').update({ status: 'failed', finished_at: new Date().toISOString() }).eq('id', run.id);
    throw err;
  }
  return run;
};

/** POST /runs - mark the selection; purge happens 24h later. */
const createManualRun = async (body, userId) => {
  const filters = parseFilters(body);
  if (filters.orphanMode) throw httpError(400, 'Use the orphan scan for orphan runs.');
  const confirmedName = await checkConfirmations(filters, body);
  const { selected, truncated } = await selectForFilters(filters);
  if (truncated) throw httpError(400, 'Too many files to scan in one go - narrow by business or kind.');
  if (selected.length === 0) throw httpError(400, 'Nothing matches these filters.');
  if (selected.length > MAX_RUN_ITEMS) throw httpError(400, `That is ${selected.length} files - narrow the filters (max ${MAX_RUN_ITEMS} per run).`);
  const run = await createRun({ createdBy: userId, filters, entries: selected, confirmedBusinessName: confirmedName });
  logger.info('Storage cleanup run created', { runId: run.id, files: run.file_count, bytes: run.total_bytes, userId });
  return run;
};

/** Cancels a run until its purge time. One conditional update, so it cannot race the sweeper. */
const cancelRun = async (runId, userId) => {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase.from('storage_cleanup_runs')
    .update({ status: 'cancelled', cancelled_by: userId, cancelled_at: nowIso, finished_at: nowIso })
    .eq('id', runId).eq('status', 'pending').gt('pending_delete_at', nowIso).select();
  if (error) throw error;
  if (!data || data.length === 0) {
    const { data: run, error: findErr } = await supabase.from('storage_cleanup_runs').select('id, status').eq('id', runId).maybeSingle();
    if (findErr) throw findErr;
    if (!run) throw httpError(404, 'Run not found');
    throw httpError(409, `This run can no longer be cancelled (it is ${run.status}).`);
  }
  const { error: itemErr } = await supabase.from('storage_cleanup_items')
    .update({ status: 'cancelled' }).eq('run_id', runId).in('status', ['pending', 'failed']);
  if (itemErr) throw itemErr;
  return data[0];
};

const listRuns = async ({ limit = 50 } = {}) => {
  const { data, error } = await supabase.from('storage_cleanup_runs').select('*')
    .order('created_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
  if (error) throw error;
  return data || [];
};

const getRun = async (runId, { itemLimit = 200, status = null } = {}) => {
  const { data: run, error } = await supabase.from('storage_cleanup_runs').select('*').eq('id', runId).maybeSingle();
  if (error) throw error;
  if (!run) throw httpError(404, 'Run not found');
  let query = supabase.from('storage_cleanup_items').select('*').eq('run_id', runId);
  if (status) query = query.eq('status', status);
  const { data: items, error: itemErr } = await query.order('size_bytes', { ascending: false }).limit(Math.min(Number(itemLimit) || 200, 1000));
  if (itemErr) throw itemErr;
  return { run, items: items || [] };
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const CSV_COLUMNS = ['r2_key', 'url', 'business_id', 'kind', 'size_bytes', 'object_date', 'in_use', 'used_by', 'status', 'pending_delete_at', 'error', 'attempts'];

/** The run's items as CSV text (the audit trail). */
const exportCsv = async (runId) => {
  const { data: run, error } = await supabase.from('storage_cleanup_runs').select('id').eq('id', runId).maybeSingle();
  if (error) throw error;
  if (!run) throw httpError(404, 'Run not found');
  const lines = [CSV_COLUMNS.join(',')];
  for (let from = 0; ; from += 1000) {
    const { data, error: itemErr } = await supabase.from('storage_cleanup_items').select('*').eq('run_id', runId)
      .order('id', { ascending: true }).range(from, from + 999);
    if (itemErr) throw itemErr;
    for (const i of data || []) lines.push(CSV_COLUMNS.map(c => csvCell(i[c])).join(','));
    if (!data || data.length < 1000) break;
  }
  return `${lines.join('\n')}\n`;
};

/** GET /summary - bytes / files by kind and per business in R2, plus what is waiting to be purged. */
const summary = async ({ now = new Date() } = {}) => {
  const { entries, truncated, businesses } = await inventory.scan({});
  const monthStartMs = istMonthStart(now).getTime();
  const addedThisMonth = entries.reduce((acc, e) => {
    if (e.objectDate && new Date(e.objectDate).getTime() >= monthStartMs) { acc.files += 1; acc.bytes += e.sizeBytes; }
    return acc;
  }, { files: 0, bytes: 0 });
  const referenced = entries.filter(e => e.referenced);
  const orphans = entries.filter(e => !e.referenced);
  const { data: pending, error } = await supabase.from('storage_cleanup_items')
    .select('size_bytes').in('status', ['pending', 'failed']).limit(100000);
  if (error) throw error;
  return {
    ...inventory.summarize(entries, businesses),
    addedThisMonth,
    inUse: inventory.summarize(entries.filter(e => e.inUse), businesses).count,
    referencedCount: referenced.length,
    orphanCount: orphans.length,
    orphanBytes: orphans.reduce((s, e) => s + e.sizeBytes, 0),
    pending: { count: (pending || []).length, bytes: (pending || []).reduce((s, i) => s + Number(i.size_bytes), 0) },
    truncated
  };
};

// ── Retention settings ──

const getPlatformRetentionDays = async () => {
  const { data, error } = await supabase.from('platform_settings').select('value').eq('key', RETENTION_SETTING).maybeSingle();
  if (error) throw error;
  const v = data ? data.value : null;
  return Number.isInteger(v) && v >= MIN_RETENTION_DAYS ? v : null;
};

/** days: whole number >= 7, or null to switch the automatic rule off. */
const setPlatformRetentionDays = async (days) => {
  if (days !== null && !(Number.isInteger(days) && days >= MIN_RETENTION_DAYS)) {
    throw httpError(400, `chatMediaRetentionDays must be null (off) or a whole number of at least ${MIN_RETENTION_DAYS}`);
  }
  const { error } = await supabase.from('platform_settings').upsert({ key: RETENTION_SETTING, value: days }, { onConflict: 'key' });
  if (error) throw error;
};

/** retention: a whole number >= 7, 'never', or null to follow the platform. */
const setBusinessRetention = async (businessId, retention) => {
  let stored;
  if (retention === null) stored = null;
  else if (retention === 'never') stored = 'never';
  else if (Number.isInteger(retention) && retention >= MIN_RETENTION_DAYS) stored = String(retention);
  else throw httpError(400, `retention must be null (follow the platform), "never", or a whole number of at least ${MIN_RETENTION_DAYS}`);
  const { data, error } = await supabase.from('businesses').update({ chat_media_retention: stored }).eq('id', businessId).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw httpError(404, 'Business not found');
  return stored;
};

/** Days of chat media a business keeps, or null for forever: its own setting wins over the platform's. */
const effectiveRetentionDays = (businessSetting, platformDays) => {
  if (businessSetting === 'never') return null;
  if (businessSetting && /^[1-9][0-9]*$/.test(businessSetting)) return Number(businessSetting);
  return platformDays;
};

// ── Automatic retention run ──

/**
 * Once per India-time day (the unique automatic_day index): a normal run of
 * chat files (customer + owner media only) older than each business's
 * retention. Same 24h pending window - visible and cancellable in the runs list.
 * @returns {Promise<{created:boolean, reason?:string, run?:Object}>}
 */
const createRetentionRun = async ({ now = new Date() } = {}) => {
  const platformDays = await getPlatformRetentionDays();
  const { data: businesses, error } = await supabase.from('businesses').select('id, chat_media_retention');
  if (error) throw error;
  const rules = (businesses || [])
    .map(b => ({ id: b.id, days: effectiveRetentionDays(b.chat_media_retention, platformDays) }))
    .filter(b => b.days !== null);
  if (rules.length === 0) return { created: false, reason: 'retention is off' };

  const { data: existing, error: existingErr } = await supabase.from('storage_cleanup_runs').select('id')
    .eq('is_automatic', true).eq('automatic_day', istDayStart(now).toISOString().slice(0, 10)).limit(1);
  if (existingErr) throw existingErr;
  if (existing && existing.length > 0) return { created: false, reason: 'already ran today' };

  const chatPrefixes = KNOWN_PREFIXES.filter(p => CHAT_KINDS.includes(PREFIX_KIND[p]));
  const excludeKeys = await openRunKeys();
  const entries = [];
  for (const rule of rules) {
    const { entries: found } = await inventory.scan({ businessId: rule.id, prefixes: chatPrefixes });
    const cutoff = now.getTime() - rule.days * 24 * 60 * 60 * 1000;
    for (const e of found) {
      if (!e.referenced || !CHAT_KINDS.includes(e.kind) || excludeKeys.has(e.key)) continue;
      if (!e.objectDate || new Date(e.objectDate).getTime() >= cutoff) continue;
      entries.push(e);
    }
  }
  if (entries.length === 0) return { created: false, reason: 'nothing older than the retention' };
  if (entries.length > MAX_RUN_ITEMS) entries.length = MAX_RUN_ITEMS; // the rest goes in tomorrow's run

  const filters = { kinds: CHAT_KINDS, from: null, to: null, businessId: 'all', minBytes: 0, includeInUse: false, orphanMode: false };
  try {
    const run = await createRun({ filters, entries, isAutomatic: true, now });
    logger.info('Storage cleanup: automatic retention run created', { runId: run.id, files: run.file_count, bytes: run.total_bytes });
    return { created: true, run };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return { created: false, reason: 'already ran today' };
    throw err;
  }
};

// ── Orphan scan (background job) ──

let orphanScan = null; // latest job summary, in memory

/**
 * Starts the scan in the background; when it finishes it creates a normal
 * 'pending' run of orphan objects older than 48h (same 24h window, cancellable).
 * Needs the all-businesses phrase, since the run purges by itself.
 */
const startOrphanScan = async (body, userId) => {
  if ((body || {}).confirmPhrase !== ALL_BUSINESSES_PHRASE) throw httpError(400, `Type ${ALL_BUSINESSES_PHRASE} to scan all businesses.`);
  if (orphanScan && orphanScan.status === 'running') throw httpError(409, 'An orphan scan is already running.');
  const filters = parseFilters({ ...body, orphanMode: true, businessId: 'all', includeInUse: false });
  const job = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, runId: null, found: 0, error: null };
  orphanScan = job;
  (async () => {
    try {
      const { selected, truncated } = await selectForFilters(filters);
      if (truncated) throw new Error('Bucket too large to scan in one go');
      job.found = selected.length;
      if (selected.length > 0) {
        const run = await createRun({ createdBy: userId, filters, entries: selected.slice(0, MAX_RUN_ITEMS) });
        job.runId = run.id;
      }
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      logger.error('Storage cleanup: orphan scan failed', { message: err.message });
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  return job;
};

const orphanScanStatus = () => orphanScan;

module.exports = {
  ALL_BUSINESSES_PHRASE, MIN_RETENTION_DAYS, MAX_RUN_ITEMS, PENDING_MS,
  parseFilters, checkConfirmations, preview, createRun, createManualRun, cancelRun, listRuns, getRun, exportCsv, summary,
  getPlatformRetentionDays, setPlatformRetentionDays, setBusinessRetention, effectiveRetentionDays,
  createRetentionRun, startOrphanScan, orphanScanStatus, selectForFilters
};
