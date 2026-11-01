// Run: node --test src/controllers/flowGraph.quoteNodes.test.js
// The travel-quote nodes (route_picker, quote) are computed question-subgraph nodes created only by a
// script. The canvas must see them (GET /full) and a canvas save must keep them as stored: if GET /full
// hid them, the next save would either delete them or be refused for every edit the owner makes.
// In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('./flowGraph.controller');
const { saveFullGraph } = require('../services/flowGraph.service');
const { QUESTION_SUBGRAPH_TYPES, findCycles } = require('../utils/flowGraphValidation');

const { B1, uuid } = h;
const MENU = uuid(300); const TRIP = uuid(301); const ROUTE = uuid(302); const QUOTE = uuid(303);
const E1 = uuid(400); const E2 = uuid(401); const E3 = uuid(402);

let db; let rpcCalls;
test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  db.flow_nodes = [
    { id: MENU, business_id: B1, node_type: 'reply', keyword: 'hi', match_type: 'exact', content_type: 'buttons', reply_kind: 'text', label: 'Welcome', is_active: true, trigger_count: 0 },
    { id: TRIP, business_id: B1, node_type: 'question', field_key: 'tripType', content_type: 'buttons', label: 'Trip?', options: ['One Way', 'Round Trip'], is_active: true, is_computed: false },
    { id: ROUTE, business_id: B1, node_type: 'route_picker', field_key: 'routePicker', content_type: 'list', label: 'Where to?', options: [], is_active: true, is_computed: true, position_x: 10, position_y: 20 },
    { id: QUOTE, business_id: B1, node_type: 'quote', field_key: 'quote', content_type: 'text', label: 'Your quote', options: [], is_active: true, is_computed: true }
  ];
  db.flow_edges = [
    { id: E1, business_id: B1, from_node_id: MENU, to_node_id: TRIP, label: 'Get a quote', display_order: 0 },
    { id: E2, business_id: B1, from_node_id: TRIP, to_node_id: ROUTE, display_order: 0 },
    { id: E3, business_id: B1, from_node_id: ROUTE, to_node_id: QUOTE, display_order: 0 }
  ];
});

const call = async (handler) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, body: {}, query: {}, graphBusiness: { businessCategory: 'travels' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const save = (payload) => saveFullGraph({ businessId: B1, graphBusiness: { businessCategory: 'travels' }, ...payload });
const rpcArgs = () => rpcCalls.find(c => c.name === 'save_flow_graph_full').args;
const menu = { id: MENU, keyword: 'hi', matchType: 'exact', contentType: 'buttons', label: 'Welcome' };
const trip = { id: TRIP, fieldKey: 'tripType', contentType: 'buttons', label: 'Trip?', options: ['One Way', 'Round Trip'] };
const edges = [
  { id: E1, fromNodeId: MENU, toNodeId: TRIP, label: 'Get a quote' },
  { id: E2, fromNodeId: TRIP, toNodeId: ROUTE },
  { id: E3, fromNodeId: ROUTE, toNodeId: QUOTE }
];

test('QUESTION_SUBGRAPH_TYPES covers the quote node types', () => {
  assert.deepEqual(QUESTION_SUBGRAPH_TYPES, ['question', 'vehicle_carousel', 'rentalPackage', 'route_picker', 'quote']);
});

test('GET /full returns route_picker and quote nodes as computed question nodes', async () => {
  const { body } = await call(controller.getFullGraph);
  const byId = Object.fromEntries(body.data.questionNodes.map(n => [n.id, n]));
  assert.equal(byId[ROUTE].nodeType, 'route_picker');
  assert.equal(byId[QUOTE].nodeType, 'quote');
  assert.equal(byId[ROUTE].isComputed, true);
  assert.equal(byId[QUOTE].isComputed, true);
  assert.equal(body.data.edges.length, 3);
});

test('canvas save echoing the quote nodes keeps them; only position moves', async () => {
  const res = await save({
    replyNodes: [menu],
    questionNodes: [trip, { id: ROUTE, positionX: 300, positionY: 40 }, { id: QUOTE }],
    edges
  });
  assert.equal(res.error, null);
  const upserts = rpcArgs().p_node_upserts;
  const route = upserts.find(n => n.id === ROUTE);
  assert.deepEqual([route.node_type, route.is_computed, route.field_key, route.position_x, route.position_y], ['route_picker', true, 'routePicker', 300, 40]);
  assert.equal(upserts.find(n => n.id === QUOTE).node_type, 'quote');
  assert.deepEqual(rpcArgs().p_node_deletes, []);
});

test('canvas save leaving a quote node out is refused, nothing is deleted', async () => {
  const res = await save({ replyNodes: [menu], questionNodes: [trip, { id: ROUTE }], edges: edges.slice(0, 2) });
  assert.match(res.error, /Cannot delete computed node/);
  assert.equal(rpcCalls.length, 0);
});

test('the quote chain is a valid question subgraph (no cycles)', () => {
  const nodes = db.flow_nodes.map(n => ({ id: n.id, nodeType: n.node_type }));
  const es = db.flow_edges.map(e => ({ id: e.id, fromNodeId: e.from_node_id, toNodeId: e.to_node_id, condition: null }));
  assert.deepEqual(findCycles(nodes, es), []);
});

test('the newest flow_nodes node_type CHECK lists reply + every question-subgraph type', () => {
  const dir = path.join(__dirname, '../../supabase/migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort().reverse();
  const reNode = /add constraint flow_nodes_node_type_check\s+check \(node_type in \(([^)]*)\)\)/i;
  const reComputed = /add constraint flow_nodes_is_computed_only_for_computed_types\s+check \(not is_computed or node_type in \(([^)]*)\)\)/i;
  const newest = (re) => {
    for (const f of files) {
      const m = fs.readFileSync(path.join(dir, f), 'utf8').match(re);
      if (m) return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    }
    throw new Error('no migration sets the constraint');
  };
  assert.deepEqual(newest(reNode).sort(), ['reply', ...QUESTION_SUBGRAPH_TYPES].sort());
  assert.deepEqual(newest(reComputed).sort(), ['vehicle_carousel', 'rentalPackage', 'route_picker', 'quote'].sort());
});
