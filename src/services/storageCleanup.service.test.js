// Run: node --test src/services/storageCleanup.service.test.js
// Storage cleanup, marking side: typed confirmations, the 24h pending window, cancel,
// the daily automatic retention run (customer + owner chat media only), the orphan
// scan, retention settings and the CSV export. In-memory Supabase and bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const cleanup = require('./storageCleanup.service');

const { B1, B2, uuid, HOUR, url } = h;
const DAY = 24 * HOUR;
const PHRASE = 'DELETE ALL BUSINESSES MEDIA';

let db;
test.beforeEach(() => {
  db = h.reset();
  db.businesses = [
    { id: B1, name: 'SG Travels', payment_qr_url: null, profile_image: null, require_advance_payment: false, chat_media_retention: null },
    { id: B2, name: 'Averix', payment_qr_url: null, profile_image: null, require_advance_payment: false, chat_media_retention: null }
  ];
  db.messages = [];
});

/** A chat file with its message. */
const chat = (n, businessId, { folder = 'inbound-media', age = 100 * HOUR, size = 1000 } = {}) => {
  const key = h.put(`${folder}/${businessId}/${uuid(n)}.jpeg`, { size, age });
  db.messages.push({ id: uuid(n), business_id: businessId, media_url: url(key) });
  return key;
};

const rejects = (promise, status, pattern) => assert.rejects(promise, (e) => {
  assert.equal(e.statusCode, status);
  if (pattern) assert.match(e.message, pattern);
  return true;
});

test('preview writes nothing and reports totals, exclusions and a sample', async () => {
  chat(1, B1, { size: 500 });
  chat(2, B1, { size: 1500, folder: 'echo-media' });
  const p = await cleanup.preview({ businessId: B1 });
  assert.deepEqual([p.count, p.bytes], [2, 2000]);
  assert.equal(p.sample.length, 2);
  assert.equal((db.storage_cleanup_runs || []).length, 0);
  assert.equal((db.storage_cleanup_items || []).length, 0);
});

test('a run for one business: pending, purge in 24h, one pending item per file', async () => {
  chat(1, B1, { size: 500 }); chat(2, B1, { size: 700 }); chat(3, B2);
  const before = Date.now();
  const run = await cleanup.createManualRun({ businessId: B1, kinds: ['chat_inbound'] }, 'admin-1');
  assert.equal(run.status, 'pending');
  assert.equal(run.created_by, 'admin-1');
  assert.deepEqual([run.file_count, run.total_bytes], [2, 1200]);
  const at = new Date(run.pending_delete_at).getTime();
  assert.ok(at >= before + DAY - 1000 && at <= Date.now() + DAY + 1000);
  assert.equal(db.storage_cleanup_items.length, 2);
  assert.ok(db.storage_cleanup_items.every(i => i.status === 'pending' && i.pending_delete_at === run.pending_delete_at && i.run_id === run.id));
  assert.equal(db.messages.every(m => m.media_url), true, 'marking deletes nothing');
  assert.equal(h.state.r2Deleted.length, 0);
});

test('all businesses needs the typed phrase', async () => {
  chat(1, B1);
  await rejects(cleanup.createManualRun({ businessId: 'all' }, 'a'), 400, /DELETE ALL BUSINESSES MEDIA/);
  await rejects(cleanup.createManualRun({ businessId: 'all', confirmPhrase: 'delete all businesses media' }, 'a'), 400);
  const run = await cleanup.createManualRun({ businessId: 'all', confirmPhrase: PHRASE }, 'a');
  assert.equal(run.file_count, 1);
});

