// Storage cleanup, read side: what is in R2 and what in the database points at it.
//
//   scan()        lists the known R2 folders (utils/storageKinds.js) and joins every
//                 object to its database references
//   classify      each object becomes { kind, referenced, inUse, protected, usedBy, ... }
//   selectItems() applies a run's filters
//
// Reads R2 and ApnaBot's own database only. Never calls Meta / WhatsApp.
const supabase = require('../config/supabase');
const r2 = require('./r2.service');
const { r2KeyFromUrl } = require('../utils/r2Key');
const { istDayStart } = require('../utils/ist');
const { KNOWN_PREFIXES, PREFIX_KIND, CHAT_KINDS, parseKey, publicUrlOf } = require('../utils/storageKinds');

const PAGE = 1000;
const ID_CHUNK = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MIN_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_SCAN_OBJECTS = 200000;

const PROTECTED_IMAGE_ONLY = 'image-only reply';
const PROTECTED_ADVANCE_PAYMENT = 'advance payment is on';
const PROTECTED_SHARED_CATALOG = 'shared catalog photo';
const PROTECTED_CATEGORY_TEMPLATE = 'used by category template';

const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const fetchAll = async (table, columns, apply = (q) => q) => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await apply(supabase.from(table).select(columns)).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) return rows;
  }
};

/**
 * Every database reference to an R2 object, keyed by object key.
 * A usage is { type, id, businessId, label, protected, reason }; "protected"
 * ones are never purged, not even with include_in_use.
 * @returns {Promise<{ byKey: Map<string, Object[]>, mediaByKey: Map<string, Object>, businesses: Map<string, Object> }>}
 */
const loadReferences = async ({ businessId = null } = {}) => {
  const scoped = (q) => (businessId ? q.eq('business_id', businessId) : q);
  const byKey = new Map();
  const add = (key, usage) => {
    if (!key) return;
    const list = byKey.get(key) || [];
    if (!list.some(u => u.type === usage.type && u.id === usage.id)) list.push(usage);
    byKey.set(key, list);
  };

  const mediaRows = await fetchAll('business_media', 'id, business_id, r2_key, url, file_size_bytes, media_type', scoped);
  const mediaByKey = new Map(mediaRows.map(m => [m.r2_key, m]));
  const mediaById = new Map(mediaRows.map(m => [m.id, m]));

  const nodes = await fetchAll('flow_nodes', 'id, business_id, keyword, label, image_url, media_id',
    (q) => scoped(q).or('image_url.not.is.null,media_id.not.is.null'));
  for (const n of nodes) {
    // A reply whose only content is its image would send an EMPTY message once
    // the image is gone (Meta rejects it): never purge those. A translated label
    // falls back to this base label (utils/localization.js), so the base label
    // is what matters.
    const imageOnly = !String(n.label || '').trim();
    const usage = {
      type: 'flow_node', id: n.id, businessId: n.business_id, label: n.keyword || n.label || n.id,
      protected: imageOnly, reason: imageOnly ? PROTECTED_IMAGE_ONLY : null
    };
    add(n.media_id && mediaById.has(n.media_id) ? mediaById.get(n.media_id).r2_key : null, usage);
    add(r2KeyFromUrl(n.image_url), usage);
  }

  // Saved flow versions (flow_snapshots.nodes = full flow_nodes rows). Restoring one puts its
  // images back, so a snapshot that references a file keeps it in use; a category starter
  // template (copied into new businesses) is never purged. A snapshot node with no text would
  // send an empty message once its image is gone, exactly like a live image-only node.
  const snapshots = await fetchAll('flow_snapshots', 'id, business_id, name, nodes, is_category_template',
    (q) => (businessId ? q.or(`business_id.eq.${businessId},is_category_template.eq.true`) : q));
  for (const snap of snapshots) {
    for (const n of Array.isArray(snap.nodes) ? snap.nodes : []) {
      const imageOnly = !String(n.label || '').trim();
      const isTemplate = !!snap.is_category_template;
      const usage = {
        type: 'flow_snapshot', id: snap.id, businessId: snap.business_id, label: snap.name,
        protected: isTemplate || imageOnly,
        reason: isTemplate ? PROTECTED_CATEGORY_TEMPLATE : (imageOnly ? PROTECTED_IMAGE_ONLY : null)
      };
      add(n.media_id && mediaById.has(n.media_id) ? mediaById.get(n.media_id).r2_key : null, usage);
      add(r2KeyFromUrl(n.image_url), usage);
    }
  }

  const templates = await fetchAll('message_templates',
    'id, business_id, name, header_media_id, header_media_url, header_image_url, header_image_r2_key',
    (q) => scoped(q).or('header_media_id.not.is.null,header_media_url.not.is.null,header_image_url.not.is.null,header_image_r2_key.not.is.null'));
  for (const t of templates) {
    const usage = { type: 'template', id: t.id, businessId: t.business_id, label: t.name, protected: false, reason: null };
    add(t.header_media_id && mediaById.has(t.header_media_id) ? mediaById.get(t.header_media_id).r2_key : null, usage);
    add(r2KeyFromUrl(t.header_media_url), usage);
    add(r2KeyFromUrl(t.header_image_url), usage);
    add(t.header_image_r2_key, usage);
  }

  const courses = await fetchAll('business_courses', 'id, business_id, name, image_media_id',
    (q) => scoped(q).not('image_media_id', 'is', null));
  for (const c of courses) {
    const m = mediaById.get(c.image_media_id);
    add(m && m.r2_key, { type: 'course', id: c.id, businessId: c.business_id, label: c.name, protected: false, reason: null });
  }

  const bizRows = await fetchAll('businesses', 'id, name, payment_qr_url, profile_image, require_advance_payment',
    (q) => (businessId ? q.eq('id', businessId) : q));
  const businesses = new Map(bizRows.map(b => [b.id, b]));
  for (const b of bizRows) {
    add(r2KeyFromUrl(b.payment_qr_url), {
      type: 'payment_qr', id: b.id, businessId: b.id, label: b.name,
      protected: !!b.require_advance_payment, reason: b.require_advance_payment ? PROTECTED_ADVANCE_PAYMENT : null
    });
    add(r2KeyFromUrl(b.profile_image), { type: 'logo', id: b.id, businessId: b.id, label: b.name, protected: false, reason: null });
  }

  const vehicles = await fetchAll('vehicles', 'id, business_id, custom_name, custom_photo_url',
    (q) => scoped(q).not('custom_photo_url', 'is', null));
  for (const v of vehicles) {
    add(r2KeyFromUrl(v.custom_photo_url), { type: 'vehicle', id: v.id, businessId: v.business_id, label: v.custom_name || v.id, protected: false, reason: null });
  }
  if (!businessId) {
    const catalog = await fetchAll('vehicle_type_catalog', 'id, name, photo_url', (q) => q.not('photo_url', 'is', null));
    for (const c of catalog) {
      add(r2KeyFromUrl(c.photo_url), { type: 'vehicle_catalog', id: c.id, businessId: null, label: c.name, protected: true, reason: PROTECTED_SHARED_CATALOG });
    }
  }
  return { byKey, mediaByKey, businesses };
};

