// Run: node --test src/scripts/seedTravelQuoteFlow.test.js
// The SG Travels quote-flow seed script against an in-memory database shaped like SG Travels' real flow:
// dry run writes nothing, --confirm creates only tagged rows and leaves every existing row byte-identical,
// a second run is refused, --rollback removes only the tagged rows, and every wrong target is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
// The real matcher (services/chatbot.service.js) runs in the shadow check, so only its outside world is stubbed.
const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const holder = { fake: null };
stub('../config/env', { ENCRYPTION_KEY: 'x'.repeat(32) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/supabase', { from: (t) => holder.fake.from(t), rpc: (n, a) => holder.fake.rpc(n, a) });
require('../test-support/stubRedis');
const h = { state: holder, reset: () => {} };
const fixture = require('../test-support/sgTravelsFlowFixture');
const seed = require('./seedTravelQuoteFlow');

const { SG } = fixture;
let db; let rpcCalls; let lines; let switchOn; let routes; let cacheFlushes; let queriedBusinesses;

// save_flow_graph_full, modelled: upserts by id (setting business_id), deletes scoped to the business.
const rpcImpl = (args, database) => {
  rpcCalls.push(args);
  const upsert = (table, rows) => {
    database[table] = database[table] || [];
    for (const row of rows) {
      const existing = database[table].find((r) => r.id === row.id);
      if (existing) Object.assign(existing, JSON.parse(JSON.stringify({ ...row, business_id: args.p_business_id })));
      else database[table].push(JSON.parse(JSON.stringify({ ...row, business_id: args.p_business_id })));
    }
  };
  upsert('flow_nodes', args.p_node_upserts || []);
  database.flow_edges = (database.flow_edges || []).filter((e) => !(args.p_edge_deletes || []).includes(e.id) || e.business_id !== args.p_business_id);
  database.flow_nodes = (database.flow_nodes || []).filter((n) => !(args.p_node_deletes || []).includes(n.id) || n.business_id !== args.p_business_id);
  upsert('flow_edges', args.p_edge_upserts || []);
  return null;
};

test.beforeEach(() => {
  h.reset();
  h.state.fake = createFakeSupabase({ rpc: { save_flow_graph_full: rpcImpl } });
  db = h.state.fake.db;
  rpcCalls = []; lines = []; switchOn = true; routes = [{ id: 'r1' }]; cacheFlushes = []; queriedBusinesses = [];
  db.businesses = [{ id: SG, name: 'SG Travels', business_category: 'travels' }];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
});

const deps = () => ({
  supabase: h.state.fake,
  isQuotesEnabled: async (category, id) => { queriedBusinesses.push(id); return switchOn; },
  listQuotableRoutes: async () => routes,
  invalidateCache: async (id) => { cacheFlushes.push(id); },
  log: (line) => lines.push(line)
});
const opts = (over = {}) => ({ mode: 'seed', confirm: false, menuButton: false, businessArg: null, expectNodes: null, expectEdges: null, ...over });
const go = (over) => seed.run(opts(over), deps());
const out = () => lines.join('\n');
const snapshot = () => JSON.stringify({ n: db.flow_nodes, e: db.flow_edges });
const ownNodes = () => db.flow_nodes.filter((n) => seed.NODE_ID_LIST.includes(n.id));
const ownEdges = () => db.flow_edges.filter((e) => seed.EDGE_ID_LIST.includes(e.id));

// ── Dry run ─────────────────────────────────────────────────────────────────────────────────────

test('dry run: writes nothing, names the business, lists the preconditions and exactly what it would create', async () => {
  const before = snapshot();
  const code = await go();
  assert.equal(code, 0);
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
  assert.equal(cacheFlushes.length, 0);
  const text = out();
  assert.match(text, /dry run - nothing is written/);
  assert.ok(text.includes(`business ${SG} (SG Travels) only`));
  assert.match(text, /✓ the travel_quotes switch is ON/);
  assert.match(text, /✓ at least one active route with an active fare \(1 for One Way\)/);
  assert.match(text, /Plan: create 11 node\(s\) and 13 edge\(s\)\. Existing rows modified: 0, deleted: 0\./);
  assert.match(text, /\+ .*route_picker .*routePicker/);
  assert.match(text, /button "Get a quote" \(hi "किराया जानें", mr "भाडे जाणून घ्या"\) order -1/);
  assert.match(text, /Dry run only\. Re-run with --confirm/);
  assert.match(text, /main menu "hi" is a buttons reply with 3 button\(s\) - left alone/);
});

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────

test('--confirm: creates only the tagged rows in one RPC with no deletes; every existing row is byte-identical; cache flushed', async () => {
  const beforeNodes = JSON.stringify(db.flow_nodes);
  const beforeEdges = JSON.stringify(db.flow_edges);
  const code = await go({ confirm: true });
  assert.equal(code, 0, out());
  assert.equal(rpcCalls.length, 1);
  const call = rpcCalls[0];
  assert.equal(call.p_business_id, SG);
  assert.deepEqual([call.p_node_deletes, call.p_edge_deletes], [[], []]);
  assert.equal(call.p_node_upserts.length, 11);
  assert.equal(call.p_edge_upserts.length, 13);
  assert.ok([...call.p_node_upserts, ...call.p_edge_upserts].every((r) => r.id.startsWith('5eed7a01-0000-4000-8000-')), 'every row is tagged');

  assert.equal(ownNodes().length, 11);
  assert.equal(ownEdges().length, 13);
  assert.equal(JSON.stringify(db.flow_nodes.filter((n) => !seed.NODE_ID_LIST.includes(n.id))), beforeNodes);
  assert.equal(JSON.stringify(db.flow_edges.filter((e) => !seed.EDGE_ID_LIST.includes(e.id))), beforeEdges);
  assert.deepEqual(cacheFlushes, [SG]);
  assert.match(out(), /all present\. Every pre-existing node and edge byte-identical: yes/);
});

test('the "Get a quote" button goes on the Rates reply, before its existing button, without touching that button', async () => {
  await go({ confirm: true });
  const button = db.flow_edges.find((e) => e.id === seed.E.rates);
  assert.deepEqual([button.from_node_id, button.to_node_id, button.label, button.display_order], [fixture.RATES, seed.N.tripType, 'Get a quote', -1]);
  const existing = db.flow_edges.find((e) => e.from_node_id === fixture.RATES && e.label === 'Book a ride');
  assert.equal(existing.display_order, 0);
  assert.equal(db.flow_edges.filter((e) => e.from_node_id === fixture.HI).length, 3, 'the main menu got nothing');
});

test('a second run is refused as already seeded - no write', async () => {
  await go({ confirm: true });
  const after = snapshot();
  rpcCalls.length = 0; lines.length = 0;
  const code = await go({ confirm: true });
  assert.equal(code, 0);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snapshot(), after);
  assert.match(out(), /Already seeded: 11 node\(s\), 13 edge\(s\)/);
});

test('--expect-nodes / --expect-edges abort when the plan differs', async () => {
  assert.equal(await go({ confirm: true, expectNodes: 10 }), 1);
  assert.match(out(), /--expect-nodes=10 but the plan has 11/);
  assert.equal(await go({ confirm: true, expectEdges: 12 }), 1);
  assert.equal(rpcCalls.length, 0);
  assert.equal(await go({ confirm: true, expectNodes: 11, expectEdges: 13 }), 0);
});

test('a failing write (e.g. the migration is not applied) surfaces the error and leaves the flow as it was', async () => {
  h.state.fake = createFakeSupabase({ rpc: { save_flow_graph_full: () => { throw new Error('violates check constraint "flow_nodes_node_type_check"'); } } });
  db = h.state.fake.db;
  db.businesses = [{ id: SG, name: 'SG Travels', business_category: 'travels' }];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  const before = snapshot();
  await assert.rejects(go({ confirm: true }), /node_type_check/);
  assert.equal(snapshot(), before);
});

// ── Main menu ───────────────────────────────────────────────────────────────────────────────────

test('--menu-button is refused while the main menu is a 3-button reply (a 4th would hide Contact Us)', async () => {
  const before = snapshot();
  assert.equal(await go({ menuButton: true, confirm: true }), 1);
  assert.match(out(), /REFUSED: --menu-button: the main menu is a buttons reply with 3 buttons/);
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
});

test('--menu-button works once the menu is a list: a first button, existing buttons unchanged', async () => {
  db.flow_nodes.find((n) => n.id === fixture.HI).content_type = 'list';
  const code = await go({ menuButton: true, confirm: true });
  assert.equal(code, 0, out());
  const button = db.flow_edges.find((e) => e.id === seed.E.menu);
  assert.deepEqual([button.from_node_id, button.to_node_id, button.display_order], [fixture.HI, seed.N.tripType, -1]);
  assert.deepEqual(db.flow_edges.filter((e) => e.from_node_id === fixture.HI && e.id !== seed.E.menu).map((e) => e.display_order), [0, 1, 2]);
});

test('the Rates reply with 3 buttons already would also be refused', async () => {
  for (let n = 0; n < 2; n++) db.flow_edges.push({ ...fixture.edges()[3], id: `00000000-0000-4000-8000-00000000099${n}`, display_order: 5 + n });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /"Our Rates" reply already has 3 buttons/);
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

test('any other business id is refused before anything is read', async () => {
  const code = await go({ businessArg: '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2', confirm: true });
  assert.equal(code, 1);
  assert.match(out(), /is not SG Travels' id/);
  assert.equal(rpcCalls.length, 0);
  assert.equal(queriedBusinesses.length, 0);
});

test('the SG id passed explicitly is accepted', async () => {
  assert.equal(await go({ businessArg: SG }), 0);
});

test('a business named like Search cab AI is refused', async () => {
  db.businesses[0].name = 'Search cab AI';
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /REFUSED: this is Search cab AI/);
  assert.equal(rpcCalls.length, 0);
});

test('not SG Travels (name or category) is refused', async () => {
  db.businesses[0].name = 'Pradip Tours';
  assert.equal(await go({ confirm: true }), 1);
  db.businesses[0].name = 'SG Travels'; db.businesses[0].business_category = 'cab';
  assert.equal(await go({ confirm: true }), 1);
  assert.equal(rpcCalls.length, 0);
});

test('the travel_quotes switch off is refused', async () => {
  switchOn = false;
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /travel_quotes is not switched on/);
  assert.equal(rpcCalls.length, 0);
});

test('no active route with an active fare is refused', async () => {
  routes = [];
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /no active route with an active fare/);
  assert.equal(rpcCalls.length, 0);
});

