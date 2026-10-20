const crypto = require('crypto');
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const { getMediaUsage } = require('./mediaUsage.service');
const { planOf, fail } = require('./catalog.service');
const { shapeCollectionAuto, shapeItemAuto } = require('../utils/translationSlots');
const {
  MAX_ITEMS_PER_COLLECTION, MAX_ITEMS_PER_REQUEST, PRICE_TEXT_MAX,
  validateCollectionInput, validateItemInput, cleanText, isUuid
} = require('../utils/catalogValidation');

// Collections and items of the Catalogue (owner writes, any role reads - see catalog.routes.js).
// A collection is one card of the carousel; an item is one photo. Everything is scoped by business_id
// on every query. Media must be a library IMAGE of the same business (the batch upload endpoint puts
// them there); the FK / usage checks keep a file in use from being deleted from under the bot.

const BULK_ACTIONS = ['delete', 'move', 'set_price'];

const bySortOrder = (a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || String(a.created_at || '').localeCompare(String(b.created_at || ''));

const must = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};

// ---- shaping -----------------------------------------------------------------------------------------

const mediaMap = async (businessId, ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = must(await supabase.from('business_media').select('id, url, media_type, file_size_bytes').eq('business_id', businessId).in('id', unique));
  return new Map(rows.map(r => [r.id, r]));
};

const shapeCollectionRow = (row) => {
  const out = toCamelCase(row);
  out.autoTranslated = shapeCollectionAuto(row);
  delete out.autoTranslations;
  return out;
};

const shapeItemRow = (row, media) => {
  const out = toCamelCase(row);
  out.imageUrl = media ? media.url : null;
  out.autoTranslated = shapeItemAuto(row);
  delete out.autoTranslations;
  return out;
};

/** Collections of the business in display order, with item counts, cover url and whether the carousel shows them. */
const listCollections = async (businessId) => {
  const rows = must(await supabase.from('catalog_collections').select('*').eq('business_id', businessId)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true })).sort(bySortOrder);
  if (rows.length === 0) return [];
  const items = must(await supabase.from('catalog_items').select('id, collection_id, media_id, sort_order').eq('business_id', businessId)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true }));
  const countBy = new Map();
  const firstMediaBy = new Map();
  for (const item of items) {
    countBy.set(item.collection_id, (countBy.get(item.collection_id) || 0) + 1);
    if (!firstMediaBy.has(item.collection_id)) firstMediaBy.set(item.collection_id, item.media_id);
  }
  const media = await mediaMap(businessId, rows.flatMap(c => [c.cover_media_id, firstMediaBy.get(c.id)]));
  const { carouselMaxCards } = await planOf(businessId);

  let shown = 0;
  return rows.map((row) => {
    const coverFromItem = !row.cover_media_id ? firstMediaBy.get(row.id) : null;
    const coverMedia = media.get(row.cover_media_id || coverFromItem) || null;
    const shownInCarousel = row.is_active && shown < carouselMaxCards;
    if (shownInCarousel) shown += 1;
    return {
      ...shapeCollectionRow(row),
      itemCount: countBy.get(row.id) || 0,
      coverUrl: coverMedia ? coverMedia.url : null,
      coverSource: row.cover_media_id ? 'cover' : (coverFromItem ? 'firstItem' : null),
      shownInCarousel
    };
  });
};

const getCollection = async (businessId, id) => {
  if (!isUuid(id)) return null;
  return (await listCollections(businessId)).find(c => c.id === id) || null;
};

// ---- guards ------------------------------------------------------------------------------------------

const assertImageMedia = async (businessId, mediaIds) => {
  const unique = [...new Set(mediaIds)];
  const media = await mediaMap(businessId, unique);
  for (const id of unique) {
    const row = media.get(id);
    if (!row) return { error: fail(400, `mediaId ${id} is not a media library file of this business.`).error };
    if (row.media_type !== 'image') return { error: fail(400, 'Catalogue photos must be images.').error };
  }
  return { media };
};

/** 403 when making `increase` more collections ACTIVE would pass the plan's carousel card limit. */
const planCapError = async (businessId, increase) => {
  if (increase <= 0) return null;
  const { name, carouselMaxCards } = await planOf(businessId);
  const rows = must(await supabase.from('catalog_collections').select('id').eq('business_id', businessId).eq('is_active', true));
  if (rows.length + increase > carouselMaxCards) {
    return fail(403, `Your ${name} plan shows up to ${carouselMaxCards} collections in the catalogue carousel. Switch another collection off first, or upgrade your plan.`,
      { code: 'PLAN_LIMIT_CATALOG_COLLECTIONS', limit: carouselMaxCards, plan: name }).error;
  }
  return null;
};