/** message id -> media_url for the chat objects' message ids (a chat file is "referenced" while its message points at it). */
const loadChatMessages = async (objects) => {
  const ids = [...new Set(objects.map(o => parseKey(o.key)).filter(p => p && p.messageId).map(p => p.messageId))];
  const byId = new Map();
  for (const chunk of chunksOf(ids, ID_CHUNK)) {
    const { data, error } = await supabase.from('messages').select('id, media_url').in('id', chunk);
    if (error) throw error;
    (data || []).forEach(m => byId.set(m.id, m.media_url));
  }
  return byId;
};

/**
 * One object -> what it is and who uses it.
 *   referenced  something in the database still points at it (else: an orphan)
 *   inUse       a live feature uses it (chat files are "safe", never in use)
 *   protected   never purge (image-only reply, advance-payment QR, shared catalog photo)
 */
const classifyObject = (obj, { refs, chatMessages }) => {
  const parsed = parseKey(obj.key);
  if (!parsed) return null;
  const url = publicUrlOf(obj.key);
  const usages = refs.byKey.get(obj.key) || [];
  const isChat = CHAT_KINDS.includes(parsed.prefixKind);
  const media = refs.mediaByKey.get(obj.key);

  let referenced;
  if (isChat) referenced = !!parsed.messageId && chatMessages.get(parsed.messageId) === url;
  else if (parsed.prefix === 'business-media/') referenced = !!media;
  else referenced = usages.length > 0;

  const inUse = !isChat && usages.length > 0;
  // A template (or image-only) reference outranks any other: pick that reason.
  const prot = usages.find(u => u.protected && u.reason === PROTECTED_CATEGORY_TEMPLATE) || usages.find(u => u.protected);

  let kind = parsed.prefixKind;
  if (!referenced) kind = 'orphan';
  else if (parsed.prefix === 'business-media/') {
    if (usages.some(u => u.type === 'flow_node' || u.type === 'flow_snapshot')) kind = 'bot_node_image';
    else if (usages.some(u => u.type === 'template')) kind = 'template_header';
    else if (usages.some(u => u.type === 'course')) kind = 'course_image';
  }

  const businessId = (media && media.business_id) || (usages.find(u => u.businessId) || {}).businessId || parsed.businessId || null;
  return {
    key: obj.key,
    url,
    kind,
    businessId,
    sizeBytes: obj.size,
    objectDate: obj.lastModified ? new Date(obj.lastModified).toISOString() : null,
    referenced,
    inUse,
    protected: !!prot,
    protectedReason: prot ? prot.reason : null,
    usedBy: usages.map(u => ({ type: u.type, id: u.id, label: u.label }))
  };
};

