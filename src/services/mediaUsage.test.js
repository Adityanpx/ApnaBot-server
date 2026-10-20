// Run: node --test src/services/mediaUsage.test.js
// One source of truth for "where is this library file used?": GET /media/:id/usage and DELETE /media/:id
// must never disagree, and carousel cards, courses and vehicles count as uses. In-memory Supabase
// (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
require('./r2.service').deleteImage = async () => {};
const businessMedia = require('./businessMedia.service');
const mediaUsage = require('./mediaUsage.service');
const controller = require('../controllers/businessMedia.controller');

const { B1, B2, uuid, url } = h;
const [MAIN, GALLERY, VIDEO, CARD, TPL, COURSE, VEHICLE, FREE] = [1, 2, 3, 4, 5, 6, 7, 8].map(n => uuid(100 + n));
const ALL = [MAIN, GALLERY, VIDEO, CARD, TPL, COURSE, VEHICLE, FREE];

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_media = ALL.map(id => ({ id, business_id: B1, r2_key: `k-${id}`, url: url(`k-${id}`), file_size_bytes: 10, media_type: 'image' }));
  db.flow_nodes = [
    { id: uuid(200), business_id: B1, node_type: 'reply', keyword: 'rooms', label: 'Rooms', media_id: MAIN, gallery_media_ids: [GALLERY], video_media_id: VIDEO },
    { id: uuid(201), business_id: B1, node_type: 'reply', keyword: 'stay', label: 'Stay', content_type: 'carousel', gallery_media_ids: [],
      carousel_cards: [{ media_id: null, media_type: 'image', body: 'x' }, { media_id: CARD, media_type: 'image', body: 'y' }] },
    { id: uuid(202), business_id: B2, node_type: 'reply', keyword: 'other-biz', label: 'Other', content_type: 'carousel', gallery_media_ids: [],
      carousel_cards: [{ media_id: FREE, media_type: 'image', body: 'z' }] }
  ];
  db.message_templates = [{ id: uuid(300), business_id: B1, name: 'promo', header_media_id: TPL }];
  db.business_courses = [{ id: uuid(301), business_id: B1, name: 'Yoga 101', image_media_id: COURSE }];
  db.vehicles = [{ id: uuid(302), business_id: B1, custom_name: 'Innova', custom_photo_url: url(`k-${VEHICLE}`) }];
});

const usage = (id) => mediaUsage.getMediaUsage(B1, id);
const del = async (id) => { try { await businessMedia.deleteBusinessMedia(B1, id); return null; } catch (e) { return e; } };

test('every kind of use is reported with its label, and a carousel card with its 1-based position', async () => {
  assert.deepEqual((await usage(MAIN)).usedBy, [{ kind: 'reply_image', nodeId: uuid(200), label: 'rooms' }]);
  assert.deepEqual((await usage(GALLERY)).usedBy, [{ kind: 'gallery', nodeId: uuid(200), label: 'rooms' }]);
  assert.deepEqual((await usage(VIDEO)).usedBy, [{ kind: 'video', nodeId: uuid(200), label: 'rooms' }]);
  assert.deepEqual((await usage(CARD)).usedBy, [{ kind: 'carousel_card', nodeId: uuid(201), label: 'stay', cardIndex: 2 }]);
  assert.deepEqual((await usage(TPL)).usedBy, [{ kind: 'template_header', id: uuid(300), label: 'promo' }]);
  assert.deepEqual((await usage(COURSE)).usedBy, [{ kind: 'course', id: uuid(301), label: 'Yoga 101' }]);
  assert.deepEqual((await usage(VEHICLE)).usedBy, [{ kind: 'vehicle', id: uuid(302), label: 'Innova' }]);
});

test('an unused file: inUse false with its size; a foreign business\'s card does not count; a foreign id is not found', async () => {
  const free = await usage(FREE);
  assert.deepEqual([free.found, free.inUse, free.usedBy, free.fileSizeBytes], [true, false, [], 10]);
  assert.equal((await mediaUsage.getMediaUsage(B2, MAIN)).found, false);
  assert.equal((await mediaUsage.getMediaUsage(B1, uuid(999))).found, false);
});

