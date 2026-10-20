// Run: node --test src/services/catalogCollection.service.test.js
// Collections and photos: plan cap on ACTIVE collections, 100 photos a collection, media must be this
// business's library images, reorder / bulk actions, and the "now-unused photos" follow-up on delete.
// In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('./subscription.service', { getActiveSubscription: async () => (plan ? { status: 'active', plan } : null) });
stub('./unicodeMatching.service', { isUnicodeMatchingEnabled: async () => false });
const deletedMedia = [];
stub('./businessMedia.service', {
  deleteBusinessMedia: async (businessId, mediaId) => {
    if (mediaId === FAILING) throw new Error('boom');
    deletedMedia.push(mediaId);
  }
});
const svc = require('./catalogCollection.service');

const { B1, B2, uuid, url } = h;
const media = (n) => uuid(400 + n);
const FAILING = media(9);
let db; let clock;
const tick = () => new Date(2026, 0, 1, 0, 0, clock++).toISOString();

test.beforeEach(() => {
  db = h.reset(); clock = 0; deletedMedia.length = 0;
  plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 };
  db.flow_nodes = []; db.flow_edges = []; db.catalogs = []; db.catalog_collections = []; db.catalog_items = [];
  db.vehicles = []; db.business_courses = []; db.message_templates = [];
  db.business_media = [1, 2, 3, 4, 5, 9].map(n => ({ id: media(n), business_id: B1, url: url(`m${n}.jpg`), media_type: 'image', file_size_bytes: 100 + n }));
  db.business_media.push({ id: media(6), business_id: B1, url: url('v.mp4'), media_type: 'video', file_size_bytes: 5 });
  db.business_media.push({ id: media(7), business_id: B2, url: url('other.jpg'), media_type: 'image', file_size_bytes: 5 });
});

const addCollection = async (title, over = {}) => {
  const res = await svc.createCollection(B1, { title, ...over });
  assert.equal(res.error, undefined, res.error && res.error.message);
  return res.collection;
};

test('create: appended at the end, active by default; the list shows item count and cover url', async () => {
  const a = await addCollection('Silk', { body: 'Pure silk', priceLabel: 'From 999', coverMediaId: media(1) });
  const b = await addCollection('Cotton');
  assert.deepEqual([a.sortOrder, b.sortOrder, a.isActive], [0, 1, true]);
  assert.deepEqual([a.coverUrl, a.coverSource, b.coverUrl, b.coverSource], [url('m1.jpg'), 'cover', null, null]);
  const items = await svc.createItems(B1, b.id, [{ mediaId: media(2), designNo: 'C-1' }]);
  assert.equal(items.error, undefined);
  const list = await svc.listCollections(B1);
  const cotton = list.find(c => c.id === b.id);
  assert.deepEqual([cotton.itemCount, cotton.coverUrl, cotton.coverSource], [1, url('m2.jpg'), 'firstItem']);
});

test('create: validation errors are 400, a foreign / video cover is refused', async () => {
  assert.equal((await svc.createCollection(B1, {})).error.status, 400);
  assert.equal((await svc.createCollection(B1, { title: 'x', body: 'a\nb\nc\nd' })).error.status, 400);
  assert.match((await svc.createCollection(B1, { title: 'x', coverMediaId: media(7) })).error.message, /not a media library file of this business/);
  assert.match((await svc.createCollection(B1, { title: 'x', coverMediaId: media(6) })).error.message, /images/);
  assert.equal(db.catalog_collections.length, 0);
});

