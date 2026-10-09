// Run: node --test src/services/storageCleanupSweeper.service.test.js
// Storage cleanup, purge side: the 24h pending window, database-first-then-R2, the
// purge effects of each kind, the re-check at purge time, retries, double-tick
// safety, flow-cache invalidation. In-memory Supabase and bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const cleanup = require('./storageCleanup.service');
const sweeper = require('./storageCleanupSweeper.service');

const { B1, B2, uuid, HOUR, url } = h;
const DAY = 24 * HOUR;

let db;
test.beforeEach(() => {
  db = h.reset();
  db.businesses = [
    { id: B1, name: 'SG Travels', payment_qr_url: null, profile_image: null, require_advance_payment: false, chat_media_retention: null, storage_used_bytes: 5000 },
    { id: B2, name: 'Averix', payment_qr_url: null, profile_image: null, require_advance_payment: false, chat_media_retention: null, storage_used_bytes: 0 }
  ];
  db.messages = [];
});

const chat = (n, businessId, { folder = 'inbound-media', size = 1000 } = {}) => {
  const key = h.put(`${folder}/${businessId}/${uuid(n)}.jpeg`, { size });
  db.messages.push({ id: uuid(n), business_id: businessId, content: '📷 Photo', media_url: url(key), media_removed_at: null });
  return key;
};
const lib = (n, businessId = B1, size = 2000) => {
  const key = h.put(`business-media/lib-${n}.jpeg`, { size });
  (db.business_media = db.business_media || []).push({ id: uuid(100 + n), business_id: businessId, r2_key: key, url: url(key), file_size_bytes: size, media_type: 'image' });
  return key;
};

/** Marks a run, then moves its purge time into the past so the sweeper may take it. */
const markAndDue = async (body) => {
  const run = await cleanup.createManualRun(body, 'admin-1');
  const past = new Date(Date.now() - 1000).toISOString();
  db.storage_cleanup_runs.find(r => r.id === run.id).pending_delete_at = past;
  db.storage_cleanup_items.filter(i => i.run_id === run.id).forEach(i => { i.pending_delete_at = past; });
  return run;
};
const item = (key) => db.storage_cleanup_items.find(i => i.r2_key === key);
const runRow = (id) => db.storage_cleanup_runs.find(r => r.id === id);

test('nothing is purged before the 24h pending window ends', async () => {
  const key = chat(1, B1);
  await cleanup.createManualRun({ businessId: B1 }, 'a');
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.claimed, 0);
  assert.equal(h.state.bucket.has(key), true);
  assert.equal(db.messages[0].media_url, url(key));
});

test('chat file: database first (media_url NULL + media_removed_at), then R2; item and run finish', async () => {
  const key = chat(1, B1, { size: 1500 });
  const keep = chat(2, B2);
  const run = await markAndDue({ businessId: B1 });
  let dbClearedWhenR2Deleted = null;
  h.state.onR2Delete = async () => { dbClearedWhenR2Deleted = db.messages[0].media_url === null && !!db.messages[0].media_removed_at; };

  const res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.claimed, res.purged, res.failed], [1, 1, 0]);
  assert.equal(dbClearedWhenR2Deleted, true, 'the database was already cleared when R2 was asked to delete');
  assert.equal(h.state.bucket.has(key), false);
  assert.equal(h.state.bucket.has(keep), true);
  assert.equal(db.messages[0].content, '📷 Photo', 'the message keeps its label');
  assert.equal(db.messages.length, 2, 'messages are never deleted');
  assert.equal(db.messages[1].media_url, url(keep));
  assert.equal(item(key).status, 'purged');
  const done = runRow(run.id);
  assert.deepEqual([done.status, done.purged_count, done.purged_bytes, done.failed_count], ['done', 1, 1500, 0]);
  assert.ok(done.finished_at);
});

