// Run: node --test src/scripts/seedTravelQuoteFlow.canvas.test.js
// After the seed script, the owner's web canvas must still open and save. This replays exactly what the canvas
// does - GET /api/flow-graph/full, then PUT it back with every node and edge spread as-is - against SG Travels'
// flow plus the seeded rows, through the real controller and save service. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('../controllers/flowGraph.controller');
const { saveFullGraph } = require('../services/flowGraph.service');
const { findCycles, findUnreachableNodes, resolveBookingTriggerEntryNodeIds, findFlowEntryNodeId } = require('../utils/flowGraphValidation');
const { toCamelCase } = require('../utils/caseConvert');
const fixture = require('../test-support/sgTravelsFlowFixture');
const seed = require('./seedTravelQuoteFlow');

const { SG } = fixture;
let db; let rpcCalls;

test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  const plan = seed.buildPlan({ businessId: SG, anchors: seed.findAnchors(fixture.nodes(), fixture.edges()) });
  db.flow_nodes = [...fixture.nodes(), ...plan.nodes].map((n) => ({ ...n, business_id: SG }));
  db.flow_edges = [...fixture.edges(), ...plan.edges].map((e) => ({ ...e, business_id: SG }));
  db.businesses = [{ id: SG, enabled_languages: ['en', 'hi', 'mr'], language_picker: null, translation_status: null }];
});

