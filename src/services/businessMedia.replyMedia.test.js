// Run: node --test src/services/businessMedia.replyMedia.test.js
// DELETE /api/business/media/:id refuses a file that a reply node still uses as an extra gallery photo
// or as its video, not just as photo #1 (media_id). In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const businessMedia = require('./businessMedia.service');

const { B1, uuid, url } = h;
const PHOTO = uuid(101); const VIDEO = uuid(102); const FREE = uuid(103); const MAIN = uuid(100);

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_media = [PHOTO, VIDEO, FREE, MAIN].map(id => ({ id, business_id: B1, r2_key: `k-${id}`, url: url(`k-${id}`), file_size_bytes: 10, media_type: 'image' }));
  db.message_templates = [];
  db.flow_nodes = [
    { id: uuid(200), business_id: B1, keyword: 'rooms', label: 'Rooms', media_id: MAIN, gallery_media_ids: [PHOTO], video_media_id: VIDEO },
    { id: uuid(201), business_id: B1, keyword: 'menu', label: 'Menu', media_id: null, gallery_media_ids: [PHOTO], video_media_id: null }
  ];
});

const del = async (id) => { try { await businessMedia.deleteBusinessMedia(B1, id); return null; } catch (e) { return e; } };

test('a gallery photo in use is refused, naming each reply once', async () => {
  const err = await del(PHOTO);
  assert.equal(err.statusCode, 400);
  assert.equal(err.message, 'Used by: rooms, menu — remove it from those replies first.');
  assert.equal(db.business_media.some(m => m.id === PHOTO), true);
});

test('a video in use is refused', async () => {
  const err = await del(VIDEO);
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /^Used by: rooms/);
});

test('photo #1 (media_id) is still protected', async () => {
  assert.equal((await del(MAIN)).statusCode, 400);
});

test('an unreferenced file passes the in-use check (and reaches the storage delete)', async () => {
  const r2 = require('./r2.service');
  r2.deleteImage = async () => {};
  assert.equal(await del(FREE), null);
  assert.equal(db.business_media.some(m => m.id === FREE), false);
});