test('plan cap: only ACTIVE collections count; the 4th active on Basic is a 403 PLAN_LIMIT_CATALOG_COLLECTIONS, inactive ones are free', async () => {
  plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3 };
  for (const t of ['A', 'B', 'C']) await addCollection(t);
  const over = await svc.createCollection(B1, { title: 'D' });
  assert.equal(over.error.status, 403);
  assert.deepEqual(over.error.errors, { code: 'PLAN_LIMIT_CATALOG_COLLECTIONS', limit: 3, plan: 'Basic' });
  assert.match(over.error.message, /Basic plan shows up to 3 collections/);
  const draft = await svc.createCollection(B1, { title: 'D', isActive: false });
  assert.equal(draft.error, undefined);
  const activate = await svc.updateCollection(B1, draft.collection.id, { isActive: true });
  assert.equal(activate.error.errors.code, 'PLAN_LIMIT_CATALOG_COLLECTIONS');
  const first = (await svc.listCollections(B1))[0];
  assert.equal((await svc.updateCollection(B1, first.id, { isActive: false })).error, undefined);
  assert.equal((await svc.updateCollection(B1, draft.collection.id, { isActive: true })).error, undefined);
});

test('a downgraded owner can still edit, and the list marks which active collections the carousel shows', async () => {
  for (const t of ['A', 'B', 'C', 'D', 'E']) await addCollection(t);
  plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3 };
  const list = await svc.listCollections(B1);
  assert.deepEqual(list.map(c => c.shownInCarousel), [true, true, true, false, false]);
  assert.equal((await svc.updateCollection(B1, list[4].id, { title: 'E2' })).error, undefined);
});

test('update: partial, unknown id is 404, an empty body is 400', async () => {
  const c = await addCollection('Silk');
  const res = await svc.updateCollection(B1, c.id, { priceLabel: 'From 5', titleTranslations: { hi: 'x' } });
  assert.deepEqual([res.collection.title, res.collection.priceLabel, res.collection.titleTranslations], ['Silk', 'From 5', { hi: 'x' }]);
  assert.equal((await svc.updateCollection(B1, uuid(999), { title: 'x' })).error.status, 404);
  assert.equal((await svc.updateCollection(B1, c.id, {})).error.status, 400);
  assert.equal((await svc.updateCollection(B2, c.id, { title: 'x' })).error.status, 404, 'another business cannot touch it');
});

test('replacing the cover reports the old cover as unused media (and deletes it on request)', async () => {
  const c = await addCollection('Silk', { coverMediaId: media(1) });
  const res = await svc.updateCollection(B1, c.id, { coverMediaId: media(2) });
  assert.deepEqual(res.orphanedMedia.map(o => [o.mediaId, o.url, o.fileSizeBytes]), [[media(1), url('m1.jpg'), 101]]);
  const c2 = await addCollection('Cotton', { coverMediaId: media(3) });
  const del = await svc.updateCollection(B1, c2.id, { coverMediaId: media(4) }, { deleteUnusedMedia: true });
  assert.deepEqual([del.orphanedMedia, del.deletedMediaIds], [[], [media(3)]]);
  assert.deepEqual(deletedMedia, [media(3)]);
});

test('items: added in order after the existing ones, with the photo url; foreign / video / unknown media refused', async () => {
  const c = await addCollection('Silk');
  const res = await svc.createItems(B1, c.id, [
    { mediaId: media(1), designNo: 'A-1', priceText: '999', caption: 'Soft', captionTranslations: { hi: 'x' } },
    { mediaId: media(2) }
  ]);
  assert.deepEqual(res.items.map(i => [i.sortOrder, i.designNo ?? null, i.imageUrl]), [[0, 'A-1', url('m1.jpg')], [1, null, url('m2.jpg')]]);
  const more = await svc.createItems(B1, c.id, [{ mediaId: media(3) }]);
  assert.equal(more.items[0].sortOrder, 2);
  assert.match((await svc.createItems(B1, c.id, [{ mediaId: media(7) }])).error.message, /not a media library file/);
  assert.match((await svc.createItems(B1, c.id, [{ mediaId: media(6) }])).error.message, /images/);
  assert.equal((await svc.createItems(B1, c.id, [{ mediaId: uuid(998) }])).error.status, 400);
  assert.equal((await svc.createItems(B1, c.id, [])).error.status, 400);
  assert.equal((await svc.createItems(B1, c.id, Array.from({ length: 51 }, () => ({ mediaId: media(1) })))).error.status, 400);
  assert.equal((await svc.createItems(B1, uuid(999), [{ mediaId: media(1) }])).error.status, 404);
  assert.equal(db.catalog_items.length, 3, 'a refused batch writes nothing');
});

