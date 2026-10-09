// Run: node --test src/services/storageInventory.service.test.js
// Storage cleanup, read side: R2 objects joined to database references -> kind,
// safe / in use / protected / orphan; and the run filters (kinds, IST dates, size,
// business, in-use, 48h orphan rule). In-memory Supabase and bucket.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const inventory = require('./storageInventory.service');

const { B1, B2, uuid, HOUR, url } = h;

let db;
test.beforeEach(() => {
  db = h.reset();
  db.businesses = [
    { id: B1, name: 'SG Travels', payment_qr_url: null, profile_image: null, require_advance_payment: false },
    { id: B2, name: 'Averix', payment_qr_url: null, profile_image: null, require_advance_payment: false }
  ];
});

const find = (entries, key) => entries.find(e => e.key === key);
const scan = async (opts) => (await inventory.scan(opts)).entries;

test('chat files: a message pointing at the file makes it safe; no message makes it an orphan', async () => {
  const safe = h.put(`inbound-media/${B1}/${uuid(1)}.jpeg`);
  const echo = h.put(`echo-media/${B1}/${uuid(2)}.mp4`);
  const orphan = h.put(`inbound-media/${B1}/${uuid(3)}.jpeg`);
  const purgedAlready = h.put(`inbound-media/${B1}/${uuid(4)}.jpeg`);
  db.messages = [
    { id: uuid(1), media_url: url(safe) }, { id: uuid(2), media_url: url(echo) },
    { id: uuid(4), media_url: null }
  ];
  const entries = await scan();
  assert.deepEqual(['kind', 'inUse', 'referenced', 'businessId'].map(k => find(entries, safe)[k]), ['chat_inbound', false, true, B1]);
  assert.equal(find(entries, echo).kind, 'chat_echo');
  assert.equal(find(entries, orphan).kind, 'orphan');
  assert.equal(find(entries, purgedAlready).referenced, false, 'a message whose media_url was cleared no longer references the file');
});

test('library files: unused = library; used by a bot node / course / template header = in use with that kind', async () => {
  const keys = ['business-media/lib.jpeg', 'business-media/node.jpeg', 'business-media/course.jpeg', 'business-media/tpl.jpeg'];
  keys.forEach(k => h.put(k));
  db.business_media = keys.map((k, i) => ({ id: uuid(100 + i), business_id: B1, r2_key: k, url: url(k), file_size_bytes: 1000, media_type: 'image' }));
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'hi', label: 'Welcome!', image_url: url(keys[1]), media_id: uuid(101) }];
  db.business_courses = [{ id: uuid(300), business_id: B1, name: 'Maths', image_media_id: uuid(102) }];
  db.message_templates = [{ id: uuid(400), business_id: B1, name: 'promo', header_media_id: uuid(103), header_media_url: url(keys[3]) }];
  const entries = await scan();
  assert.deepEqual([find(entries, keys[0]).kind, find(entries, keys[0]).inUse], ['library', false]);
  assert.deepEqual([find(entries, keys[1]).kind, find(entries, keys[1]).inUse], ['bot_node_image', true]);
  assert.deepEqual([find(entries, keys[2]).kind, find(entries, keys[2]).inUse], ['course_image', true]);
  assert.deepEqual([find(entries, keys[3]).kind, find(entries, keys[3]).inUse], ['template_header', true]);
  assert.deepEqual(find(entries, keys[1]).usedBy, [{ type: 'flow_node', id: uuid(200), label: 'hi' }]);
  assert.equal(find(entries, keys[1]).businessId, B1);
});

test('image-only reply nodes (empty base label) are protected, with the reason', async () => {
  const k = h.put('business-media/only.jpeg');
  db.business_media = [{ id: uuid(100), business_id: B1, r2_key: k, url: url(k), file_size_bytes: 1000, media_type: 'image' }];
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'menu', label: '', image_url: url(k), media_id: uuid(100) }];
  const e = find(await scan(), k);
  assert.equal(e.inUse, true);
  assert.equal(e.protected, true);
  assert.equal(e.protectedReason, 'image-only reply');
});

