// Storage cleanup, the sweeper. One tick (runTick) does, in order:
//   1. RETENTION - once a day, creates the automatic chat-media run (a normal,
//      cancellable run with the same 24h pending window).
//   2. PURGE     - claims due items atomically (claim_storage_cleanup_items:
//      FOR UPDATE SKIP LOCKED + claimed_at), then per batch:
//        a. re-checks each item against the database as it is NOW (something
//           marked safe 24h ago may be in use today) -> skipped_in_use
//        b. DATABASE first: clears every reference (messages.media_url ->
//           NULL + media_removed_at, flow_nodes image, template header,
//           payment QR, profile image, vehicle photo, course image, library
//           row + storage_used_bytes)
//        c. then R2, in batches of up to 1000 keys
//      An item whose database step or R2 delete failed keeps its error and is
//      retried by later ticks (up to 5 attempts).
//   3. FINISH    - runs with nothing left to do become done / failed.
// server.js runs it every 15 minutes when ENABLE_STORAGE_SWEEPER is on;
// scripts/storageCleanup.js runs one tick by hand.
//
// HARD RULE: this touches R2 and ApnaBot's own database only. It never calls
// Meta / WhatsApp (nothing from whatsapp.service or axios is imported).
const supabase = require('../config/supabase');
const r2 = require('./r2.service');
const inventory = require('./storageInventory.service');
const cleanup = require('./storageCleanup.service');
const { computeSendSupport } = require('../utils/templateSendSupport');
const { CHAT_KINDS } = require('../utils/storageKinds');
const logger = require('../utils/logger');

const CLAIM_BATCH = 500;
const MAX_BATCHES_PER_TICK = 20;
const URL_CHUNK = 50;
const MAX_ATTEMPTS = 5;

const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const must = ({ error, data }) => {
  if (error) throw error;
  return data;
};

// ── Database step: clear every reference to one object ──

const TEMPLATE_COLUMNS = 'id, business_id, name, language, status, send_support, meta_components, header_type, body_text, header_media_url, header_image_url';

/** Recomputes send_support (local only - no Meta call) for templates whose header was just cleared. */
const recomputeTemplates = async (ids) => {
  for (const chunk of chunksOf([...ids], 100)) {
    const rows = must(await supabase.from('message_templates').select(TEMPLATE_COLUMNS).in('id', chunk));
    for (const row of rows || []) {
      const next = computeSendSupport(row);
      if (next !== row.send_support) must(await supabase.from('message_templates').update({ send_support: next }).eq('id', row.id));
    }
  }
};

/**
 * Chat files: only the message points at them. One update per 50 urls.
 * @returns {Promise<void>}
 */
const clearChatMessages = async (items, nowIso) => {
  for (const chunk of chunksOf(items, URL_CHUNK)) {
    must(await supabase.from('messages').update({ media_url: null, media_removed_at: nowIso }).in('media_url', chunk.map(i => i.url)));
  }
};

/**
 * Everything else (library, template header, QR, logo, vehicle, orphan): clear
 * each reference to this object. Idempotent, so a retry after a failed R2
 * delete is harmless. Never deletes a template, message or flow node.
 * @param {Object} ctx { touchedBusinesses: Set } business ids whose bot flow changed
 */
const clearReferences = async (item, nowIso, ctx, snapshotIds = []) => {
  const { url, r2_key: key } = item;

  const media = must(await supabase.from('business_media').select('id, business_id, file_size_bytes').eq('r2_key', key).maybeSingle());
  const mediaId = media ? media.id : null;

  // Bot reply nodes: text-only from now on (image_url NULL sends the label alone).
  const nodeFilters = [['image_url', url]];
  if (mediaId) nodeFilters.push(['media_id', mediaId]);
  for (const [column, value] of nodeFilters) {
    const nodes = must(await supabase.from('flow_nodes').update({ image_url: null, media_id: null, image_removed_at: nowIso }).eq(column, value).select('id, business_id'));
    (nodes || []).forEach(n => ctx.touchedBusinesses.add(n.business_id));
  }

  // Saved flow versions (personal snapshots only; category templates are protected and never get
  // here): drop the image from their stored nodes too, or a restore would bring the dead URL back.
  for (const snapId of snapshotIds) {
    const snap = must(await supabase.from('flow_snapshots').select('id, business_id, nodes').eq('id', snapId).maybeSingle());
    if (!snap || !Array.isArray(snap.nodes)) continue;
    let changed = false;
    const nodes = snap.nodes.map((n) => {
      if (n.image_url !== url && !(mediaId && n.media_id === mediaId)) return n;
      changed = true;
      return { ...n, image_url: null, media_id: null };
    });
    if (changed) must(await supabase.from('flow_snapshots').update({ nodes }).eq('id', snapId));
  }

  // Template headers: clear the file, keep the template; send_support is recomputed below.
  const touchedTemplates = new Set();
  const headerFilters = [
    [{ header_image_url: null, header_image_r2_key: null }, 'header_image_r2_key', key],
    [{ header_image_url: null, header_image_r2_key: null }, 'header_image_url', url],
    [{ header_media_url: null, header_media_id: null, header_media_filename: null }, 'header_media_url', url]
  ];
  if (mediaId) headerFilters.push([{ header_media_url: null, header_media_id: null, header_media_filename: null }, 'header_media_id', mediaId]);
  for (const [fields, column, value] of headerFilters) {
    const rows = must(await supabase.from('message_templates').update(fields).eq(column, value).select('id'));
    (rows || []).forEach(r => touchedTemplates.add(r.id));
  }
  if (touchedTemplates.size > 0) await recomputeTemplates(touchedTemplates);

  if (mediaId) must(await supabase.from('business_courses').update({ image_media_id: null }).eq('image_media_id', mediaId));
  must(await supabase.from('businesses').update({ payment_qr_url: null }).eq('payment_qr_url', url));
  must(await supabase.from('businesses').update({ profile_image: null }).eq('profile_image', url));
  must(await supabase.from('vehicles').update({ custom_photo_url: null }).eq('custom_photo_url', url));

  // Messages that carried this file (e.g. a library file sent from the inbox).
  must(await supabase.from('messages').update({ media_url: null, media_removed_at: nowIso }).eq('media_url', url));

  // Library row last, and the storage counter only when this call really removed the row.
  if (media) {
    const removed = must(await supabase.from('business_media').delete().eq('id', mediaId).select('id'));
    if (removed && removed.length > 0) {
      const { error } = await supabase.rpc('increment_business_storage_used', {
        p_business_id: media.business_id, p_delta_bytes: -media.file_size_bytes
      });
      if (error) logger.error('Storage cleanup: library row deleted but storage_used_bytes decrement failed', { businessId: media.business_id, error: error.message });
    }
  }
};