test('in-use files need the exact business name, one business only', async () => {
  const k = h.put('business-media/lib.jpeg');
  db.business_media = [{ id: uuid(100), business_id: B1, r2_key: k, url: url(k), file_size_bytes: 1000, media_type: 'image' }];
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'hi', label: 'Welcome', image_url: url(k), media_id: uuid(100) }];

  await rejects(cleanup.createManualRun({ businessId: 'all', includeInUse: true, confirmPhrase: PHRASE }, 'a'), 400, /one business at a time/);
  await rejects(cleanup.createManualRun({ businessId: B1, includeInUse: true }, 'a'), 400, /SG Travels/);
  await rejects(cleanup.createManualRun({ businessId: B1, includeInUse: true, confirmBusinessName: 'sg travels' }, 'a'), 400);
  await rejects(cleanup.createManualRun({ businessId: B2, includeInUse: true, confirmBusinessName: 'SG Travels' }, 'a'), 400);

  // without includeInUse the in-use file is simply not selected
  await rejects(cleanup.createManualRun({ businessId: B1 }, 'a'), 400, /Nothing matches/);

  const run = await cleanup.createManualRun({ businessId: B1, includeInUse: true, confirmBusinessName: ' SG Travels ' }, 'a');
  assert.equal(run.confirmed_business_name, 'SG Travels');
  assert.deepEqual([db.storage_cleanup_items[0].kind, db.storage_cleanup_items[0].in_use], ['bot_node_image', true]);
  assert.deepEqual(db.storage_cleanup_items[0].used_by, [{ type: 'flow_node', id: uuid(200), label: 'hi' }]);
});

test('image-only replies stay out even with includeInUse and the typed name', async () => {
  const k = h.put('business-media/only.jpeg');
  db.business_media = [{ id: uuid(100), business_id: B1, r2_key: k, url: url(k), file_size_bytes: 1000, media_type: 'image' }];
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'menu', label: '', image_url: url(k), media_id: uuid(100) }];
  await rejects(cleanup.createManualRun({ businessId: B1, includeInUse: true, confirmBusinessName: 'SG Travels' }, 'a'), 400, /Nothing matches/);
  const p = await cleanup.preview({ businessId: B1, includeInUse: true });
  assert.equal(p.excluded.protected.count, 1);
});

test('validation: kinds, dates, size, business', async () => {
  await rejects(cleanup.preview({ businessId: B1, kinds: ['nope'] }), 400, /kinds/);
  await rejects(cleanup.preview({ businessId: B1, from: '10/01/2026' }), 400, /from/);
  await rejects(cleanup.preview({ businessId: B1, from: '2026-10-05', to: '2026-10-01' }), 400, /after/);
  await rejects(cleanup.preview({ businessId: B1, minBytes: -1 }), 400, /minBytes/);
  await rejects(cleanup.preview({}), 400, /businessId/);
});

test('files already waiting in an open run are not marked twice', async () => {
  chat(1, B1);
  await cleanup.createManualRun({ businessId: B1 }, 'a');
  await rejects(cleanup.createManualRun({ businessId: B1 }, 'a'), 400, /Nothing matches/);
});

test('summary: addedThisMonth counts R2 last-modified in the current India-time month', async () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const put = (name, lastModified, size) => {
    const key = `inbound-media/${B1}/${name}.jpeg`;
    h.state.bucket.set(key, { size, lastModified: new Date(lastModified) });
    return key;
  };
  put(uuid(1), '2026-09-30T18:29:59Z', 1);   // 23:59:59 IST on 30 Sep - last month
  put(uuid(2), '2026-09-30T18:30:00Z', 20);  // 00:00:00 IST on 1 Oct - this month
  put(uuid(3), '2026-10-14T09:00:00Z', 300);
  const s = await cleanup.summary({ now });
  assert.deepEqual(s.addedThisMonth, { files: 2, bytes: 320 });
  assert.equal(s.count, 3, 'the totals still cover every file');
});

test('summary: addedThisMonth is zero when nothing is in R2', async () => {
  const s = await cleanup.summary({ now: new Date('2026-10-15T12:00:00Z') });
  assert.deepEqual(s.addedThisMonth, { files: 0, bytes: 0 });
});