test('a collection holds at most 100 photos: CATALOG_ITEM_LIMIT says how many fit', async () => {
  const c = await addCollection('Big');
  for (let i = 0; i < 95; i++) db.catalog_items.push({ id: uuid(1000 + i), collection_id: c.id, business_id: B1, media_id: media(1), sort_order: i, created_at: tick() });
  const over = await svc.createItems(B1, c.id, Array.from({ length: 6 }, () => ({ mediaId: media(1) })));
  assert.equal(over.error.status, 400);
  assert.deepEqual(over.error.errors, { code: 'CATALOG_ITEM_LIMIT', limit: 100, current: 95, room: 5 });
  assert.match(over.error.message, /up to 100 photos \(this one has room for 5 more\)/);
  assert.equal((await svc.createItems(B1, c.id, Array.from({ length: 5 }, () => ({ mediaId: media(1) })))).error, undefined);
  assert.equal(db.catalog_items.length, 100);
});

test('update an item: caption / price, a swapped photo reports the old one as unused', async () => {
  const c = await addCollection('Silk');
  const [item] = (await svc.createItems(B1, c.id, [{ mediaId: media(1), designNo: 'A-1' }])).items;
  const res = await svc.updateItem(B1, item.id, { priceText: '1,499', mediaId: media(2) });
  assert.deepEqual([res.item.priceText, res.item.imageUrl], ['1,499', url('m2.jpg')]);
  assert.deepEqual(res.orphanedMedia.map(o => o.mediaId), [media(1)]);
  assert.equal((await svc.updateItem(B1, uuid(999), { priceText: 'x' })).error.status, 404);
  assert.equal((await svc.updateItem(B1, item.id, {})).error.status, 400);
});

test('delete a photo / a collection: items go with the collection, files no longer used are offered, files still used elsewhere are not', async () => {
  const a = await addCollection('A', { coverMediaId: media(1) });
  const b = await addCollection('B');
  const [i1, i2] = (await svc.createItems(B1, a.id, [{ mediaId: media(2) }, { mediaId: media(3) }])).items;
  await svc.createItems(B1, b.id, [{ mediaId: media(3) }]);          // media 3 is also used by collection B
  db.flow_nodes.push({ id: uuid(700), business_id: B1, node_type: 'reply', keyword: 'x', label: 'x', media_id: media(2), gallery_media_ids: [] });
  const one = await svc.deleteItem(B1, i1.id);
  assert.deepEqual(one.orphanedMedia, [], 'media 2 is still a reply photo');
  const whole = await svc.deleteCollection(B1, a.id);
  assert.equal(whole.deletedItems, 1);
  assert.deepEqual(whole.orphanedMedia.map(o => o.mediaId), [media(1)], 'cover is free; media 3 stays used by B');
  void i2; // the items go with the collection through the database's ON DELETE CASCADE (not modelled by the in-memory fake)
  assert.equal((await svc.deleteCollection(B1, a.id)).error.status, 404);
});

test('deleteUnusedMedia deletes the unused files; one that fails to delete stays in orphanedMedia', async () => {
  const c = await addCollection('A');
  const items = (await svc.createItems(B1, c.id, [{ mediaId: media(1) }, { mediaId: FAILING }])).items;
  const res = await svc.bulkItems(B1, c.id, { action: 'delete', itemIds: items.map(i => i.id), deleteUnusedMedia: true });
  assert.equal(res.affected, 2);
  assert.deepEqual(res.deletedMediaIds, [media(1)]);
  assert.deepEqual(res.orphanedMedia.map(o => o.mediaId), [FAILING]);
});

