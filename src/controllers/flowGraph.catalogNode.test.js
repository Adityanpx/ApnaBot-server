// Run: node --test src/controllers/flowGraph.catalogNode.test.js
// The Catalogue reply (content_type 'catalog') is managed from the Catalogue page: the canvas batch save keeps it
// as stored (position only), cannot delete it by leaving it out, the single-node routes refuse it, and it
// takes no outgoing buttons. Copying a flow into another business / a template never carries it.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('./flowGraph.controller');
const { saveFullGraph } = require('../services/flowGraph.service');
const { writeBusinessGraphRows } = require('../services/flowSnapshot.service');

const { B1, B2, uuid } = h;
const CAT = uuid(200); const HI = uuid(201); const OTHER = uuid(202);
const EDGE = uuid(300);

let db; let rpcCalls;
test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  db.flow_nodes = [
    { id: HI, business_id: B1, node_type: 'reply', keyword: 'hi', match_type: 'exact', content_type: 'buttons', reply_kind: 'text', label: 'Welcome', is_active: true, trigger_count: 0, position_x: 0, position_y: 0 },
    { id: CAT, business_id: B1, node_type: 'reply', keyword: 'catalogue', match_type: 'contains', hindi_aliases: ['products'], content_type: 'catalog', reply_kind: 'text', label: 'Our catalogue', is_active: true, trigger_count: 4, position_x: 450, position_y: 0 },
    { id: OTHER, business_id: B1, node_type: 'reply', keyword: 'faq', match_type: 'contains', content_type: 'text', reply_kind: 'text', label: 'FAQ', is_active: true, trigger_count: 0 }
  ];
  db.flow_edges = [{ id: EDGE, business_id: B1, from_node_id: HI, to_node_id: CAT, label: 'Catalogue', display_order: 0 }];
});

const save = (payload) => saveFullGraph({ businessId: B1, graphBusiness: { businessCategory: 'menswear' }, questionNodes: [], ...payload });
const rpcArgs = () => rpcCalls.find(c => c.name === 'save_flow_graph_full').args;
const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'menswear' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const hiNode = { id: HI, keyword: 'hi', matchType: 'exact', contentType: 'buttons', label: 'Welcome' };
const faqNode = { id: OTHER, keyword: 'faq', label: 'FAQ' };

test('canvas save: whatever a client echoes for the catalogue node is ignored, only its position moves', async () => {
  const res = await save({
    replyNodes: [hiNode, faqNode, { id: CAT, keyword: 'HACKED', matchType: 'exact', contentType: 'text', label: 'changed', hindiAliases: [], isActive: false, positionX: 900, positionY: 120 }],
    edges: [{ id: EDGE, fromNodeId: HI, toNodeId: CAT, label: 'Catalogue' }]
  });
  assert.equal(res.error, null);
  const cat = rpcArgs().p_node_upserts.find(n => n.id === CAT);
  assert.deepEqual([cat.keyword, cat.content_type, cat.label, cat.hindi_aliases, cat.is_active, cat.match_type, cat.trigger_count], ['catalogue', 'catalog', 'Our catalogue', ['products'], true, 'contains', 4]);
  assert.deepEqual([cat.position_x, cat.position_y], [900, 120]);
});

test('canvas save: an echo with no position keeps the stored one', async () => {
  await save({ replyNodes: [hiNode, faqNode, { id: CAT, keyword: 'catalogue', contentType: 'catalog', label: 'x' }], edges: [{ id: EDGE, fromNodeId: HI, toNodeId: CAT, label: 'Catalogue' }] });
  const cat = rpcArgs().p_node_upserts.find(n => n.id === CAT);
  assert.deepEqual([cat.position_x, cat.position_y], [450, 0]);
});

test('canvas save: leaving the catalogue node out (a stale canvas) is refused, nothing is deleted', async () => {
  const res = await save({ replyNodes: [hiNode, faqNode], edges: [] });
  assert.match(res.error, /Catalogue reply cannot be deleted from the canvas/);
  assert.equal(rpcCalls.length, 0);
});