const itemLimitError = (current, adding) => {
  if (current + adding > MAX_ITEMS_PER_COLLECTION) {
    const room = Math.max(0, MAX_ITEMS_PER_COLLECTION - current);
    return fail(400, `A collection can hold up to ${MAX_ITEMS_PER_COLLECTION} photos (this one has room for ${room} more).`,
      { code: 'CATALOG_ITEM_LIMIT', limit: MAX_ITEMS_PER_COLLECTION, current, room }).error;
  }
  return null;
};

// ---- media follow-up ---------------------------------------------------------------------------------

/**
 * Library files that no longer have a use after a delete / photo swap, so the app can offer "delete the
 * now-unused photos too?". With deleteUnused the unused ones are deleted here (deleteBusinessMedia re-checks
 * usage; one that fails stays in orphanedMedia).
 * @returns {Promise<{ orphanedMedia: Object[], deletedMediaIds: string[] }>}
 */
const settleMedia = async (businessId, mediaIds, { deleteUnused = false } = {}) => {
  const media = await mediaMap(businessId, mediaIds);
  const orphaned = [];
  for (const [id, row] of media) {
    const usage = await getMediaUsage(businessId, id);
    if (usage.found && !usage.inUse) orphaned.push({ mediaId: id, url: row.url, fileSizeBytes: Number(row.file_size_bytes) || null });
  }
  if (!deleteUnused || orphaned.length === 0) return { orphanedMedia: orphaned, deletedMediaIds: [] };
  const { deleteBusinessMedia } = require('./businessMedia.service');
  const deleted = [];
  const left = [];
  for (const entry of orphaned) {
    try {
      await deleteBusinessMedia(businessId, entry.mediaId);
      deleted.push(entry.mediaId);
    } catch (error) {
      logger.warn('Catalogue: could not delete an unused photo', { businessId, mediaId: entry.mediaId, message: error.message });
      left.push(entry);
    }
  }
  return { orphanedMedia: left, deletedMediaIds: deleted };
};

// ---- collections -------------------------------------------------------------------------------------

const createCollection = async (businessId, input) => {
  const parsed = validateCollectionInput(input, { partial: false });
  if (parsed.error) return fail(400, parsed.error);
  const value = parsed.value;
  const isActive = value.is_active !== false;
  if (value.cover_media_id) {
    const check = await assertImageMedia(businessId, [value.cover_media_id]);
    if (check.error) return { error: check.error };
  }
  const capError = await planCapError(businessId, isActive ? 1 : 0);
  if (capError) return { error: capError };

  const last = must(await supabase.from('catalog_collections').select('sort_order').eq('business_id', businessId)
    .order('sort_order', { ascending: false }).limit(1));
  const sortOrder = last.length > 0 ? (last[0].sort_order || 0) + 1 : 0;
  const { data, error } = await supabase.from('catalog_collections')
    .insert({ ...value, id: crypto.randomUUID(), business_id: businessId, is_active: isActive, sort_order: sortOrder }).select().single();
  if (error) throw error;
  return { collection: await getCollection(businessId, data.id) };
};

const updateCollection = async (businessId, id, input, { deleteUnusedMedia = false } = {}) => {
  const existing = must(await supabase.from('catalog_collections').select('*').eq('id', id).eq('business_id', businessId))[0];
  if (!existing) return fail(404, 'Collection not found.');
  const parsed = validateCollectionInput(input, { partial: true });
  if (parsed.error) return fail(400, parsed.error);
  const value = parsed.value;
  if (Object.keys(value).length === 0) return fail(400, 'Nothing to update.');

  if (value.cover_media_id) {
    const check = await assertImageMedia(businessId, [value.cover_media_id]);
    if (check.error) return { error: check.error };
  }
  if (value.is_active === true && !existing.is_active) {
    const capError = await planCapError(businessId, 1);
    if (capError) return { error: capError };
  }
  const { error } = await supabase.from('catalog_collections').update(value).eq('id', id).eq('business_id', businessId);
  if (error) throw error;

  const result = { collection: await getCollection(businessId, id), orphanedMedia: [], deletedMediaIds: [] };
  if (Object.prototype.hasOwnProperty.call(value, 'cover_media_id') && existing.cover_media_id && existing.cover_media_id !== value.cover_media_id) {
    Object.assign(result, await settleMedia(businessId, [existing.cover_media_id], { deleteUnused: deleteUnusedMedia }));
  }
  return result;
};