// ── Re-check at purge time ──

/**
 * Why this item must NOT be purged now, or null. The database may have changed
 * since the run was marked (24h ago).
 */
const skipReason = (item, entry, run) => {
  if (!entry) return 'not in a known folder';
  if (entry.protected) return `protected: ${entry.protectedReason}`;
  if (item.kind === 'orphan' && entry.referenced) return 'referenced since the run was marked';
  const includeInUse = !!(run.filters && run.filters.include_in_use);
  if (entry.inUse && !includeInUse) return item.in_use ? 'in use' : 'in use since the run was marked';
  return null;
};

const loadRuns = async (ids) => {
  const runs = new Map();
  for (const chunk of chunksOf([...ids], 100)) {
    must(await supabase.from('storage_cleanup_runs').select('id, filters, status').in('id', chunk)).forEach(r => runs.set(r.id, r));
  }
  return runs;
};

const setItems = async (ids, fields) => {
  for (const chunk of chunksOf(ids, 100)) must(await supabase.from('storage_cleanup_items').update(fields).in('id', chunk));
};

const failItem = async (item, message) => {
  must(await supabase.from('storage_cleanup_items').update({ status: 'failed', error: String(message).slice(0, 500) }).eq('id', item.id));
};

/** Processes one claimed batch. @returns {Promise<{purged:number, skipped:number, failed:number, runIds:Set}>} */
const processBatch = async (items, ctx) => {
  const out = { purged: 0, skipped: 0, failed: 0, runIds: new Set(items.map(i => i.run_id)) };
  const runs = await loadRuns(out.runIds);
  const nowIso = new Date().toISOString();
  ctx.refs = ctx.refs || await inventory.loadReferences({});
  const chatMessages = await inventory.loadChatMessages(
    items.filter(i => CHAT_KINDS.includes(i.kind)).map(i => ({ key: i.r2_key })));

  const entries = new Map();
  const doable = [];
  for (const item of items) {
    const run = runs.get(item.run_id);
    if (!run || !['pending', 'purging'].includes(run.status)) { await setItems([item.id], { status: 'cancelled' }); continue; }
    const entry = inventory.classifyObject({ key: item.r2_key, size: Number(item.size_bytes), lastModified: item.object_date }, { refs: ctx.refs, chatMessages });
    entries.set(item.id, entry);
    const reason = skipReason(item, entry, run);
    if (reason) {
      must(await supabase.from('storage_cleanup_items').update({ status: 'skipped_in_use', error: reason }).eq('id', item.id));
      out.skipped += 1;
      continue;
    }
    doable.push(item);
  }

  // 1. database first
  const dbDone = [];
  const chatItems = doable.filter(i => CHAT_KINDS.includes(i.kind));
  try {
    await clearChatMessages(chatItems, nowIso);
    dbDone.push(...chatItems);
  } catch (err) {
    for (const item of chatItems) { await failItem(item, `database: ${err.message}`); out.failed += 1; }
  }
  for (const item of doable.filter(i => !CHAT_KINDS.includes(i.kind))) {
    try {
      const snapshotIds = (entries.get(item.id).usedBy || []).filter(u => u.type === 'flow_snapshot').map(u => u.id);
      await clearReferences(item, nowIso, ctx, snapshotIds);
      dbDone.push(item);
    } catch (err) {
      await failItem(item, `database: ${err.message}`);
      out.failed += 1;
    }
  }

  // 2. then R2, up to 1000 keys per request
  if (dbDone.length > 0) {
    const { failed } = await r2.deleteObjects(dbDone.map(i => i.r2_key));
    const failedByKey = new Map(failed.map(f => [f.key, f.message]));
    const ok = dbDone.filter(i => !failedByKey.has(i.r2_key));
    await setItems(ok.map(i => i.id), { status: 'purged', error: null });
    out.purged += ok.length;
    for (const item of dbDone.filter(i => failedByKey.has(i.r2_key))) {
      await failItem(item, `r2: ${failedByKey.get(item.r2_key)}`);
      out.failed += 1;
    }
  }
  return out;
};

