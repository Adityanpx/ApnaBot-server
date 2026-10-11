// Run: node --test src/controllers/categoryTemplate.cleanMedia.test.js
// Template creation (cloneFromBusiness) and template import (importCategoryTemplate) strip the
// source business's media_id / own-R2 image_url / image_removed_at / per-node location pins,
// via utils/copySetup.js#transformNodesForCopy. In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
// The controllers pull in crypto.js, which needs a 32-char key at load time.
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const templateController = require('./categoryTemplate.controller');
const snapshotController = require('./flowSnapshot.controller');

const { B1, B2, uuid, url } = h;
const N1 = uuid(301);
const N2 = uuid(302);
const EXTERNAL = 'https://elsewhere.test/a.png';

const dirtyNode = (id, over = {}) => ({
  id, business_id: B1, node_type: 'reply', keyword: id, content_type: 'text', label: id,
  media_id: uuid(100), image_url: url('business-media/a.jpeg'), image_removed_at: '2026-10-01T00:00:00Z',
  latitude: 18.5, longitude: 73.8, location_name: 'Hotel One', address: 'FC Road', trigger_count: 9,
  ...over
});
const edge = { id: uuid(401), business_id: B1, from_node_id: N1, to_node_id: N2, condition_type: 'always' };

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_categories = [{ value: 'hotel', label: 'Hotel' }];
  db.businesses = [{ id: B1 }, { id: B2 }];
  db.flow_nodes = [dirtyNode(N1), dirtyNode(N2, { image_url: EXTERNAL, media_id: null })];
  db.flow_edges = [edge];
});

const call = async (handler, { body = {}, user = { businessId: B2, userId: 'u1' } } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, body, query: {}, user }, res, (err) => { throw err; });
  return out;
};

const assertClean = (n, { keepsUrl }) => {
  assert.equal(n.media_id, null);
  assert.equal(n.image_removed_at, null);
  assert.equal(n.image_url, keepsUrl ? EXTERNAL : null);
  for (const f of ['latitude', 'longitude', 'location_name', 'address']) assert.equal(n[f], null);
};

test('cloneFromBusiness: the stored template is clean; the source business is untouched', async () => {
  const { status } = await call(templateController.cloneFromBusiness, { body: { businessId: B1, category: 'hotel', name: 'T' } });
  assert.equal(status, 201);

  const tpl = db.flow_snapshots.find(s => s.is_category_template);
  assertClean(tpl.nodes.find(n => n.id === N1), { keepsUrl: false });
  assertClean(tpl.nodes.find(n => n.id === N2), { keepsUrl: true });
  assert.equal(tpl.nodes.length, 2);
  assert.deepEqual(tpl.edges.map(e => e.id), [edge.id]);

  // read-only on the source business's live rows
  assert.equal(db.flow_nodes.find(n => n.id === N1).media_id, uuid(100));
});

test('cloneFromBusiness: a sourceSnapshotId clone is cleaned too', async () => {
  db.flow_snapshots = [{
    id: 'snap-1', business_id: B1, is_category_template: false,
    nodes: [dirtyNode(N1)], edges: []
  }];
  await call(templateController.cloneFromBusiness, { body: { businessId: B1, category: 'hotel', name: 'T', sourceSnapshotId: 'snap-1' } });

  const tpl = db.flow_snapshots.find(s => s.is_category_template);
  assertClean(tpl.nodes[0], { keepsUrl: false });
});

test('importCategoryTemplate: an already-dirty template imports clean (live rows and restore point)', async () => {
  db.flow_nodes = [];
  db.flow_edges = [];
  db.flow_snapshots = [{
    id: 'tpl-1', business_id: null, category: 'hotel', is_category_template: true, is_active: true,
    nodes: [dirtyNode(N1), dirtyNode(N2, { image_url: EXTERNAL, media_id: null })], edges: [edge]
  }];

  const { status } = await call(snapshotController.importCategoryTemplate, { body: { templateId: 'tpl-1' } });
  assert.equal(status, 200);

  const live = db.flow_nodes.filter(n => n.business_id === B2);
  assert.equal(live.length, 2);
  assertClean(live.find(n => n.keyword === N1), { keepsUrl: false });
  assertClean(live.find(n => n.keyword === N2), { keepsUrl: true });
  assert.ok(live.every(n => n.trigger_count === 0));

  const restore = db.flow_snapshots.find(s => s.business_id === B2);
  restore.nodes.forEach(n => assert.equal(n.media_id, null));

  // the template row itself is not modified
  assert.equal(db.flow_snapshots.find(s => s.id === 'tpl-1').nodes[0].media_id, uuid(100));
});
