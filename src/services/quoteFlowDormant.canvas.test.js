// Run: node --test src/services/quoteFlowDormant.canvas.test.js
// A DORMANT quote flow (signup install: no Rates button, inactive keyword reply) must survive the owner's canvas: GET
// /api/flow-graph/full returns every node and edge, and PUT-ing it back unchanged deletes nothing, keeps the trigger
// inactive and does not invent the button. Same replay as quoteFlowInstaller.canvas.test.js, against the real
// "Travels default" flow plus the dormant rows. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('./subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('../controllers/flowGraph.controller');
const { saveFullGraph } = require('./flowGraph.service');
const { QUESTION_SUBGRAPH_TYPES } = require('../utils/flowGraphValidation');
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const { derive } = require('../utils/quoteFlowIds');

const BIZ = fixture.BIZ;
const ids = derive(BIZ);
let db; let rpcCalls;

test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()), dormant: true });
  db.flow_nodes = [...fixture.nodes(), ...plan.nodes].map((n) => ({ ...n, business_id: BIZ }));
  db.flow_edges = [...fixture.edges(), ...plan.edges].map((e) => ({ ...e, business_id: BIZ }));
  db.businesses = [{ id: BIZ, enabled_languages: ['en', 'hi', 'mr'], language_picker: null, translation_status: null }];
});

const call = async (handler) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, body: {}, query: {}, graphBusiness: { businessCategory: 'travels' }, user: { businessId: BIZ, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const canvasSave = async () => {
  const { body } = await call(controller.getFullGraph);
  const graph = JSON.parse(JSON.stringify(body.data));
  return saveFullGraph({ businessId: BIZ, graphBusiness: { businessCategory: 'travels' }, replyNodes: graph.replyNodes, questionNodes: graph.questionNodes, edges: graph.edges });
};

test('the question-subgraph type list includes the computed quote types (a type missing from it is hidden and then deleted on save)', () => {
  for (const type of ['route_picker', 'quote', 'vehicle_carousel']) assert.ok(QUESTION_SUBGRAPH_TYPES.includes(type), type);
});

test('GET /full returns all 11 dormant nodes (the inactive trigger included) and all 11 dormant edges, with no Rates button', async () => {
  const { body } = await call(controller.getFullGraph);
  const nodeIds = new Set([...body.data.replyNodes, ...body.data.questionNodes].map((n) => n.id));
  for (const id of ids.nodeIds) assert.ok(nodeIds.has(id), `node ${id} is returned`);
  const trigger = body.data.replyNodes.find((n) => n.id === ids.N.trigger);
  assert.equal(trigger.isActive, false);
  assert.equal(body.data.edges.length, fixture.edges().length + 11);
  const edgeIds = new Set(body.data.edges.map((e) => e.id));
  for (const id of ids.edgeIds.filter((e) => e !== ids.E.rates && e !== ids.E.menu)) assert.ok(edgeIds.has(id), `edge ${id} is returned`);
  assert.equal(edgeIds.has(ids.E.rates), false);
});

test('a canvas save with no change deletes nothing, keeps all 11 nodes, keeps the trigger inactive and adds no button', async () => {
  const result = await canvasSave();
  assert.equal(result.error, null);
  const args = rpcCalls[0].args;
  assert.deepEqual([args.p_node_deletes, args.p_edge_deletes], [[], []]);
  const savedNodeIds = new Set(args.p_node_upserts.map((n) => n.id));
  for (const id of ids.nodeIds) assert.ok(savedNodeIds.has(id), `node ${id} kept`);
  assert.equal(args.p_node_upserts.find((n) => n.id === ids.N.trigger).is_active, false);
  assert.equal(args.p_edge_upserts.some((e) => e.id === ids.E.rates), false);
  assert.equal(args.p_edge_upserts.filter((e) => ids.edgeIds.includes(e.id)).length, 11);
});