test('library file: row deleted, storage decremented, bot node text-only, template header cleared + send_support recomputed, course image cleared, flow cache dropped', async () => {
  const key = lib(1);
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'hi', label: 'Welcome', image_url: url(key), media_id: uuid(101) }];
  db.business_courses = [{ id: uuid(300), business_id: B1, name: 'Maths', image_media_id: uuid(101) }];
  db.message_templates = [{
    id: uuid(400), business_id: B1, name: 'promo', language: 'en', status: 'approved', send_support: 'ok',
    meta_components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello' }], header_type: 'IMAGE', body_text: 'Hello',
    header_media_id: uuid(101), header_media_url: url(key), header_media_filename: 'a.jpg', header_image_url: null
  }];
  db.messages.push({ id: uuid(900), media_url: url(key), media_removed_at: null });  // sent from the inbox once
  const run = await markAndDue({ businessId: B1, includeInUse: true, confirmBusinessName: 'SG Travels' });

  const res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.failed, res.skipped], [1, 0, 0]);
  assert.equal(db.business_media.length, 0);
  assert.equal(db.businesses[0].storage_used_bytes, 3000);
  const node = db.flow_nodes[0];
  assert.deepEqual([node.image_url, node.media_id, node.label], [null, null, 'Welcome']);
  assert.equal(db.business_courses[0].image_media_id, null);
  const t = db.message_templates[0];
  assert.deepEqual([t.header_media_url, t.header_media_id, t.header_media_filename], [null, null, null]);
  assert.equal(t.send_support, 'needs_header_media');
  assert.equal(t.status, 'approved', 'the template row stays');
  assert.deepEqual([db.messages[0].media_url, !!db.messages[0].media_removed_at], [null, true]);
  assert.deepEqual(h.state.invalidated, [B1], 'cached reply nodes dropped for the business whose flow changed');
  assert.equal(h.state.bucket.has(key), false);
  assert.equal(runRow(run.id).status, 'done');
});

test('legacy template header image: cleared on the template, template kept', async () => {
  const key = h.put('template-headers/header-1.png');
  db.message_templates = [{
    id: uuid(400), business_id: B1, name: 'promo', language: 'en', status: 'approved', send_support: 'ok',
    meta_components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hello' }], header_type: 'IMAGE', body_text: 'Hello',
    header_image_url: url(key), header_image_r2_key: key, header_media_url: null
  }];
  // legacy header files belong to a template, so they are selected by kind
  await markAndDue({ businessId: B1, kinds: ['template_header'], includeInUse: true, confirmBusinessName: 'SG Travels' });
  await sweeper.runTick({ retention: false });
  const t = db.message_templates[0];
  assert.deepEqual([t.header_image_url, t.header_image_r2_key, t.send_support], [null, null, 'needs_header_media']);
  assert.equal(h.state.bucket.has(key), false);
});

test('payment QR, profile image and vehicle photo: the field is nulled, rows kept', async () => {
  const qr = h.put(`payment-qr/business-${B1}-1.png`);
  const logo = h.put(`business-profiles/business-${B1}.jpeg`);
  const car = h.put(`vehicle-photos/vehicle-${B1}-5.jpeg`);
  db.businesses[0].payment_qr_url = url(qr);
  db.businesses[0].profile_image = url(logo);
  db.vehicles = [{ id: uuid(500), business_id: B1, custom_name: 'Swift', custom_photo_url: url(car) }];
  await markAndDue({ businessId: B1, includeInUse: true, confirmBusinessName: 'SG Travels' });
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.purged, 3);
  assert.equal(db.businesses[0].payment_qr_url, null);
  assert.equal(db.businesses[0].profile_image, null);
  assert.deepEqual([db.vehicles.length, db.vehicles[0].custom_photo_url], [1, null]);
  assert.equal(h.state.bucket.size, 0);
});

test('orphan: just removed from R2 (nothing in the database to clear)', async () => {
  const key = h.put('payment-qr/old.png', { age: 100 * HOUR });
  const run = await cleanup.createRun({
    filters: { kinds: [], from: null, to: null, businessId: 'all', minBytes: 0, includeInUse: false, orphanMode: true },
    entries: [{ key, url: url(key), kind: 'orphan', businessId: null, sizeBytes: 1000, objectDate: null, inUse: false, usedBy: [] }]
  });
  db.storage_cleanup_items.forEach(i => { i.pending_delete_at = new Date(Date.now() - 1000).toISOString(); });
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.purged, 1);
  assert.equal(h.state.bucket.has(key), false);
  assert.equal(runRow(run.id).status, 'done');
});

test('re-check at purge time: a file that became in use after marking is skipped, not deleted', async () => {
  const key = lib(1);
  const run = await markAndDue({ businessId: B1 });       // unused library file -> marked safe
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'hi', label: 'Welcome', image_url: url(key), media_id: uuid(101) }]; // attached since
  const res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.skipped], [0, 1]);
  assert.equal(item(key).status, 'skipped_in_use');
  assert.match(item(key).error, /in use since the run was marked/);
  assert.equal(h.state.bucket.has(key), true);
  assert.equal(db.business_media.length, 1);
  assert.equal(db.flow_nodes[0].image_url, url(key));
  assert.equal(runRow(run.id).status, 'done');
});