test('summary: byBusiness carries chatMediaBytes (customer + owner chat files only)', async () => {
  chat(1, B1, { size: 500 });
  chat(2, B1, { size: 250, folder: 'echo-media' });
  const lib = h.put('business-media/lib.jpeg', { size: 4000 });
  db.business_media = [{ id: uuid(100), business_id: B1, r2_key: lib, url: url(lib), file_size_bytes: 4000, media_type: 'image' }];
  chat(3, B2, { size: 70 });
  const s = await cleanup.summary();
  const by = Object.fromEntries(s.byBusiness.map(b => [b.name, [b.bytes, b.chatMediaBytes]]));
  assert.deepEqual(by, { 'SG Travels': [4750, 750], Averix: [70, 70] });
});

test('cancel works until the purge time, then not; items follow the run', async () => {
  chat(1, B1);
  const run = await cleanup.createManualRun({ businessId: B1 }, 'a');
  const cancelled = await cleanup.cancelRun(run.id, 'admin-2');
  assert.deepEqual([cancelled.status, cancelled.cancelled_by], ['cancelled', 'admin-2']);
  assert.ok(cancelled.cancelled_at);
  assert.equal(db.storage_cleanup_items[0].status, 'cancelled');
  await rejects(cleanup.cancelRun(run.id, 'admin-2'), 409, /cancelled/);

  chat(2, B1);
  const run2 = await cleanup.createManualRun({ businessId: B1 }, 'a');
  db.storage_cleanup_runs.find(r => r.id === run2.id).pending_delete_at = new Date(Date.now() - 1000).toISOString();
  await rejects(cleanup.cancelRun(run2.id, 'a'), 409);
  await rejects(cleanup.cancelRun('missing', 'a'), 404);
});

test('export.csv: one row per item, quoted where needed', async () => {
  const key = chat(1, B1);
  const run = await cleanup.createManualRun({ businessId: B1 }, 'a');
  db.storage_cleanup_items[0].error = 'oops, "bad"';
  const csv = await cleanup.exportCsv(run.id);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'r2_key');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith(key));
  assert.ok(lines[1].includes('"oops, ""bad"""'));
});

// ── retention ──

test('retention settings: platform days (>= 7 or null) and per-business override (number | never | null)', async () => {
  assert.equal(await cleanup.getPlatformRetentionDays(), null);
  await cleanup.setPlatformRetentionDays(30);
  assert.equal(await cleanup.getPlatformRetentionDays(), 30);
  await cleanup.setPlatformRetentionDays(null);
  assert.equal(await cleanup.getPlatformRetentionDays(), null);
  for (const bad of [3, 0, 7.5, '30']) await rejects(cleanup.setPlatformRetentionDays(bad), 400);

  assert.equal(await cleanup.setBusinessRetention(B1, 'never'), 'never');
  assert.equal(await cleanup.setBusinessRetention(B1, 14), '14');
  assert.equal(db.businesses[0].chat_media_retention, '14');
  assert.equal(await cleanup.setBusinessRetention(B1, null), null);
  await rejects(cleanup.setBusinessRetention(B1, 2), 400);
  await rejects(cleanup.setBusinessRetention(B1, 'forever'), 400);
  await rejects(cleanup.setBusinessRetention('missing', 30), 404);

  assert.equal(cleanup.effectiveRetentionDays('never', 30), null);
  assert.equal(cleanup.effectiveRetentionDays('14', null), 14);
  assert.equal(cleanup.effectiveRetentionDays(null, 30), 30);
  assert.equal(cleanup.effectiveRetentionDays(null, null), null);
});

