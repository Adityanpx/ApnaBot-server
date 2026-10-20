// Run: node --test src/services/catalogMedia.service.test.js
// Batch photo upload for the Catalogue (real sharp): WebP becomes JPEG, long edge <= 1280px, a 5 MB input cap,
// per-file results, the plan's storage quota stops the batch, and the same media-library rows as a normal upload.
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = { name: 'basic', display_name: 'Basic', storage_limit_mb: 200 };
const subPath = require.resolve('./subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => (plan ? { status: 'active', plan } : null) } };
const r2 = require('./r2.service');
let uploads;
r2.uploadImage = async (buffer, folder, publicId, mimetype) => {
  uploads.push({ folder, mimetype, size: buffer.length });
  return { url: `https://r2.test/${folder}/${publicId}`, key: `${folder}/${publicId}` };
};
r2.deleteImage = async () => {};
const { uploadCatalogImages } = require('./catalogMedia.service');
const catalogController = require('../controllers/catalog.controller');

const { B1 } = h;
let db;
test.beforeEach(() => {
  db = h.reset(); uploads = [];
  plan = { name: 'basic', display_name: 'Basic', storage_limit_mb: 200 };
  db.businesses = [{ id: B1, storage_used_bytes: 0 }];
  db.business_media = [];
  h.state.fake.rpc = async (name, args) => {
    assert.equal(name, 'increment_business_storage_used');
    db.businesses[0].storage_used_bytes += args.p_delta_bytes;
    return { data: null, error: null };
  };
});

const image = async (format, width = 2400, height = 1600) => sharp({ create: { width, height, channels: 3, background: '#cc3366' } })[format]().toBuffer();
const file = (buffer, mimetype, originalname) => ({ buffer, mimetype, originalname });

test('a WebP photo is stored as a JPEG no longer than 1280px; the library row says so', async () => {
  const res = await uploadCatalogImages(B1, [file(await image('webp'), 'image/webp', 'saree.webp')]);
  assert.deepEqual([res.uploaded, res.failed], [1, 0]);
  assert.equal(res.results[0].ok, true);
  assert.equal(uploads[0].mimetype, 'image/jpeg');
  const row = db.business_media[0];
  assert.deepEqual([row.media_type, Math.max(row.width, row.height), row.original_filename], ['image', 1280, 'saree.webp']);
  assert.equal(res.results[0].media.id, row.id);
  assert.equal(db.businesses[0].storage_used_bytes, row.file_size_bytes);
  assert.equal(res.storage.usedBytes, row.file_size_bytes);
  assert.equal(res.storage.limitMb, 200);
});

test('JPEG and PNG are re-encoded as JPEG too; up to 10 in one request, each its own library row', async () => {
  const files = [];
  for (let i = 0; i < 10; i++) files.push(file(await image(i % 2 ? 'png' : 'jpeg', 800, 600), i % 2 ? 'image/png' : 'image/jpeg', `p${i}.img`));
  const res = await uploadCatalogImages(B1, files);
  assert.equal(res.uploaded, 10);
  assert.equal(db.business_media.length, 10);
  assert.ok(uploads.every(u => u.mimetype === 'image/jpeg'));
  assert.deepEqual(res.results.map(r => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('an input over 2 MB (the normal library cap) is accepted up to 5 MB, over 5 MB is refused for that file only', async () => {
  let side = 2400; let big;
  for (let attempt = 0; attempt < 8; attempt++) {
    big = await sharp({ create: { width: side, height: side, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).jpeg({ quality: 90 }).toBuffer();
    if (big.length > 2.2 * 1024 * 1024 && big.length < 4.8 * 1024 * 1024) break;
    side = Math.round(side * (big.length > 4.8 * 1024 * 1024 ? 0.8 : 1.25));
  }
  assert.ok(big.length > 2 * 1024 * 1024 && big.length < 5 * 1024 * 1024, `fixture is ${big.length} bytes`);
  const ok = await uploadCatalogImages(B1, [file(big, 'image/jpeg', 'big.jpg')]);
  assert.equal(ok.uploaded, 1);
  assert.ok(db.business_media[0].file_size_bytes < 2 * 1024 * 1024, 'stored size is after the resize');

  const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
  const res = await uploadCatalogImages(B1, [file(huge, 'image/jpeg', 'huge.jpg'), file(await image('jpeg', 400, 300), 'image/jpeg', 'fine.jpg')]);
  assert.deepEqual(res.results.map(r => r.ok ? 'ok' : r.code), ['FILE_TOO_LARGE', 'ok']);
});

test('a wrong type fails that file only', async () => {
  const res = await uploadCatalogImages(B1, [file(Buffer.from('%PDF'), 'application/pdf', 'a.pdf'), file(await image('jpeg', 400, 300), 'image/jpeg', 'ok.jpg'), file(Buffer.from('x'), 'video/mp4', 'v.mp4')]);
  assert.deepEqual(res.results.map(r => r.ok ? 'ok' : r.code), ['UNSUPPORTED_TYPE', 'ok', 'UNSUPPORTED_TYPE']);
  assert.deepEqual([res.uploaded, res.failed], [1, 2]);
});

test('a file that is not a readable image fails with INVALID/UPLOAD_FAILED and does not stop the batch', async () => {
  const res = await uploadCatalogImages(B1, [file(Buffer.from('not an image at all'), 'image/jpeg', 'bad.jpg'), file(await image('jpeg', 400, 300), 'image/jpeg', 'ok.jpg')]);
  assert.equal(res.results[0].ok, false);
  assert.equal(res.results[1].ok, true);
});

test('storage quota: files are stored until the quota is hit, the rest report STORAGE_LIMIT and are not attempted', async () => {
  const one = await image('jpeg', 1200, 900);
  const probe = await uploadCatalogImages(B1, [file(one, 'image/jpeg', 'probe.jpg')]);
  const size = probe.storage.usedBytes;
  db.business_media = []; db.businesses[0].storage_used_bytes = 0; uploads = [];
  plan = { name: 'basic', display_name: 'Basic', storage_limit_mb: (size * 2.5) / (1024 * 1024) };
  const res = await uploadCatalogImages(B1, [file(one, 'image/jpeg', 'a.jpg'), file(one, 'image/jpeg', 'b.jpg'), file(one, 'image/jpeg', 'c.jpg'), file(one, 'image/jpeg', 'd.jpg')]);
  assert.deepEqual(res.results.map(r => r.ok ? 'ok' : r.code), ['ok', 'ok', 'STORAGE_LIMIT', 'STORAGE_LIMIT']);
  assert.match(res.results[2].error, /storage limit/);
  assert.equal(uploads.length, 2, 'the 4th file was not even processed');
  assert.equal(db.business_media.length, 2);
});

test('no active subscription: NO_SUBSCRIPTION for each file', async () => {
  plan = null;
  const res = await uploadCatalogImages(B1, [file(await image('jpeg', 400, 300), 'image/jpeg', 'a.jpg')]);
  assert.equal(res.results[0].code, 'NO_SUBSCRIPTION');
});

// ---- the endpoint ----
const call = async (handler, req) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, query: {}, body: {}, user: { businessId: B1 }, ...req }, res, (err) => { throw err; });
  return out;
};

test('POST /api/catalog/media: 201 with per-file results when at least one photo was stored', async () => {
  const out = await call(catalogController.uploadMedia, { files: [file(await image('jpeg', 400, 300), 'image/jpeg', 'a.jpg'), file(Buffer.from('x'), 'image/gif', 'b.gif')] });
  assert.equal(out.status, 201);
  assert.deepEqual([out.body.data.uploaded, out.body.data.failed, out.body.data.results.length], [1, 1, 2]);
  assert.match(out.body.message, /1 photo uploaded/);
});

test('POST /api/catalog/media: 400 with the first reason as the message when nothing was stored; 400 NO_FILES without files', async () => {
  const none = await call(catalogController.uploadMedia, { files: [file(Buffer.from('x'), 'image/gif', 'b.gif')] });
  assert.equal(none.status, 400);
  assert.equal(none.body.errors.code, 'UNSUPPORTED_TYPE');
  assert.match(none.body.message, /JPEG, PNG and WebP/);
  assert.equal(none.body.errors.results.length, 1);
  const empty = await call(catalogController.uploadMedia, { files: [] });
  assert.deepEqual([empty.status, empty.body.errors.code], [400, 'NO_FILES']);
});