test('re-check: an image-only node attached after marking protects the file even in an include-in-use run', async () => {
  const key = lib(1);
  await markAndDue({ businessId: B1, includeInUse: true, confirmBusinessName: 'SG Travels' });
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'menu', label: '', image_url: url(key), media_id: uuid(101) }];
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.skipped, 1);
  assert.match(item(key).error, /image-only reply/);
  assert.equal(h.state.bucket.has(key), true);
  assert.deepEqual(h.state.invalidated, []);
});

test('re-check: an orphan that got referenced again is skipped', async () => {
  const key = h.put('payment-qr/biz.png', { age: 100 * HOUR });
  await cleanup.createRun({
    filters: { kinds: [], from: null, to: null, businessId: 'all', minBytes: 0, includeInUse: false, orphanMode: true },
    entries: [{ key, url: url(key), kind: 'orphan', businessId: null, sizeBytes: 1000, objectDate: null, inUse: false, usedBy: [] }]
  });
  db.storage_cleanup_items.forEach(i => { i.pending_delete_at = new Date(Date.now() - 1000).toISOString(); });
  db.businesses[0].payment_qr_url = url(key);
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.skipped, 1);
  assert.equal(h.state.bucket.has(key), true);
  assert.equal(db.businesses[0].payment_qr_url, url(key));
});

test('a cancelled run is never purged', async () => {
  const key = chat(1, B1);
  const run = await cleanup.createManualRun({ businessId: B1 }, 'a');
  await cleanup.cancelRun(run.id, 'a');
  db.storage_cleanup_items.forEach(i => { i.pending_delete_at = new Date(Date.now() - 1000).toISOString(); });
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.claimed, 0);
  assert.equal(h.state.bucket.has(key), true);
});

test('R2 failure keeps the error, the database step is not repeated wrongly, and the next tick retries', async () => {
  const key = lib(1);
  const run = await markAndDue({ businessId: B1 });
  h.state.r2Failures.set(key, 'AccessDenied');
  let res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.failed], [0, 1]);
  assert.equal(item(key).status, 'failed');
  assert.match(item(key).error, /AccessDenied/);
  assert.equal(db.business_media.length, 0, 'database step already done');
  assert.equal(db.businesses[0].storage_used_bytes, 3000);
  assert.equal(runRow(run.id).status, 'purging', 'a failed item with attempts left keeps the run open');

  // claimed < 15 min ago: not retried yet
  assert.equal((await sweeper.runTick({ retention: false })).claimed, 0);

  item(key).claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  h.state.r2Failures.clear();
  res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.failed], [1, 0]);
  assert.equal(item(key).status, 'purged');
  assert.equal(item(key).error, null);
  assert.equal(db.businesses[0].storage_used_bytes, 3000, 'storage is decremented once, not on the retry');
  assert.equal(runRow(run.id).status, 'done');
});

test('an item that keeps failing stops after 5 attempts and the run ends failed', async () => {
  const key = chat(1, B1);
  const run = await markAndDue({ businessId: B1 });
  h.state.r2Failures.set(key, 'boom');
  for (let i = 0; i < 6; i += 1) {
    if (item(key).claimed_at) item(key).claimed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await sweeper.runTick({ retention: false });
  }
  assert.equal(item(key).attempts, 5);
  assert.equal(item(key).status, 'failed');
  assert.equal(runRow(run.id).status, 'failed');
  assert.equal(runRow(run.id).failed_count, 1);
});

test('a database error fails that item and leaves its R2 object alone', async () => {
  const bad = chat(1, B1);
  const run = await markAndDue({ businessId: B1 });
  const realFrom = h.state.fake.from;
  h.state.fake.from = (t) => {
    if (t === 'messages') {
      const q = realFrom(t);
      const realUpdate = q.update;
      q.update = (...a) => { realUpdate(...a); throw new Error('db down'); };
      return q;
    }
    return realFrom(t);
  };
  try {
    const res = await sweeper.runTick({ retention: false });
    assert.deepEqual([res.purged, res.failed], [0, 1]);
  } finally { h.state.fake.from = realFrom; }
  assert.match(item(bad).error, /database: db down/);
  assert.equal(h.state.bucket.has(bad), true);
  assert.equal(runRow(run.id).status, 'purging');
});