/**
 * List R2 and classify everything found.
 * @param {Object} [opts]
 * @param {string|null} [opts.businessId] only this business's objects
 * @param {string[]} [opts.prefixes] default: every known folder
 * @returns {Promise<{ entries: Object[], truncated: boolean, businesses: Map<string,Object> }>}
 */
const scan = async ({ businessId = null, prefixes = KNOWN_PREFIXES, maxObjects = MAX_SCAN_OBJECTS } = {}) => {
  const objects = [];
  let truncated = false;
  for (const prefix of prefixes) {
    const scopedPrefix = businessId && CHAT_KINDS.includes(PREFIX_KIND[prefix]) ? `${prefix}${businessId}/` : prefix;
    const res = await r2.listObjects(scopedPrefix, { maxObjects: maxObjects - objects.length });
    objects.push(...res.objects);
    if (res.truncated || objects.length >= maxObjects) { truncated = true; break; }
  }
  const refs = await loadReferences({ businessId });
  const chatMessages = await loadChatMessages(objects.filter(o => CHAT_KINDS.includes((parseKey(o.key) || {}).prefixKind)));
  let entries = objects.map(o => classifyObject(o, { refs, chatMessages })).filter(Boolean);
  if (businessId) entries = entries.filter(e => e.businessId === businessId);
  return { entries, truncated, businesses: refs.businesses };
};

// ── Filters ──

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' (India time) -> the instant that day begins, or null when malformed. */
const istDateStart = (value) => {
  if (!DATE_RE.test(value || '')) return null;
  const d = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : istDayStart(d);
};

/**
 * Applies a run's filters to classified entries.
 * @param {Object[]} entries
 * @param {Object} filters { kinds, from, to, businessId, minBytes, includeInUse, orphanMode }
 * @param {Object} [opts] { now, excludeKeys: Set of keys already in an open run }
 * @returns {{ selected: Object[], excluded: Object }} excluded: counts + bytes per reason
 */
const selectItems = (entries, filters, { now = new Date(), excludeKeys = new Set() } = {}) => {
  const excluded = {
    inUse: { count: 0, bytes: 0 }, protected: { count: 0, bytes: 0 },
    alreadyPending: { count: 0, bytes: 0 }, tooYoung: { count: 0, bytes: 0 }
  };
  const bump = (reason, e) => { excluded[reason].count += 1; excluded[reason].bytes += e.sizeBytes; };
  const kinds = filters.kinds && filters.kinds.length ? new Set(filters.kinds) : null;
  const fromMs = filters.from ? istDateStart(filters.from).getTime() : null;
  const toMs = filters.to ? istDateStart(filters.to).getTime() + DAY_MS : null; // inclusive day
  const selected = [];

  for (const e of entries) {
    if (filters.orphanMode ? e.referenced : !e.referenced) continue;
    if (filters.businessId && filters.businessId !== 'all' && e.businessId !== filters.businessId) continue;
    if (kinds && !kinds.has(e.kind)) continue;
    const date = e.objectDate ? new Date(e.objectDate).getTime() : null;
    if (fromMs !== null && (date === null || date < fromMs)) continue;
    if (toMs !== null && (date === null || date >= toMs)) continue;
    if (filters.minBytes && e.sizeBytes < filters.minBytes) continue;
    if (filters.orphanMode && (date === null || now.getTime() - date < ORPHAN_MIN_AGE_MS)) { bump('tooYoung', e); continue; }
    if (e.protected) { bump('protected', e); continue; }
    if (e.inUse && !filters.includeInUse) { bump('inUse', e); continue; }
    if (excludeKeys.has(e.key)) { bump('alreadyPending', e); continue; }
    selected.push(e);
  }
  return { selected, excluded };
};

/** Totals by kind and by business for a list of entries. */
const summarize = (entries, businesses = new Map()) => {
  const byKind = {};
  const byBusiness = {};
  let count = 0;
  let bytes = 0;
  for (const e of entries) {
    count += 1; bytes += e.sizeBytes;
    const k = (byKind[e.kind] = byKind[e.kind] || { count: 0, bytes: 0 });
    k.count += 1; k.bytes += e.sizeBytes;
    const bid = e.businessId || 'none';
    const b = (byBusiness[bid] = byBusiness[bid] || { businessId: e.businessId, name: e.businessId ? (businesses.get(e.businessId) || {}).name || null : 'Platform / unattributed', count: 0, bytes: 0, chatMediaBytes: 0 });
    b.count += 1; b.bytes += e.sizeBytes;
    if (CHAT_KINDS.includes(e.kind)) b.chatMediaBytes += e.sizeBytes;
  }
  return { count, bytes, byKind, byBusiness: Object.values(byBusiness).sort((a, b) => b.bytes - a.bytes) };
};

module.exports = {
  ORPHAN_MIN_AGE_MS, MAX_SCAN_OBJECTS, PROTECTED_IMAGE_ONLY,
  loadReferences, loadChatMessages, classifyObject, scan, selectItems, summarize, istDateStart
};