const call = async (handler) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, body: {}, query: {}, graphBusiness: { businessCategory: 'travels' }, user: { businessId: SG, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const canvasSave = async (mutate = (g) => g) => {
  const { body } = await call(controller.getFullGraph);
  const graph = mutate(JSON.parse(JSON.stringify(body.data)));
  // what FlowGraphCanvas#handleSaveFlow sends: every node and edge as GET returned it
  return saveFullGraph({
    businessId: SG, graphBusiness: { businessCategory: 'travels' },
    replyNodes: graph.replyNodes, questionNodes: graph.questionNodes, edges: graph.edges
  });
};

test('GET /full shows every seeded node: computed ones as read-only question nodes, the trigger as a reply, all edges', async () => {
  const { body } = await call(controller.getFullGraph);
  const q = Object.fromEntries(body.data.questionNodes.map((n) => [n.id, n]));
  for (const id of [seed.N.routePicker, seed.N.vehicle, seed.N.quote]) assert.equal(q[id].isComputed, true, id);
  assert.equal(q[seed.N.routePicker].nodeType, 'route_picker');
  assert.equal(q[seed.N.quote].nodeType, 'quote');
  assert.equal(q[seed.N.tripType].isComputed, false);
  assert.ok(body.data.replyNodes.some((n) => n.id === seed.N.trigger && n.replyKind === 'booking_trigger'));
  assert.equal(body.data.edges.length, 5 + 13);
  assert.ok(body.data.edges.some((e) => e.fromNodeId === seed.N.vehicle && e.toNodeId === seed.N.travelDate), 'the carousel -> date edge is returned');
});

test('a canvas save with no change goes through: nothing deleted, the carousel edge and every conditional edge kept', async () => {
  const result = await canvasSave();
  assert.equal(result.error, null);
  const args = rpcCalls[0].args;
  assert.deepEqual([args.p_node_deletes, args.p_edge_deletes], [[], []]);
  const edgeIds = new Set(args.p_edge_upserts.map((e) => e.id));
  assert.ok([seed.E.vehicleToDate, seed.E.timeToDays, seed.E.timeToQuote, seed.E.timeManualToDays, seed.E.rates].every((id) => edgeIds.has(id)));
  const days = args.p_edge_upserts.find((e) => e.id === seed.E.timeToDays);
  assert.deepEqual(days.condition, { field: 'tripType', equals: 'Round Trip' });
  const computed = args.p_node_upserts.filter((n) => n.is_computed);
  assert.deepEqual(computed.map((n) => n.node_type).sort(), ['quote', 'route_picker', 'vehicle_carousel']);
  assert.ok(computed.every((n) => Array.isArray(n.options) && n.options.length === 0));
});

test('dragging a node (position only) saves, including a seeded computed node', async () => {
  const result = await canvasSave((g) => {
    for (const n of g.questionNodes) if (n.id === seed.N.routePicker || n.id === seed.N.tripType) { n.positionX = 400; n.positionY = 120; }
    return g;
  });
  assert.equal(result.error, null);
  const moved = rpcCalls[0].args.p_node_upserts.find((n) => n.id === seed.N.routePicker);
  assert.deepEqual([moved.position_x, moved.position_y, moved.node_type, moved.field_key], [400, 120, 'route_picker', 'routePicker']);
});

test('editing an existing node (the Rates reply) alongside still saves', async () => {
  const result = await canvasSave((g) => { g.replyNodes.find((n) => n.keyword === 'rates').label = 'New rates text'; return g; });
  assert.equal(result.error, null);
});

test('a NEW edge out of a vehicle carousel is still refused (only stored ones are kept)', async () => {
  const result = await canvasSave((g) => {
    g.edges.push({ fromNodeId: seed.N.vehicle, toNodeId: seed.N.pickupTime, label: null });
    return g;
  });
  assert.match(result.error, /vehicle_carousel nodes cannot have outgoing edges/);
  assert.equal(rpcCalls.length, 0);
});

test('an edge out of a carousel that is not stored yet is refused, as before the seed existed', async () => {
  db.flow_edges = db.flow_edges.filter((e) => e.id !== seed.E.vehicleToDate);
  const result = await canvasSave((g) => {
    g.edges.push({ id: seed.E.vehicleToDate, fromNodeId: seed.N.vehicle, toNodeId: seed.N.travelDate });
    return g;
  });
  assert.match(result.error, /vehicle_carousel nodes cannot have outgoing edges/);
});

test('the quote chain has no cycle; every seeded question is reachable from the quote trigger (fallback siblings exempt)', () => {
  const nodes = db.flow_nodes.map(toCamelCase);
  const edges = db.flow_edges.map(toCamelCase);
  assert.deepEqual(findCycles(nodes, edges), []);
  const entries = resolveBookingTriggerEntryNodeIds(nodes, edges);
  assert.deepEqual(entries, [seed.N.tripType]);
  assert.deepEqual(findUnreachableNodes(nodes, edges, entries), []);
});

test('entered from a menu button only (no trigger node): the unreachable check is differential, so a save is still not blocked', async () => {
  // findUnreachableNodes takes its entry points from booking_trigger replies only, so with a menu-button entry
  // alone every question counts as unreachable - before AND after any edit - and a save is judged on what is NEWLY so.
  db.flow_nodes = db.flow_nodes.filter((n) => n.id !== seed.N.trigger);
  db.flow_edges = db.flow_edges.filter((e) => e.from_node_id !== seed.N.trigger);
  const nodes = db.flow_nodes.map(toCamelCase);
  const edges = db.flow_edges.map(toCamelCase);
  assert.deepEqual(resolveBookingTriggerEntryNodeIds(nodes, edges), []);
  assert.ok(findUnreachableNodes(nodes, edges, []).length > 0, 'all question nodes count as unreachable with no booking_trigger');
  const result = await canvasSave();
  assert.equal(result.error, null, 'the canvas still saves');
});

test('"Change" restarts at the trip type question from the quote node, from either entry', () => {
  const nodes = db.flow_nodes.map(toCamelCase);
  const edges = db.flow_edges.map(toCamelCase);
  assert.equal(findFlowEntryNodeId(nodes, edges, seed.N.quote), seed.N.tripType);
  assert.equal(findFlowEntryNodeId(nodes, edges, seed.N.vehicle), seed.N.tripType);
  assert.equal(findFlowEntryNodeId(nodes, edges, seed.N.pickupTimeManual), null, 'a manual sibling is not an entry');
});