test('legacy template header image, payment QR, logo, vehicle photo', async () => {
  const hdr = h.put('template-headers/header-1.png');
  const hdrOrphan = h.put('template-headers/header-2.png');
  const qr = h.put(`payment-qr/business-${B1}-111.png`);
  const oldQr = h.put(`payment-qr/business-${B1}-100.png`);
  const logo = h.put(`business-profiles/business-${B2}.jpeg`);
  const car = h.put(`vehicle-photos/vehicle-${B1}-5.jpeg`);
  db.message_templates = [{ id: uuid(400), business_id: B1, name: 'p', header_image_r2_key: hdr, header_image_url: url(hdr) }];
  db.businesses[0].payment_qr_url = url(qr);
  db.businesses[1].profile_image = url(logo);
  db.vehicles = [{ id: uuid(500), business_id: B1, custom_name: 'Swift', custom_photo_url: url(car) }];
  const entries = await scan();
  assert.deepEqual([find(entries, hdr).kind, find(entries, hdr).inUse], ['template_header', true]);
  assert.equal(find(entries, hdrOrphan).kind, 'orphan');
  assert.deepEqual([find(entries, qr).kind, find(entries, qr).inUse, find(entries, qr).businessId], ['payment_qr', true, B1]);
  assert.equal(find(entries, oldQr).kind, 'orphan', 'a replaced QR that is no longer referenced');
  assert.deepEqual([find(entries, logo).kind, find(entries, logo).inUse, find(entries, logo).businessId], ['logo', true, B2]);
  assert.deepEqual([find(entries, car).kind, find(entries, car).inUse], ['vehicle_photo', true]);
});

test('payment QR while advance payment is on, and shared catalog photos, are protected', async () => {
  const qr = h.put(`payment-qr/business-${B1}-111.png`);
  const cat = h.put('vehicle-catalog/catalog-1.jpeg');
  db.businesses[0].payment_qr_url = url(qr);
  db.businesses[0].require_advance_payment = true;
  db.vehicle_type_catalog = [{ id: uuid(600), name: 'Sedan', photo_url: url(cat) }];
  const entries = await scan();
  assert.equal(find(entries, qr).protected, true);
  assert.equal(find(entries, qr).protectedReason, 'advance payment is on');
  assert.equal(find(entries, cat).protectedReason, 'shared catalog photo');
});

test('only the known folders are listed', async () => {
  h.put('random/thing.png');
  h.put('business-media/a.jpeg');
  const entries = await scan();
  assert.equal(entries.some(e => e.key.startsWith('random/')), false);
});

test('a business scan returns only that business: chat folders by prefix, other kinds by owner', async () => {
  const mine = h.put(`inbound-media/${B1}/${uuid(1)}.jpeg`);
  const theirs = h.put(`inbound-media/${B2}/${uuid(2)}.jpeg`);
  const lib1 = h.put('business-media/l1.jpeg');
  const lib2 = h.put('business-media/l2.jpeg');
  db.messages = [{ id: uuid(1), media_url: url(mine) }, { id: uuid(2), media_url: url(theirs) }];
  db.business_media = [
    { id: uuid(100), business_id: B1, r2_key: lib1, url: url(lib1), file_size_bytes: 1000, media_type: 'image' },
    { id: uuid(101), business_id: B2, r2_key: lib2, url: url(lib2), file_size_bytes: 1000, media_type: 'image' }
  ];
  const keys = (await scan({ businessId: B1 })).map(e => e.key).sort();
  assert.deepEqual(keys, [mine, lib1].sort());
});

// ── flow snapshots ──

const libFile = (n = 1) => {
  const k = h.put(`business-media/snap-${n}.jpeg`);
  (db.business_media = db.business_media || []).push({ id: uuid(100 + n), business_id: B1, r2_key: k, url: url(k), file_size_bytes: 1000, media_type: 'image' });
  return k;
};
const snapNode = (k, label = 'Welcome') => ({ id: uuid(700), keyword: 'hi', label, image_url: url(k), media_id: uuid(101) });