const deleteCollection = async (businessId, id, { deleteUnusedMedia = false } = {}) => {
  const existing = must(await supabase.from('catalog_collections').select('id, cover_media_id').eq('id', id).eq('business_id', businessId))[0];
  if (!existing) return fail(404, 'Collection not found.');
  const items = must(await supabase.from('catalog_items').select('media_id').eq('collection_id', id).eq('business_id', businessId));
  const mediaIds = [existing.cover_media_id, ...items.map(i => i.media_id)].filter(Boolean);
  const { error } = await supabase.from('catalog_collections').delete().eq('id', id).eq('business_id', businessId);
  if (error) throw error;
  return { deletedItems: items.length, ...(await settleMedia(businessId, mediaIds, { deleteUnused: deleteUnusedMedia })) };
};

/** ids must be exactly the business's collections (all of them), in the new order. */
const reorderCollections = async (businessId, ids) => {
  const rows = must(await supabase.from('catalog_collections').select('id').eq('business_id', businessId));
  const problem = reorderProblem(ids, rows.map(r => r.id), 'collections');
  if (problem) return fail(400, problem);
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase.from('catalog_collections').update({ sort_order: i }).eq('id', ids[i]).eq('business_id', businessId);
    if (error) throw error;
  }
  return { collections: await listCollections(businessId) };
};

const reorderProblem = (ids, existingIds, noun) => {
  if (!Array.isArray(ids) || !ids.every(isUuid)) return 'ids must be an array of ids.';
  if (new Set(ids).size !== ids.length) return 'ids must not contain duplicates.';
  const have = new Set(existingIds);
  if (ids.length !== have.size || !ids.every(id => have.has(id))) return `ids must list every one of the ${have.size} ${noun}, exactly once.`;
  return null;
};

// ---- items -------------------------------------------------------------------------------------------

const itemsOf = async (businessId, collectionId) =>
  must(await supabase.from('catalog_items').select('*').eq('collection_id', collectionId).eq('business_id', businessId)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true })).sort(bySortOrder);

const collectionExists = async (businessId, collectionId) =>
  isUuid(collectionId) && must(await supabase.from('catalog_collections').select('id').eq('id', collectionId).eq('business_id', businessId)).length > 0;

const listItems = async (businessId, collectionId, { limit = 50, offset = 0 } = {}) => {
  if (!(await collectionExists(businessId, collectionId))) return fail(404, 'Collection not found.');
  const all = await itemsOf(businessId, collectionId);
  const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_ITEMS_PER_COLLECTION);
  const start = Math.max(parseInt(offset, 10) || 0, 0);
  const page = all.slice(start, start + size);
  const media = await mediaMap(businessId, page.map(i => i.media_id));
  return { items: page.map(i => shapeItemRow(i, media.get(i.media_id))), total: all.length, limit: size, offset: start };
};

const createItems = async (businessId, collectionId, items) => {
  if (!(await collectionExists(businessId, collectionId))) return fail(404, 'Collection not found.');
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_REQUEST) {
    return fail(400, `items must be an array of 1 to ${MAX_ITEMS_PER_REQUEST} photos.`);
  }
  const values = [];
  for (let i = 0; i < items.length; i++) {
    const parsed = validateItemInput(items[i], { partial: false });
    if (parsed.error) return fail(400, `Item ${i + 1}: ${parsed.error}`);
    values.push(parsed.value);
  }
  const existing = await itemsOf(businessId, collectionId);
  const limitError = itemLimitError(existing.length, values.length);
  if (limitError) return { error: limitError };
  const check = await assertImageMedia(businessId, values.map(v => v.media_id));
  if (check.error) return { error: check.error };

  const start = existing.reduce((max, i) => Math.max(max, i.sort_order || 0), -1) + 1;
  const rows = values.map((v, i) => ({ ...v, id: crypto.randomUUID(), collection_id: collectionId, business_id: businessId, sort_order: start + i }));
  const { data, error } = await supabase.from('catalog_items').insert(rows).select();
  if (error) throw error;
  const created = (data || []).sort((a, b) => a.sort_order - b.sort_order);
  return { items: created.map(i => shapeItemRow(i, check.media.get(i.media_id))) };
};

const getItemRow = async (businessId, itemId) =>
  (isUuid(itemId) ? must(await supabase.from('catalog_items').select('*').eq('id', itemId).eq('business_id', businessId))[0] : null) || null;

const updateItem = async (businessId, itemId, input, { deleteUnusedMedia = false } = {}) => {
  const existing = await getItemRow(businessId, itemId);
  if (!existing) return fail(404, 'Photo not found.');
  const parsed = validateItemInput(input, { partial: true });
  if (parsed.error) return fail(400, parsed.error);
  if (Object.keys(parsed.value).length === 0) return fail(400, 'Nothing to update.');
  let media = null;
  if (parsed.value.media_id) {
    const check = await assertImageMedia(businessId, [parsed.value.media_id]);
    if (check.error) return { error: check.error };
    media = check.media.get(parsed.value.media_id);
  }
  const { data, error } = await supabase.from('catalog_items').update(parsed.value).eq('id', itemId).eq('business_id', businessId).select().single();
  if (error) throw error;
  const mediaRows = media ? new Map([[media.id, media]]) : await mediaMap(businessId, [data.media_id]);
  const result = { item: shapeItemRow(data, mediaRows.get(data.media_id)), orphanedMedia: [], deletedMediaIds: [] };
  if (parsed.value.media_id && parsed.value.media_id !== existing.media_id) {
    Object.assign(result, await settleMedia(businessId, [existing.media_id], { deleteUnused: deleteUnusedMedia }));
  }
  return result;
};