test('an id of the reserved range already used in another business is refused', async () => {
  db.flow_nodes.push({ id: seed.N.quote, business_id: 'someone-else', node_type: 'reply', keyword: 'x' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /reserved ids exists in another business/);
  assert.equal(rpcCalls.length, 0);
});

test('an existing reply that already answers "quote" (or one of its aliases) is not taken over', async () => {
  db.flow_nodes.push({ ...fixture.nodes()[1], id: '00000000-0000-4000-8000-000000000777', keyword: 'quotation', match_type: 'exact' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /does not reach the new quote trigger|would stop reaching/);
  assert.equal(rpcCalls.length, 0);
});

test('an existing question that already uses a field key of the flow is refused', async () => {
  db.flow_nodes.push({ ...fixture.nodes()[4], id: '00000000-0000-4000-8000-000000000778', field_key: 'passengers' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /already uses one of this flow's field keys/);
});

// ── Rollback ────────────────────────────────────────────────────────────────────────────────────

test('--rollback dry run lists exactly the tagged rows and changes nothing', async () => {
  await go({ confirm: true });
  const before = snapshot();
  lines.length = 0;
  assert.equal(await go({ mode: 'rollback' }), 0);
  assert.equal(snapshot(), before);
  assert.match(out(), /remove 11 node\(s\) and 13 edge\(s\) carrying this script's ids/);
  assert.match(out(), /Dry run only\. Re-run with --rollback --confirm/);
});

test('--rollback --confirm removes only the tagged rows: the flow is exactly what it was before seeding', async () => {
  const originalNodes = JSON.stringify(db.flow_nodes);
  const originalEdges = JSON.stringify(db.flow_edges);
  await go({ confirm: true });
  cacheFlushes.length = 0;
  const code = await go({ mode: 'rollback', confirm: true });
  assert.equal(code, 0, out());
  assert.equal(JSON.stringify(db.flow_nodes), originalNodes);
  assert.equal(JSON.stringify(db.flow_edges), originalEdges);
  assert.deepEqual(cacheFlushes, [SG]);
  assert.match(out(), /Own rows gone: yes\. Every other node and edge unchanged: yes/);
});

test('--rollback does not remove anything the owner added since', async () => {
  await go({ confirm: true });
  db.flow_nodes.push({ ...fixture.nodes()[2], id: '00000000-0000-4000-8000-000000000555', keyword: 'owner-added' });
  await go({ mode: 'rollback', confirm: true });
  assert.ok(db.flow_nodes.some((n) => n.id === '00000000-0000-4000-8000-000000000555'));
  assert.equal(ownNodes().length, 0);
});

test('--rollback refuses when an edge of the owner\'s now leads into the tagged nodes', async () => {
  await go({ confirm: true });
  db.flow_edges.push({ id: '00000000-0000-4000-8000-000000000556', business_id: SG, from_node_id: fixture.CONTACT, to_node_id: seed.N.tripType, label: 'Quote', display_order: 3 });
  const before = snapshot();
  assert.equal(await go({ mode: 'rollback', confirm: true }), 1);
  assert.match(out(), /that are not this script's connect to its nodes/);
  assert.equal(snapshot(), before);
});

test('--rollback on a flow that was never seeded says so', async () => {
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0);
  assert.match(out(), /Nothing to roll back/);
  assert.equal(rpcCalls.length, 0);
});

test('--rollback is scoped too: another business id is refused', async () => {
  assert.equal(await go({ mode: 'rollback', confirm: true, businessArg: 'b2b2b2b2-0000-4000-8000-000000000002' }), 1);
});

// ── The plan itself ─────────────────────────────────────────────────────────────────────────────

test('plan: unique tagged ids; every edge joins two known nodes; copy fits WhatsApp\'s limits with hi and mr everywhere', () => {
  const anchors = seed.findAnchors(fixture.nodes(), fixture.edges());
  const plan = seed.buildPlan({ businessId: SG, anchors, menuButton: true });
  const ids = [...plan.nodes, ...plan.edges].map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.startsWith('5eed7a01-0000-4000-8000-')));
  const known = new Set([...plan.nodes.map((n) => n.id), ...fixture.nodes().map((n) => n.id)]);
  assert.ok(plan.edges.every((e) => known.has(e.from_node_id) && known.has(e.to_node_id)));
  assert.deepEqual(seed.copyProblems(plan), []);
  for (const node of plan.nodes) {
    assert.ok(node.label_translations.hi && node.label_translations.mr, node.field_key);
    for (const o of node.options) assert.ok(o.labelTranslations.hi && o.labelTranslations.mr, `${node.field_key}/${o.value}`);
  }
});

test('plan: the copy checker really does catch an over-long button, a missing translation and too many buttons', () => {
  const anchors = seed.findAnchors(fixture.nodes(), fixture.edges());
  const plan = seed.buildPlan({ businessId: SG, anchors });
  plan.nodes.find((n) => n.field_key === 'tripType').options[0].label = 'A button title that is far too long';
  plan.nodes.find((n) => n.field_key === 'passengers').label_translations.mr = '';
  const problems = seed.copyProblems(plan).join('\n');
  assert.match(problems, /tripType option "One Way" \(en\).*max 20/);
  assert.match(problems, /passengers label \(mr\) is empty/);
});

test('plan: every row has the same keys (the RPC reads missing keys as null), and node types are the allowed ones', () => {
  const plan = seed.buildPlan({ businessId: SG, anchors: seed.findAnchors(fixture.nodes(), fixture.edges()) });
  const nodeKeys = JSON.stringify(Object.keys(plan.nodes[0]).sort());
  assert.ok(plan.nodes.every((n) => JSON.stringify(Object.keys(n).sort()) === nodeKeys));
  const edgeKeys = JSON.stringify(Object.keys(plan.edges[0]).sort());
  assert.ok(plan.edges.every((e) => JSON.stringify(Object.keys(e).sort()) === edgeKeys));
  assert.deepEqual([...new Set(plan.nodes.map((n) => n.node_type))].sort(), ['question', 'quote', 'reply', 'route_picker', 'vehicle_carousel']);
  assert.ok(plan.nodes.filter((n) => ['route_picker', 'quote', 'vehicle_carousel'].includes(n.node_type)).every((n) => n.is_computed && n.options.length === 0));
});