// ── Run bookkeeping ──

/** Moves a run to 'purging' and refreshes its counters; closes it when nothing is left. */
const refreshRun = async (runId) => {
  const nowIso = new Date().toISOString();
  must(await supabase.from('storage_cleanup_runs').update({ status: 'purging' }).eq('id', runId).eq('status', 'pending'));

  let purgedCount = 0; let purgedBytes = 0; let failedCount = 0;
  for (let from = 0; ; from += 1000) {
    const rows = must(await supabase.from('storage_cleanup_items').select('status, size_bytes, attempts').eq('run_id', runId)
      .order('id', { ascending: true }).range(from, from + 999));
    for (const r of rows || []) {
      if (r.status === 'purged') { purgedCount += 1; purgedBytes += Number(r.size_bytes); }
      if (r.status === 'failed') failedCount += 1;
    }
    if (!rows || rows.length < 1000) break;
  }
  const open = must(await supabase.from('storage_cleanup_items').select('id, status, attempts').eq('run_id', runId).in('status', ['pending', 'failed']).limit(1000));
  const stillWorking = (open || []).some(i => i.status === 'pending' || i.attempts < MAX_ATTEMPTS);
  const fields = { purged_count: purgedCount, purged_bytes: purgedBytes, failed_count: failedCount };
  if (!stillWorking) {
    fields.status = purgedCount === 0 && failedCount > 0 ? 'failed' : 'done';
    fields.finished_at = nowIso;
  }
  must(await supabase.from('storage_cleanup_runs').update(fields).eq('id', runId).in('status', ['pending', 'purging']));
  return fields.status || 'purging';
};

/**
 * One sweep. Never throws for a single bad item or step; logs and carries on.
 * @param {Object} [opts]
 * @param {string} [opts.runId]       only this run's due items, and no retention run (scripts/storageCleanup.js)
 * @param {boolean} [opts.retention=true] create the daily automatic run
 * @param {Date} [opts.now]
 */
const runTick = async ({ runId = null, retention = !runId, now = new Date() } = {}) => {
  const startedAt = Date.now();
  const summary = { retentionRun: null, claimed: 0, purged: 0, skipped: 0, failed: 0, runs: {}, ms: 0 };

  if (retention) {
    try {
      const res = await cleanup.createRetentionRun({ now });
      summary.retentionRun = res.created ? res.run.id : (res.reason || null);
    } catch (err) {
      logger.error('Storage cleanup: retention run failed', { message: err.message });
    }
  }

  const ctx = { touchedBusinesses: new Set(), refs: null };
  const touchedRuns = new Set();
  for (let b = 0; b < MAX_BATCHES_PER_TICK; b += 1) {
    let items;
    try {
      items = must(await supabase.rpc('claim_storage_cleanup_items', { p_limit: CLAIM_BATCH, p_run_id: runId }));
    } catch (err) {
      logger.error('Storage cleanup: claim failed', { message: err.message });
      break;
    }
    if (!items || items.length === 0) break;
    summary.claimed += items.length;
    try {
      const res = await processBatch(items, ctx);
      summary.purged += res.purged; summary.skipped += res.skipped; summary.failed += res.failed;
      res.runIds.forEach(id => touchedRuns.add(id));
    } catch (err) {
      logger.error('Storage cleanup: batch failed', { message: err.message });
      for (const item of items) {
        try { await failItem(item, `batch: ${err.message}`); } catch (e) { logger.error('Storage cleanup: could not record failure', { itemId: item.id, message: e.message }); }
        touchedRuns.add(item.run_id);
      }
      summary.failed += items.length;
    }
  }

  // Bot flows that lost an image: the cached reply nodes (1h TTL) would keep sending the dead URL.
  const chatCache = ctx.touchedBusinesses.size > 0 ? require('./chatbot.service') : null;
  for (const businessId of ctx.touchedBusinesses) {
    try { await chatCache.invalidateRulesCache(businessId); } catch (err) { logger.error('Storage cleanup: could not invalidate the flow cache', { businessId, message: err.message }); }
  }

  for (const id of touchedRuns) {
    try { summary.runs[id] = await refreshRun(id); } catch (err) { logger.error('Storage cleanup: could not refresh a run', { runId: id, message: err.message }); }
  }
  summary.ms = Date.now() - startedAt;
  logger.info('Storage cleanup sweep done', { ...summary, runs: Object.keys(summary.runs).length });
  return summary;
};

module.exports = { CLAIM_BATCH, MAX_ATTEMPTS, runTick, processBatch, clearReferences, skipReason };