test('double tick safety: two ticks at once, then a third - every object is deleted exactly once', async () => {
  const keys = [1, 2, 3, 4, 5].map(n => chat(n, B1));
  await markAndDue({ businessId: B1 });
  const [a, b] = await Promise.all([sweeper.runTick({ retention: false }), sweeper.runTick({ retention: false })]);
  assert.equal(a.claimed + b.claimed, 5);
  assert.equal(a.purged + b.purged, 5);
  assert.deepEqual([...h.state.r2Deleted].sort(), [...keys].sort());
  assert.equal(new Set(h.state.r2Deleted).size, 5);
  const c = await sweeper.runTick({ retention: false });
  assert.equal(c.claimed, 0);
});

test('runTick({ runId }) only touches that run and never creates a retention run', async () => {
  await cleanup.setPlatformRetentionDays(7);
  chat(1, B1); chat(2, B2);
  const r1 = await markAndDue({ businessId: B1 });
  await markAndDue({ businessId: B2 });
  const res = await sweeper.runTick({ runId: r1.id });
  assert.equal(res.claimed, 1);
  assert.equal(res.retentionRun, null);
  assert.equal(h.state.r2Deleted.length, 1);
  assert.equal(db.storage_cleanup_runs.filter(r => r.is_automatic).length, 0);
});

test('a tick with retention on creates the day\'s automatic run (pending, not purged the same tick)', async () => {
  await cleanup.setPlatformRetentionDays(7);
  const key = h.put(`inbound-media/${B1}/${uuid(1)}.jpeg`, { age: 30 * DAY });
  db.messages.push({ id: uuid(1), media_url: url(key) });
  const res = await sweeper.runTick();
  assert.ok(res.retentionRun);
  assert.equal(res.claimed, 0);
  assert.equal(h.state.bucket.has(key), true);
  assert.equal(db.storage_cleanup_runs[0].is_automatic, true);
  assert.equal(db.storage_cleanup_runs[0].status, 'pending');
});

test('purging an in-use library file also strips it from personal flow snapshots (a restore would bring back a dead URL)', async () => {
  const key = lib(1);
  const snapNodes = [
    { id: uuid(700), keyword: 'hi', label: 'Welcome', image_url: url(key), media_id: uuid(101) },
    { id: uuid(701), keyword: 'other', label: 'Other', image_url: 'https://elsewhere.test/x.png', media_id: null }
  ];
  db.flow_snapshots = [{ id: uuid(800), business_id: B1, name: 'Before Diwali', is_category_template: false, nodes: snapNodes }];
  await markAndDue({ businessId: B1, includeInUse: true, confirmBusinessName: 'SG Travels' });
  const res = await sweeper.runTick({ retention: false });
  assert.equal(res.purged, 1);
  assert.equal(db.flow_snapshots.length, 1, 'the snapshot itself is kept');
  const nodes = db.flow_snapshots[0].nodes;
  assert.deepEqual([nodes[0].image_url, nodes[0].media_id, nodes[0].label], [null, null, 'Welcome']);
  assert.equal(nodes[1].image_url, 'https://elsewhere.test/x.png');
});

test('re-check: a category template that adopted the image after marking protects it', async () => {
  const key = lib(1);
  await markAndDue({ businessId: B1 });
  db.flow_snapshots = [{ id: uuid(801), business_id: null, category: 'travels', name: 'Travels starter', is_category_template: true,
    nodes: [{ id: uuid(700), label: 'Hi', image_url: url(key), media_id: uuid(101) }] }];
  const res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.skipped], [0, 1]);
  assert.match(item(key).error, /used by category template/);
  assert.equal(h.state.bucket.has(key), true);
  assert.equal(db.business_media.length, 1);
});

test('re-check: a personal snapshot that adopted the image after marking makes it in use (skipped without include-in-use)', async () => {
  const key = lib(1);
  await markAndDue({ businessId: B1 });
  db.flow_snapshots = [{ id: uuid(800), business_id: B1, name: 'v2', is_category_template: false, nodes: [{ id: uuid(700), label: 'Hi', image_url: url(key), media_id: uuid(101) }] }];
  const res = await sweeper.runTick({ retention: false });
  assert.deepEqual([res.purged, res.skipped], [0, 1]);
  assert.match(item(key).error, /in use since the run was marked/);
});