const deleteItem = async (businessId, itemId, { deleteUnusedMedia = false } = {}) => {
  const existing = await getItemRow(businessId, itemId);
  if (!existing) return fail(404, 'Photo not found.');
  const { error } = await supabase.from('catalog_items').delete().eq('id', itemId).eq('business_id', businessId);
  if (error) throw error;
  return settleMedia(businessId, [existing.media_id], { deleteUnused: deleteUnusedMedia });
};

const reorderItems = async (businessId, collectionId, ids) => {
  if (!(await collectionExists(businessId, collectionId))) return fail(404, 'Collection not found.');
  const rows = await itemsOf(businessId, collectionId);
  const problem = reorderProblem(ids, rows.map(r => r.id), 'photos');
  if (problem) return fail(400, problem);
  for (let i = 0; i < ids.length; i++) {
    const { error } = await supabase.from('catalog_items').update({ sort_order: i }).eq('id', ids[i]).eq('business_id', businessId);
    if (error) throw error;
  }
  return listItems(businessId, collectionId, { limit: MAX_ITEMS_PER_COLLECTION });
};

/**
 * POST .../items/bulk. body: { action: 'delete'|'move'|'set_price', itemIds: [...], toCollectionId? (move),
 * priceText? (set_price; blank / null clears), deleteUnusedMedia? (delete) }.
 */
const bulkItems = async (businessId, collectionId, body) => {
  if (!(await collectionExists(businessId, collectionId))) return fail(404, 'Collection not found.');
  const { action, itemIds } = body || {};
  if (!BULK_ACTIONS.includes(action)) return fail(400, `action must be one of: ${BULK_ACTIONS.join(', ')}.`);
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > MAX_ITEMS_PER_COLLECTION || !itemIds.every(isUuid)) {
    return fail(400, `itemIds must be an array of 1 to ${MAX_ITEMS_PER_COLLECTION} photo ids.`);
  }
  const unique = [...new Set(itemIds)];
  const rows = (await itemsOf(businessId, collectionId)).filter(r => unique.includes(r.id));
  if (rows.length !== unique.length) return fail(400, 'Some photos are not in this collection.');

  if (action === 'delete') {
    const { error } = await supabase.from('catalog_items').delete().in('id', unique).eq('business_id', businessId);
    if (error) throw error;
    const settled = await settleMedia(businessId, rows.map(r => r.media_id), { deleteUnused: body.deleteUnusedMedia === true });
    return { affected: unique.length, ...settled };
  }

  if (action === 'set_price') {
    if (body.priceText === undefined) return fail(400, 'priceText is required (blank clears the price).');
    const cleaned = cleanText(body.priceText, 'priceText', PRICE_TEXT_MAX);
    if (cleaned.error) return fail(400, cleaned.error);
    const { error } = await supabase.from('catalog_items').update({ price_text: cleaned.value }).in('id', unique).eq('business_id', businessId);
    if (error) throw error;
    return { affected: unique.length };
  }

  // move
  const target = body.toCollectionId;
  if (!isUuid(target) || target === collectionId || !(await collectionExists(businessId, target))) {
    return fail(400, 'toCollectionId must be another collection of this business.');
  }
  const targetItems = await itemsOf(businessId, target);
  const limitError = itemLimitError(targetItems.length, unique.length);
  if (limitError) return { error: limitError };
  const start = targetItems.reduce((max, i) => Math.max(max, i.sort_order || 0), -1) + 1;
  const ordered = rows.sort((a, b) => (a.sort_order - b.sort_order));
  for (let i = 0; i < ordered.length; i++) {
    const { error } = await supabase.from('catalog_items').update({ collection_id: target, sort_order: start + i }).eq('id', ordered[i].id).eq('business_id', businessId);
    if (error) throw error;
  }
  return { affected: unique.length, toCollectionId: target };
};

module.exports = {
  listCollections, getCollection, createCollection, updateCollection, deleteCollection, reorderCollections,
  listItems, createItems, updateItem, deleteItem, reorderItems, bulkItems,
  // shared with the renderer / tests
  settleMedia, itemsOf, BULK_ACTIONS
};