test('usage and DELETE can never disagree: every in-use file is refused, every unused file is deleted', async () => {
  for (const id of ALL) {
    const u = await usage(id);
    const err = await del(id);
    if (u.inUse) {
      assert.equal(err && err.statusCode, 400, `${id} is in use, DELETE must refuse`);
      assert.equal(db.business_media.some(m => m.id === id), true);
    } else {
      assert.equal(err, null, `${id} is unused, DELETE must succeed`);
      assert.equal(db.business_media.some(m => m.id === id), false);
    }
  }
});

test('DELETE explains what holds the file', async () => {
  assert.equal((await del(CARD)).message, 'Used by carousel: stay card 2 — remove it from those cards first.');
  assert.equal((await del(MAIN)).message, 'Used by: rooms — remove it from those replies first.');
  assert.equal((await del(TPL)).message, 'Used as the header of template: promo — attach other media to it first.');
  assert.equal((await del(COURSE)).message, 'Used as the photo of course: Yoga 101 — change the course photo first.');
  assert.equal((await del(VEHICLE)).message, 'Used as the photo of vehicle: Innova — change the vehicle photo first.');
});

test('GET /media/:id/usage answers { inUse, usedBy, fileSizeBytes }, 404 for a file that is not this business\'s', async () => {
  const call = async (id) => {
    const out = {};
    const res = { status: (c) => { out.status = c; return res; }, json: (p) => { out.body = p; return res; } };
    await controller.getMediaUsage({ params: { id }, user: { businessId: B1 } }, res, (e) => { throw e; });
    return out;
  };
  const ok = await call(CARD);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { inUse: true, usedBy: [{ kind: 'carousel_card', nodeId: uuid(201), label: 'stay', cardIndex: 2 }], fileSizeBytes: 10 });
  assert.deepEqual((await call(FREE)).body.data, { inUse: false, usedBy: [], fileSizeBytes: 10 });
  assert.equal((await call(uuid(999))).status, 404);
});

test('catalogue: a collection cover and a catalogue photo are uses (with the collection id), and DELETE refuses them', async () => {
  const COVER = uuid(110); const PHOTO = uuid(111); const BOTH = uuid(112);
  db.business_media.push(...[COVER, PHOTO, BOTH].map(id => ({ id, business_id: B1, r2_key: `k-${id}`, url: url(`k-${id}`), file_size_bytes: 10, media_type: 'image' })));
  db.catalog_collections = [{ id: uuid(800), business_id: B1, title: 'Silk', cover_media_id: COVER }, { id: uuid(801), business_id: B1, title: 'Cotton', cover_media_id: BOTH }];
  db.catalog_items = [
    { id: uuid(810), business_id: B1, collection_id: uuid(800), media_id: PHOTO, design_no: 'A-1' },
    { id: uuid(811), business_id: B1, collection_id: uuid(800), media_id: BOTH, design_no: null },
    { id: uuid(812), business_id: B2, collection_id: uuid(802), media_id: FREE, design_no: 'other business' }
  ];
  assert.deepEqual((await usage(COVER)).usedBy, [{ kind: 'catalog_cover', id: uuid(800), label: 'Silk' }]);
  assert.deepEqual((await usage(PHOTO)).usedBy, [{ kind: 'catalog_item', id: uuid(810), collectionId: uuid(800), label: 'A-1' }]);
  assert.deepEqual((await usage(BOTH)).usedBy.map(u => [u.kind, u.label]), [['catalog_cover', 'Cotton'], ['catalog_item', 'Photo']]);
  assert.equal((await usage(FREE)).inUse, false, 'another business\'s catalogue photo does not count');
  assert.match((await del(COVER)).message, /cover of catalogue collection: Silk/);
  assert.match((await del(PHOTO)).message, /Used in the Catalogue \(1 photo\)/);
  assert.equal((await del(PHOTO)).statusCode, 400);
});