test('a personal flow snapshot that references the image keeps it in use (not protected)', async () => {
  const k = libFile();
  db.flow_snapshots = [{ id: uuid(800), business_id: B1, name: 'Before Diwali', is_category_template: false, nodes: [snapNode(k)] }];
  const e = find(await scan(), k);
  assert.deepEqual([e.kind, e.inUse, e.protected], ['bot_node_image', true, false]);
  assert.deepEqual(e.usedBy, [{ type: 'flow_snapshot', id: uuid(800), label: 'Before Diwali' }]);
  const sel = (includeInUse) => inventory.selectItems([e], { kinds: [], from: null, to: null, businessId: B1, minBytes: 0, includeInUse, orphanMode: false });
  assert.equal(sel(false).selected.length, 0);
  assert.equal(sel(true).selected.length, 1);
});

test('a snapshot that references the file through media_id only is also found', async () => {
  const k = libFile();
  db.flow_snapshots = [{ id: uuid(800), business_id: B1, name: 'v1', is_category_template: false, nodes: [{ id: uuid(700), label: 'x', image_url: null, media_id: uuid(101) }] }];
  assert.equal(find(await scan(), k).inUse, true);
});

test('a category template snapshot protects the image: "used by category template"', async () => {
  const k = libFile();
  db.flow_snapshots = [{ id: uuid(801), business_id: null, category: 'travels', name: 'Travels starter', is_category_template: true, nodes: [snapNode(k)] }];
  const e = find(await scan(), k);
  assert.deepEqual([e.inUse, e.protected, e.protectedReason], [true, true, 'used by category template']);
  // still found when the scan is limited to one business
  assert.equal(find(await scan({ businessId: B1 }), k).protectedReason, 'used by category template');
  const r = inventory.selectItems([e], { kinds: [], from: null, to: null, businessId: B1, minBytes: 0, includeInUse: true, orphanMode: false });
  assert.equal(r.selected.length, 0, 'not even with include-in-use');
  assert.equal(r.excluded.protected.count, 1);
});

test('the category-template reason wins when an image-only node also references the file', async () => {
  const k = libFile();
  db.flow_nodes = [{ id: uuid(200), business_id: B1, keyword: 'm', label: '', image_url: url(k), media_id: uuid(101) }];
  db.flow_snapshots = [{ id: uuid(801), business_id: null, category: 'travels', name: 'T', is_category_template: true, nodes: [snapNode(k)] }];
  assert.equal(find(await scan(), k).protectedReason, 'used by category template');
});

test('a snapshot node with no text is image-only: protected', async () => {
  const k = libFile();
  db.flow_snapshots = [{ id: uuid(800), business_id: B1, name: 'v1', is_category_template: false, nodes: [snapNode(k, '')] }];
  const e = find(await scan(), k);
  assert.deepEqual([e.protected, e.protectedReason], [true, 'image-only reply']);
});

// ── filters ──

const entry = (over = {}) => ({
  key: 'k', url: 'u', kind: 'chat_inbound', businessId: B1, sizeBytes: 1000, objectDate: new Date().toISOString(),
  referenced: true, inUse: false, protected: false, protectedReason: null, usedBy: [], ...over
});
const select = (entries, filters, opts) => inventory.selectItems(entries, { kinds: [], from: null, to: null, businessId: 'all', minBytes: 0, includeInUse: false, orphanMode: false, ...filters }, opts);

test('filters: kinds, business, min size', () => {
  const entries = [
    entry({ key: 'a', kind: 'chat_inbound', sizeBytes: 5000 }),
    entry({ key: 'b', kind: 'chat_echo', sizeBytes: 100 }),
    entry({ key: 'c', kind: 'library', businessId: B2, sizeBytes: 9000 })
  ];
  assert.deepEqual(select(entries, { kinds: ['chat_inbound', 'library'] }).selected.map(e => e.key), ['a', 'c']);
  assert.deepEqual(select(entries, { businessId: B2 }).selected.map(e => e.key), ['c']);
  assert.deepEqual(select(entries, { minBytes: 1000 }).selected.map(e => e.key), ['a', 'c']);
});