test('reorder collections / photos: ids must be exactly the full set', async () => {
  const [a, b, c] = [await addCollection('A'), await addCollection('B'), await addCollection('C')];
  assert.match((await svc.reorderCollections(B1, [a.id, b.id])).error.message, /every one of the 3 collections/);
  assert.equal((await svc.reorderCollections(B1, [a.id, a.id, b.id])).error.status, 400);
  assert.equal((await svc.reorderCollections(B1, ['x'])).error.status, 400);
  const res = await svc.reorderCollections(B1, [c.id, a.id, b.id]);
  assert.deepEqual(res.collections.map(x => x.title), ['C', 'A', 'B']);

  const items = (await svc.createItems(B1, a.id, [{ mediaId: media(1), designNo: '1' }, { mediaId: media(2), designNo: '2' }, { mediaId: media(3), designNo: '3' }])).items;
  const swapped = await svc.reorderItems(B1, a.id, [items[2].id, items[0].id, items[1].id]);
  assert.deepEqual(swapped.items.map(i => i.designNo), ['3', '1', '2']);
  assert.match((await svc.reorderItems(B1, a.id, [items[0].id])).error.message, /exactly once/);
});

test('bulk: set_price (blank clears), move (appended, 100 cap on the target), unknown / foreign ids refused', async () => {
  const a = await addCollection('A'); const b = await addCollection('B');
  const items = (await svc.createItems(B1, a.id, [{ mediaId: media(1) }, { mediaId: media(2) }, { mediaId: media(3) }])).items;
  const ids = items.map(i => i.id);
  assert.equal((await svc.bulkItems(B1, a.id, { action: 'set_price', itemIds: ids.slice(0, 2), priceText: '₹500' })).affected, 2);
  assert.deepEqual(db.catalog_items.map(i => i.price_text), ['₹500', '₹500', undefined]);
  await svc.bulkItems(B1, a.id, { action: 'set_price', itemIds: [ids[0]], priceText: '' });
  assert.equal(db.catalog_items.find(i => i.id === ids[0]).price_text, null);

  const moved = await svc.bulkItems(B1, a.id, { action: 'move', itemIds: [ids[1], ids[2]], toCollectionId: b.id });
  assert.deepEqual([moved.affected, moved.toCollectionId], [2, b.id]);
  assert.deepEqual(db.catalog_items.filter(i => i.collection_id === b.id).map(i => i.sort_order).sort(), [0, 1]);

  assert.equal((await svc.bulkItems(B1, a.id, { action: 'move', itemIds: [ids[0]], toCollectionId: a.id })).error.status, 400);
  assert.equal((await svc.bulkItems(B1, a.id, { action: 'move', itemIds: [ids[0]], toCollectionId: uuid(999) })).error.status, 400);
  assert.match((await svc.bulkItems(B1, a.id, { action: 'delete', itemIds: [ids[1]] })).error.message, /not in this collection/);
  assert.equal((await svc.bulkItems(B1, a.id, { action: 'explode', itemIds: ids })).error.status, 400);
  assert.equal((await svc.bulkItems(B1, a.id, { action: 'set_price', itemIds: ids })).error.status, 400);

  for (let i = 0; i < 99; i++) db.catalog_items.push({ id: uuid(2000 + i), collection_id: b.id, business_id: B1, media_id: media(1), sort_order: 10 + i, created_at: tick() });
  const full = await svc.bulkItems(B1, a.id, { action: 'move', itemIds: [ids[0]], toCollectionId: b.id });
  assert.equal(full.error.errors.code, 'CATALOG_ITEM_LIMIT');
});

test('list items: paged, with the total', async () => {
  const c = await addCollection('A');
  await svc.createItems(B1, c.id, Array.from({ length: 5 }, (_, i) => ({ mediaId: media(1), designNo: `D${i}` })));
  const page = await svc.listItems(B1, c.id, { limit: 2, offset: 2 });
  assert.deepEqual([page.items.map(i => i.designNo), page.total, page.limit, page.offset], [['D2', 'D3'], 5, 2, 2]);
  assert.equal((await svc.listItems(B1, uuid(999))).error.status, 404);
});
