// Run: node --test src/controllers/flowGraph.imageRemovedAt.test.js
// flow_nodes.image_removed_at (set by the storage sweeper): returned by the flow-graph API as
// imageRemovedAt, and cleared whenever a new image is set on the node - single-node PUTs and the
// canvas batch save - but not when an image is merely cleared or the node is edited otherwise.
// In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
// The controllers pull in crypto.js, which needs a 32-char key at load time.
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const controller = require('./flowGraph.controller');

const { B1, uuid, url } = h;
const REMOVED = '2026-10-01T10:00:00.000Z';
const NODE = uuid(200);
const QNODE = uuid(201);
const MEDIA = uuid(100);

let db;
test.beforeEach(() => {
  db = h.reset();
  db.flow_nodes = [
    { id: NODE, business_id: B1, node_type: 'reply', keyword: 'hi', content_type: 'text', label: 'Welcome', image_url: null, media_id: null, image_removed_at: REMOVED },
    { id: QNODE, business_id: B1, node_type: 'question', field_key: 'name', content_type: 'text', label: 'Name?', image_url: null, media_id: null, image_removed_at: REMOVED, options: [] }
  ];
  db.flow_edges = [];
  db.business_media = [{ id: MEDIA, business_id: B1, url: url('business-media/new.jpeg'), media_type: 'image' }];
});

const call = async (handler, { params = {}, body = {}, query = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query, graphBusiness: { businessCategory: 'coaching' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const node = (id) => db.flow_nodes.find(n => n.id === id);

test('GET /full returns imageRemovedAt for reply and question nodes', async () => {
  const { body } = await call(controller.getFullGraph);
  assert.equal(body.data.replyNodes[0].imageRemovedAt, REMOVED);
  assert.equal(body.data.questionNodes[0].imageRemovedAt, REMOVED);
});

test('GET /reply-nodes returns imageRemovedAt', async () => {
  const { body } = await call(controller.getReplyNodes);
  assert.equal(body.data.replyNodes[0].imageRemovedAt, REMOVED);
});

test('reply node: a library image (mediaId) clears image_removed_at', async () => {
  const { status } = await call(controller.updateReplyNode, { params: { id: NODE }, body: { mediaId: MEDIA } });
  assert.equal(status, 200);
  assert.deepEqual([node(NODE).media_id, node(NODE).image_removed_at], [MEDIA, null]);
});

test('reply node: a raw imageUrl clears image_removed_at', async () => {
  await call(controller.updateReplyNode, { params: { id: NODE }, body: { imageUrl: 'https://elsewhere.test/a.png' } });
  assert.deepEqual([node(NODE).image_url, node(NODE).image_removed_at], ['https://elsewhere.test/a.png', null]);
});

test('reply node: clearing the image or editing other fields keeps image_removed_at', async () => {
  await call(controller.updateReplyNode, { params: { id: NODE }, body: { mediaId: null } });
  assert.equal(node(NODE).image_removed_at, REMOVED);
  await call(controller.updateReplyNode, { params: { id: NODE }, body: { imageUrl: '' } });
  assert.equal(node(NODE).image_removed_at, REMOVED);
  await call(controller.updateReplyNode, { params: { id: NODE }, body: { label: 'Hello' } });
  assert.deepEqual([node(NODE).label, node(NODE).image_removed_at], ['Hello', REMOVED]);
});

test('question node: a new image clears image_removed_at; other edits do not', async () => {
  await call(controller.updateQuestionNode, { params: { id: QNODE }, body: { label: 'Your name?' } });
  assert.equal(node(QNODE).image_removed_at, REMOVED);
  await call(controller.updateQuestionNode, { params: { id: QNODE }, body: { mediaId: MEDIA } });
  assert.deepEqual([node(QNODE).media_id, node(QNODE).image_removed_at], [MEDIA, null]);
});

test('question node: a raw imageUrl clears image_removed_at', async () => {
  await call(controller.updateQuestionNode, { params: { id: QNODE }, body: { imageUrl: 'https://elsewhere.test/q.png' } });
  assert.equal(node(QNODE).image_removed_at, null);
});

// The RPC save_flow_graph_full is not modelled by the harness: stand in for it with a no-op, since its
// UPDATE SET deliberately leaves image_removed_at alone (so the marker survives it untouched).
const stubRpc = () => { h.state.fake.rpc = async () => ({ data: null, error: null }); };
const reply = (extra = {}) => ({ id: NODE, keyword: 'hi', label: 'Welcome', ...extra });
const question = (extra = {}) => ({ id: QNODE, fieldKey: 'name', label: 'Name?', ...extra });

test('canvas batch save: a node that gets an image loses the marker; others keep theirs', async () => {
  stubRpc();
  const { status } = await call(controller.saveFullGraph, {
    body: { replyNodes: [reply({ mediaId: MEDIA })], questionNodes: [question()], edges: [] }
  });
  assert.equal(status, 200);
  assert.equal(node(NODE).image_removed_at, null, 'new image on the reply node');
  assert.equal(node(QNODE).image_removed_at, REMOVED, 'question node got no image: its marker stays');
});

test('canvas batch save: nothing is written to flow_nodes when no node with a marker got an image', async () => {
  stubRpc();
  const updates = [];
  const realFrom = h.state.fake.from;
  h.state.fake.from = (t) => {
    const q = realFrom(t);
    if (t !== 'flow_nodes') return q;
    const realUpdate = q.update;
    q.update = (p) => { updates.push(p); return realUpdate(p); };
    return q;
  };
  await call(controller.saveFullGraph, { body: { replyNodes: [reply()], questionNodes: [question()], edges: [] } });
  assert.deepEqual(updates, []);
  assert.equal(node(NODE).image_removed_at, REMOVED);
});
