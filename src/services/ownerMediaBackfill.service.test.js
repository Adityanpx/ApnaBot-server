// Run: node --test src/services/ownerMediaBackfill.service.test.js
// Backfill of phone-app echo media after the owner_phone_media switch is turned on:
// the preview counts only rows with a media id, no stored file and created within
// the window; the job downloads them with the live caps and skips expired ids.
// Supabase, Meta download, R2 and socket stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let downloads; let uploads; let downloadImpl;

const from = (table) => {
  const filters = []; let op = 'select'; let payload = null; let range = null;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') { const hit = matching(); hit.forEach(r => Object.assign(r, payload)); return { data: hit, error: null }; }
    let out = matching().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (range) out = out.slice(range[0], range[1] + 1);
    return { data: out, error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    not: (c, _op, v) => { filters.push(r => r[c] !== v && r[c] !== undefined); return q; },
    is: (c, v) => { filters.push(r => (r[c] === undefined ? null : r[c]) === v); return q; },
    gte: (c, v) => { filters.push(r => r[c] >= v); return q; },
    order: () => q,
    range: (a, b) => { range = [a, b]; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: null }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { R2_PUBLIC_URL: 'https://r2.test' });
stub('../config/supabase', { from });
stub('../utils/logger', { info() {}, warn() {}, error() {} });
stub('./socket.service', { emitToBusiness() {} });
stub('./whatsapp.service', { downloadMedia: (...args) => { downloads.push(args); return downloadImpl(...args); } });
stub('./r2.service', { uploadImage: async (_b, folder, id, mime) => { uploads.push([folder, id]); return { url: `https://r2.test/${folder}/${id}.${mime.split('/')[1]}` }; } });
const svc = require('./ownerMediaBackfill.service');

const NOW = new Date('2026-10-09T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
const business = { id: 'b1', business_category: 'travels', access_token: 'enc', is_whatsapp_connected: true };
const echo = (id, over = {}) => ({ id, business_id: 'b1', customer_id: 'c1', sender_type: 'phone_app', type: 'image', wa_media_id: `wa-${id}`, wa_media_mime: 'image/jpeg', created_at: daysAgo(1), ...over });
const settle = async (businessId) => { for (let i = 0; i < 200 && svc.status(businessId).status === 'running'; i += 1) await new Promise(r => setImmediate(r)); };

test.beforeEach(() => {
  downloads = []; uploads = [];
  downloadImpl = async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' });
  db = {
    messages: [],
    category_features: [{ category: 'travels', feature: 'owner_phone_media', is_enabled: true }],
    business_features: []
  };
});

test('parseDays: default 7, 1..7 accepted, everything else invalid', () => {
  assert.equal(svc.parseDays(undefined), 7);
  assert.equal(svc.parseDays(3), 3);
  assert.equal(svc.parseDays('7'), 7);
  for (const bad of [0, 8, 1.5, -1, 'x']) assert.equal(svc.parseDays(bad), null);
});

test('preview counts only phone_app rows with a media id, no file yet, inside the window', async () => {
  db.messages = [
    echo('m1'),
    echo('m2', { created_at: daysAgo(6.5) }),
    echo('old', { created_at: daysAgo(8) }),                  // outside 7 days
    echo('done', { media_url: 'https://r2.test/x.jpeg' }),    // already stored
    echo('noid', { wa_media_id: undefined }),                 // no media id (pre-feature row)
    echo('cust', { sender_type: 'human' }),                   // not a phone-app echo
    echo('other', { business_id: 'b2' }),                     // another business
    echo('doc', { type: 'document', wa_media_mime: 'application/msword' }) // never storable
  ];
  assert.deepEqual(await svc.preview('b1', 7, NOW), { count: 2, estimatedBytes: null, days: 7 });
  assert.equal((await svc.preview('b1', 3, NOW)).count, 1);
  assert.equal(downloads.length, 0, 'preview never calls Meta');
});

test('start: downloads each candidate, sets media_url, skips ids older than the window', async () => {
  db.messages = [echo('m1'), echo('m2'), echo('old', { created_at: daysAgo(8) })];
  const { job } = await svc.start(business, 7, NOW);
  assert.equal(job.total, 2);
  await settle('b1');
  const done = svc.status('b1');
  assert.equal(done.status, 'done');
  assert.equal(done.stored, 2);
  assert.equal(downloads.length, 2);
  assert.match(db.messages.find(m => m.id === 'm1').media_url, /echo-media\/b1\/m1\.jpeg$/);
  assert.equal(db.messages.find(m => m.id === 'old').media_url, undefined);
});

test('start: an expired media id is skipped and counted, the rest continue; other errors count as failed', async () => {
  db.messages = [echo('gone'), echo('ok'), echo('boom')];
  downloadImpl = async (id) => {
    if (id === 'wa-gone') throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
    if (id === 'wa-boom') throw new Error('network');
    return { buffer: Buffer.from('x'), mimeType: 'image/jpeg' };
  };
  await svc.start(business, 7, NOW);
  await settle('b1');
  const done = svc.status('b1');
  assert.deepEqual([done.stored, done.expired, done.failed, done.processed], [1, 1, 1, 3]);
  assert.equal(db.messages.find(m => m.id === 'gone').media_url, undefined);
  assert.ok(db.messages.find(m => m.id === 'ok').media_url);
});

test('start: oversize / wrong real mime is skipped, not failed', async () => {
  db.messages = [echo('big', { type: 'video', wa_media_mime: 'video/mp4' }), echo('odd')];
  downloadImpl = async (id) => (id === 'wa-big'
    ? { buffer: Buffer.alloc(16 * 1024 * 1024 + 1), mimeType: 'video/mp4' }
    : { buffer: Buffer.from('x'), mimeType: 'image/gif' });
  await svc.start(business, 7, NOW);
  await settle('b1');
  const done = svc.status('b1');
  assert.deepEqual([done.stored, done.skipped, done.failed], [0, 2, 0]);
  assert.equal(uploads.length, 0);
});

test('start is refused while the switch is off, and while a job is running', async () => {
  db.category_features = [];
  assert.equal((await svc.start(business, 7, NOW)).status, 409);

  db.category_features = [{ category: 'travels', feature: 'owner_phone_media', is_enabled: true }];
  db.messages = [echo('m1')];
  let release;
  downloadImpl = () => new Promise((resolve) => { release = () => resolve({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }); });
  const first = await svc.start({ ...business, id: 'b1' }, 7, NOW);
  assert.ok(first.job);
  const second = await svc.start(business, 7, NOW);
  assert.equal(second.status, 409);
  await new Promise(r => setImmediate(r));
  release();
  await settle('b1');
  assert.equal(svc.status('b1').status, 'done');
});

test('start with nothing to do finishes immediately', async () => {
  const { job } = await svc.start(business, 7, NOW);
  assert.equal(job.status, 'done');
  assert.equal(job.total, 0);
});