test('filters: from / to are India-time days and inclusive', () => {
  // 2026-10-01 23:30 IST = 18:00 UTC; 2026-10-02 00:10 IST = 2026-10-01 18:40 UTC
  const entries = [
    entry({ key: 'before', objectDate: '2026-09-30T18:29:00Z' }),   // 2026-09-30 23:59 IST
    entry({ key: 'start', objectDate: '2026-09-30T18:30:00Z' }),    // 2026-10-01 00:00 IST
    entry({ key: 'end', objectDate: '2026-10-01T18:29:00Z' }),      // 2026-10-01 23:59 IST
    entry({ key: 'after', objectDate: '2026-10-01T18:30:00Z' })     // 2026-10-02 00:00 IST
  ];
  assert.deepEqual(select(entries, { from: '2026-10-01', to: '2026-10-01' }).selected.map(e => e.key), ['start', 'end']);
  assert.deepEqual(select(entries, { to: '2026-09-30' }).selected.map(e => e.key), ['before']);
});

test('filters: in-use files are excluded unless includeInUse; protected never; keys in an open run skipped', () => {
  const entries = [
    entry({ key: 'safe' }),
    entry({ key: 'used', kind: 'bot_node_image', inUse: true }),
    entry({ key: 'prot', kind: 'bot_node_image', inUse: true, protected: true, protectedReason: 'image-only reply' }),
    entry({ key: 'queued' })
  ];
  const opts = { excludeKeys: new Set(['queued']) };
  let r = select(entries, {}, opts);
  assert.deepEqual(r.selected.map(e => e.key), ['safe']);
  assert.deepEqual([r.excluded.inUse.count, r.excluded.protected.count, r.excluded.alreadyPending.count], [1, 1, 1]);
  r = select(entries, { includeInUse: true }, opts);
  assert.deepEqual(r.selected.map(e => e.key), ['safe', 'used']);
  assert.equal(r.excluded.protected.count, 1, 'protected stays out even with includeInUse');
});

test('orphan mode: only unreferenced objects older than 48h; normal mode never selects orphans', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const hoursAgo = (n) => new Date(now.getTime() - n * HOUR).toISOString();
  const entries = [
    entry({ key: 'old', kind: 'orphan', referenced: false, objectDate: hoursAgo(49) }),
    entry({ key: 'young', kind: 'orphan', referenced: false, objectDate: hoursAgo(47) }),
    entry({ key: 'fresh-boundary', kind: 'orphan', referenced: false, objectDate: hoursAgo(48) }),
    entry({ key: 'referenced', objectDate: hoursAgo(500) })
  ];
  const orphan = select(entries, { orphanMode: true }, { now });
  assert.deepEqual(orphan.selected.map(e => e.key), ['old', 'fresh-boundary']);
  assert.equal(orphan.excluded.tooYoung.count, 1);
  assert.deepEqual(select(entries, {}, { now }).selected.map(e => e.key), ['referenced']);
});

test('summarize: totals by kind and by business', () => {
  const s = inventory.summarize([
    entry({ sizeBytes: 100 }), entry({ sizeBytes: 300, kind: 'library' }), entry({ sizeBytes: 50, businessId: B2 })
  ], new Map([[B1, { name: 'SG Travels' }], [B2, { name: 'Averix' }]]));
  assert.deepEqual([s.count, s.bytes], [3, 450]);
  assert.deepEqual(s.byKind.chat_inbound, { count: 2, bytes: 150 });
  assert.deepEqual(s.byBusiness.map(b => [b.name, b.bytes]), [['SG Travels', 400], ['Averix', 50]]);
});

test('summarize: chatMediaBytes per business counts chat_inbound + chat_echo only', () => {
  const s = inventory.summarize([
    entry({ sizeBytes: 100 }), entry({ sizeBytes: 40, kind: 'chat_echo' }), entry({ sizeBytes: 300, kind: 'library' }),
    entry({ sizeBytes: 7, kind: 'orphan' }), entry({ sizeBytes: 50, businessId: B2, kind: 'library' })
  ], new Map([[B1, { name: 'SG Travels' }], [B2, { name: 'Averix' }]]));
  assert.deepEqual(s.byBusiness.map(b => [b.name, b.bytes, b.chatMediaBytes]), [['SG Travels', 447, 140], ['Averix', 50, 0]]);
});