test('retention run: automatic, chat files only, older than each business\'s retention, never-override skipped', async () => {
  await cleanup.setPlatformRetentionDays(30);
  const oldB2 = chat(1, B2, { age: 40 * DAY });
  chat(2, B2, { age: 5 * DAY });                                      // too new
  const oldEcho = chat(3, B2, { age: 60 * DAY, folder: 'echo-media' });
  chat(4, B1, { age: 90 * DAY });                                     // B1 = never
  const lib = h.put('business-media/lib.jpeg', { age: 400 * DAY });   // library: never touched by retention
  db.business_media = [{ id: uuid(100), business_id: B2, r2_key: lib, url: url(lib), file_size_bytes: 1000, media_type: 'image' }];
  const qr = h.put(`payment-qr/business-${B2}-1.png`, { age: 400 * DAY });
  db.businesses[1].payment_qr_url = url(qr);
  db.businesses[0].chat_media_retention = 'never';

  const res = await cleanup.createRetentionRun();
  assert.equal(res.created, true);
  assert.equal(res.run.is_automatic, true);
  assert.equal(res.run.created_by, null);
  assert.equal(res.run.status, 'pending');
  assert.deepEqual(res.run.filters.kinds, ['chat_inbound', 'chat_echo']);
  assert.deepEqual(db.storage_cleanup_items.map(i => i.r2_key).sort(), [oldB2, oldEcho].sort());
  assert.ok(db.storage_cleanup_items.every(i => i.kind.startsWith('chat_') && i.status === 'pending'));
});

test('retention run: a business override beats the platform setting, in both directions', async () => {
  // platform off, B1 opts in with 10 days
  const k = chat(1, B1, { age: 20 * DAY });
  chat(2, B2, { age: 20 * DAY });
  db.businesses[0].chat_media_retention = '10';
  const res = await cleanup.createRetentionRun();
  assert.equal(res.created, true);
  assert.deepEqual(db.storage_cleanup_items.map(i => i.r2_key), [k]);
});

test('retention run: off = nothing; once a day only; nothing old enough = no run', async () => {
  chat(1, B1, { age: 90 * DAY });
  assert.deepEqual(await cleanup.createRetentionRun(), { created: false, reason: 'retention is off' });

  await cleanup.setPlatformRetentionDays(30);
  assert.equal((await cleanup.createRetentionRun()).created, true);
  assert.deepEqual(await cleanup.createRetentionRun(), { created: false, reason: 'already ran today' });
  assert.equal(db.storage_cleanup_runs.length, 1);
});

test('retention run: nothing older than the retention creates no run', async () => {
  await cleanup.setPlatformRetentionDays(30);
  chat(1, B1, { age: 2 * DAY });
  assert.equal((await cleanup.createRetentionRun()).created, false);
  assert.equal((db.storage_cleanup_runs || []).length, 0);
});

test('retention run is a normal run: cancellable, and its files are not re-marked next day', async () => {
  await cleanup.setPlatformRetentionDays(30);
  chat(1, B1, { age: 90 * DAY });
  const { run } = await cleanup.createRetentionRun();
  const next = new Date(Date.now() + DAY);
  // same open run still holds the key, so a later day's run finds nothing new
  assert.equal((await cleanup.createRetentionRun({ now: next })).created, false);
  await cleanup.cancelRun(run.id, 'admin');
  assert.equal((await cleanup.createRetentionRun({ now: next })).created, true);
});

// ── orphan scan ──

const waitForScan = async () => {
  for (let i = 0; i < 100 && cleanup.orphanScanStatus().status === 'running'; i += 1) await new Promise(r => setImmediate(r));
  return cleanup.orphanScanStatus();
};

test('orphan scan: needs the phrase; marks only unreferenced objects older than 48h', async () => {
  await rejects(cleanup.startOrphanScan({}, 'a'), 400, /DELETE ALL/);
  const old = h.put('template-headers/old.png', { age: 100 * HOUR });
  h.put('template-headers/young.png', { age: 10 * HOUR });
  chat(1, B1);                                   // referenced
  const oldQr = h.put(`payment-qr/business-${B1}-1.png`, { age: 100 * HOUR });
  const job = await cleanup.startOrphanScan({ confirmPhrase: PHRASE }, 'a');
  assert.equal(job.status, 'running');
  const done = await waitForScan();
  assert.equal(done.status, 'done');
  assert.equal(done.found, 2);
  const run = db.storage_cleanup_runs.find(r => r.id === done.runId);
  assert.equal(run.filters.orphan_mode, true);
  assert.equal(run.status, 'pending');
  assert.deepEqual(db.storage_cleanup_items.map(i => i.r2_key).sort(), [old, oldQr].sort());
  assert.ok(db.storage_cleanup_items.every(i => i.kind === 'orphan'));
});