test('canvas save: a menu button INTO the catalogue is a normal edge (relabel works)', async () => {
  const res = await save({
    replyNodes: [hiNode, faqNode, { id: CAT, keyword: 'catalogue', contentType: 'catalog', label: 'x' }],
    edges: [{ id: EDGE, fromNodeId: HI, toNodeId: CAT, label: 'Shop' }]
  });
  assert.equal(res.error, null);
  assert.equal(rpcArgs().p_edge_upserts[0].label, 'Shop');
});

test('canvas save: a button leaving the catalogue node is refused; contentType catalog cannot be created through the canvas', async () => {
  const out = await save({
    replyNodes: [hiNode, faqNode, { id: CAT, keyword: 'catalogue', contentType: 'catalog', label: 'x' }],
    edges: [{ fromNodeId: CAT, toNodeId: OTHER, label: 'More' }]
  });
  assert.match(out.error, /cannot have outgoing buttons/);
  const created = await save({ replyNodes: [hiNode, faqNode, { id: CAT, keyword: 'catalogue', contentType: 'catalog', label: 'x' }, { keyword: 'second', contentType: 'catalog', label: 'y' }], edges: [] });
  assert.match(created.error, /contentType must be one of/);
});

test('single-node routes: edit, delete and toggle of the catalogue reply are refused with CATALOG_NODE_MANAGED', async () => {
  for (const [handler, extra] of [[controller.updateReplyNode, { body: { label: 'x' } }], [controller.deleteReplyNode, {}], [controller.toggleReplyNode, {}]]) {
    const out = await call(handler, { params: { id: CAT }, ...extra });
    assert.equal(out.status, 400);
    assert.equal(out.body.errors.code, 'CATALOG_NODE_MANAGED');
  }
  assert.equal(db.flow_nodes.find(n => n.id === CAT).is_active, true);
  assert.equal(db.flow_nodes.length, 3);
  assert.equal((await call(controller.toggleReplyNode, { params: { id: OTHER } })).status, 200, 'other reply nodes unaffected');
});

test('single-node routes: contentType catalog cannot be created, and no edge may leave the catalogue node', async () => {
  const created = await call(controller.createReplyNode, { body: { keyword: 'shop', contentType: 'catalog', label: 'x' } });
  assert.equal(created.status, 400);
  const edge = await call(controller.createEdge, { body: { fromNodeId: CAT, toNodeId: OTHER, label: 'More' } });
  assert.equal(edge.status, 400);
  assert.equal(edge.body.errors.code, 'CATALOG_NODE_MANAGED');
  const into = await call(controller.createEdge, { body: { fromNodeId: HI, toNodeId: CAT, label: 'Shop' } });
  assert.equal(into.status, 201, 'a button into it is fine');
});

test('copying a flow into another business / a template drops the catalogue node and the buttons that point at it', async () => {
  const nodes = db.flow_nodes.map(n => ({ ...n }));
  const edges = db.flow_edges.map(e => ({ ...e }));
  await writeBusinessGraphRows(B2, nodes, edges, { reuseIds: false, resetTriggerCount: true });
  const copied = db.flow_nodes.filter(n => n.business_id === B2);
  assert.deepEqual(copied.map(n => n.keyword).sort(), ['faq', 'hi']);
  assert.equal(db.flow_edges.filter(e => e.business_id === B2).length, 0, 'the hi -> catalogue button went with it');
});

test('restoring a snapshot (same business, ids kept) keeps the catalogue node', async () => {
  const nodes = db.flow_nodes.map(n => ({ ...n }));
  const edges = db.flow_edges.map(e => ({ ...e }));
  db.flow_nodes = []; db.flow_edges = [];
  await writeBusinessGraphRows(B1, nodes, edges, { reuseIds: true, resetTriggerCount: false });
  assert.ok(db.flow_nodes.some(n => n.id === CAT));
  assert.equal(db.flow_edges.length, 1);
});
