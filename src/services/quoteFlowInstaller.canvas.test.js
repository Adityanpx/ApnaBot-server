// Run: node --test src/services/quoteFlowInstaller.canvas.test.js
// After the installer, the owner's web canvas must still open and save. This replays exactly what the canvas does -
// GET /api/flow-graph/full, then PUT it back with every node and edge spread as-is - against the real "Travels default"
// flow plus the installed rows, through the real controller and save service. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('./subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('../controllers/flowGraph.controller');
const { saveFullGraph } = require('./flowGraph.service');
const { findCycles, findUnreachableNodes, resolveBookingTriggerEntryNodeIds, findFlowEntryNodeId } = require('../utils/flowGraphValidation');
const { toCamelCase } = require('../utils/caseConvert');
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const { derive } = require('../utils/quoteFlowIds');

const BIZ = fixture.BIZ;
const ids = derive(BIZ);
let db; let rpcCalls;

test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
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
const canvasSave = async (mutate = (g) => g) => {
  const { body } = await call(controller.getFullGraph);
  const graph = mutate(JSON.parse(JSON.stringify(body.data)));
  // what FlowGraphCanvas#handleSaveFlow sends: every node and edge as GET returned it
  return saveFullGraph({
    businessId: BIZ, graphBusiness: { businessCategory: 'travels' },
    replyNodes: graph.replyNodes, questionNodes: graph.questionNodes, edges: graph.edges
  });
};

test('GET /full shows every installed node: computed ones as read-only question nodes, the trigger as a reply, all edges', async () => {
  const { body } = await call(controller.getFullGraph);
  const q = Object.fromEntries(body.data.questionNodes.map((n) => [n.id, n]));
  for (const id of [ids.N.routePicker, ids.N.vehicle, ids.N.quote]) assert.equal(q[id].isComputed, true, id);
  assert.equal(q[ids.N.routePicker].nodeType, 'route_picker');
  assert.equal(q[ids.N.quote].nodeType, 'quote');
  assert.equal(q[ids.N.tripType].isComputed, false);
  assert.ok(body.data.replyNodes.some((n) => n.id === ids.N.trigger && n.replyKind === 'booking_trigger'));
  assert.equal(body.data.edges.length, fixture.edges().length + 12);
  assert.ok(body.data.edges.some((e) => e.fromNodeId === ids.N.vehicle && e.toNodeId === ids.N.travelDate), 'the carousel -> date edge is returned');
});

test('a canvas save with no change goes through: nothing deleted, the carousel edge and every conditional edge kept', async () => {
  const result = await canvasSave();
  assert.equal(result.error, null);
  const args = rpcCalls[0].args;
  assert.deepEqual([args.p_node_deletes, args.p_edge_deletes], [[], []]);
  const edgeIds = new Set(args.p_edge_upserts.map((e) => e.id));
  assert.ok([ids.E.vehicleToDate, ids.E.paxToDays, ids.E.daysToVehicle, ids.E.paxToVehicle, ids.E.timeToQuote, ids.E.rates].every((id) => edgeIds.has(id)));
  const days = args.p_edge_upserts.find((e) => e.id === ids.E.paxToDays);
  assert.deepEqual(days.condition, { field: 'tripType', equals: 'Round Trip' });
  assert.equal(days.display_order, -1);
  const computed = args.p_node_upserts.filter((n) => n.is_computed && [ids.N.routePicker, ids.N.vehicle, ids.N.quote].includes(n.id));
  assert.deepEqual(computed.map((n) => n.node_type).sort(), ['quote', 'route_picker', 'vehicle_carousel']);
  assert.ok(computed.every((n) => Array.isArray(n.options) && n.options.length === 0));
});

test('dragging a node (position only) saves, including an installed computed node', async () => {
  const result = await canvasSave((g) => {
    for (const n of g.questionNodes) if (n.id === ids.N.routePicker || n.id === ids.N.tripType) { n.positionX = 400; n.positionY = 120; }
    return g;
  });
  assert.equal(result.error, null);
  const moved = rpcCalls[0].args.p_node_upserts.find((n) => n.id === ids.N.routePicker);
  assert.deepEqual([moved.position_x, moved.position_y, moved.node_type, moved.field_key], [400, 120, 'route_picker', 'routePicker']);
});

test('editing an existing node (the Rates reply) alongside still saves', async () => {
  const result = await canvasSave((g) => { g.replyNodes.find((n) => n.keyword === 'rates').label = 'New rates text'; return g; });
  assert.equal(result.error, null);
});

test('a NEW edge out of a vehicle carousel is still refused (only stored ones are kept)', async () => {
  const result = await canvasSave((g) => {
    g.edges.push({ fromNodeId: ids.N.vehicle, toNodeId: ids.N.pickupTime, label: null });
    return g;
  });
  assert.match(result.error, /vehicle_carousel nodes cannot have outgoing edges/);
  assert.equal(rpcCalls.length, 0);
});

test('an edge out of a carousel that is not stored yet is refused, as before the installer existed', async () => {
  db.flow_edges = db.flow_edges.filter((e) => e.id !== ids.E.vehicleToDate);
  const result = await canvasSave((g) => {
    g.edges.push({ id: ids.E.vehicleToDate, fromNodeId: ids.N.vehicle, toNodeId: ids.N.travelDate });
    return g;
  });
  assert.match(result.error, /vehicle_carousel nodes cannot have outgoing edges/);
});

test('the quote chain has no cycle; every installed question is reachable from the quote trigger (fallback siblings exempt)', () => {
  const nodes = db.flow_nodes.map(toCamelCase);
  const edges = db.flow_edges.map(toCamelCase);
  assert.deepEqual(findCycles(nodes, edges), []);
  const entries = resolveBookingTriggerEntryNodeIds(nodes, edges);
  assert.deepEqual(entries, [ids.N.tripType]);
  const unreachable = findUnreachableNodes(nodes, edges, entries);
  assert.deepEqual(unreachable.filter((id) => ids.nodeIds.includes(id)), [], 'none of the installed nodes is unreachable (the Travels default\'s own old questions are, as before)');
});

test('entered from a menu button only (no trigger node): the unreachable check is differential, so a save is still not blocked', async () => {
  // findUnreachableNodes takes its entry points from booking_trigger replies only, so with a menu-button entry
  // alone every question counts as unreachable - before AND after any edit - and a save is judged on what is NEWLY so.
  db.flow_nodes = db.flow_nodes.filter((n) => n.id !== ids.N.trigger);
  db.flow_edges = db.flow_edges.filter((e) => e.from_node_id !== ids.N.trigger);
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
  assert.equal(findFlowEntryNodeId(nodes, edges, ids.N.quote), ids.N.tripType);
  assert.equal(findFlowEntryNodeId(nodes, edges, ids.N.vehicle), ids.N.tripType);
  assert.equal(findFlowEntryNodeId(nodes, edges, ids.N.numberOfDays), ids.N.tripType);
  assert.equal(findFlowEntryNodeId(nodes, edges, ids.N.pickupTimeManual), null, 'a manual sibling is not an entry');
});
