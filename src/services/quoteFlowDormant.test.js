// Run: node --test src/services/quoteFlowDormant.test.js
// The DORMANT quote flow: a new travels business is signed up with the quote nodes installed but unreachable (no "Get a
// quote" button, keyword reply inactive, travel_quotes off), and Enable then activates only those two - with the full
// readiness gate. The REAL installer, switch service, readiness and defaultSetup run against an in-memory database shaped
// like a travels business (the "Travels default" fixture); only the route / vehicle lookups are stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const holder = { fake: null };
stub('../config/env', { ENCRYPTION_KEY: 'x'.repeat(32), R2_PUBLIC_URL: 'https://r2.test' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/supabase', { from: (t) => holder.fake.from(t), rpc: (n, a) => holder.fake.rpc(n, a) });
require('../test-support/stubRedis');
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const switchService = require('./quoteFlowSwitch.service');
const readiness = require('./quoteReadiness.service');
const { matchNodeInList } = require('./chatbot.service');
const { toCamelCase } = require('../utils/caseConvert');
const { derive, isOurNode, isOurEdge } = require('../utils/quoteFlowIds');

const BIZ = fixture.BIZ;
const SEARCH_CAB = '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2';
const ids = derive(BIZ);
let db; let rpcCalls; let routes; let snapshots;

const rpcImpl = (args, database) => {
  rpcCalls.push(args);
  const upsert = (table, rows) => {
    database[table] = database[table] || [];
    for (const row of rows) {
      const existing = database[table].find((r) => r.id === row.id);
      const copy = JSON.parse(JSON.stringify({ ...row, business_id: args.p_business_id }));
      if (existing) Object.assign(existing, copy); else database[table].push(copy);
    }
  };
  upsert('flow_nodes', args.p_node_upserts || []);
  database.flow_edges = (database.flow_edges || []).filter((e) => !(args.p_edge_deletes || []).includes(e.id) || e.business_id !== args.p_business_id);
  database.flow_nodes = (database.flow_nodes || []).filter((n) => !(args.p_node_deletes || []).includes(n.id) || n.business_id !== args.p_business_id);
  upsert('flow_edges', args.p_edge_upserts || []);
  return null;
};

test.beforeEach(() => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: rpcImpl } });
  db = holder.fake.db;
  db.businesses = [
    { id: BIZ, name: 'Demo Travels', display_name: null, business_category: 'travels', enabled_languages: ['en', 'hi', 'mr'], phone_number_id: null },
    { id: SEARCH_CAB, name: 'Search cab AI', display_name: 'Search cab AI', business_category: 'travels', enabled_languages: ['en'], phone_number_id: null },
    { id: 'cab-1', name: 'Cab Co', display_name: null, business_category: 'cab', enabled_languages: ['en'], phone_number_id: null }
  ];
  db.category_features = []; db.business_features = []; db.vehicles = [];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  rpcCalls = []; routes = [{ id: 'r1' }]; snapshots = [];
});

const overrideRow = () => db.business_features.find((r) => r.business_id === BIZ && r.feature === 'travel_quotes');
const own = (rows, kind = 'node') => rows.filter((r) => r.business_id === BIZ && (kind === 'node' ? isOurNode(BIZ, r.id) : isOurEdge(BIZ, r.id)));
const rowsOf = (table, excludeIds = []) => JSON.stringify(db[table].filter((r) => !excludeIds.includes(r.id)));
const trigger = () => db.flow_nodes.find((n) => n.id === ids.N.trigger);
const ratesEdges = () => db.flow_edges.filter((e) => e.from_node_id === fixture.RATES);

const installerDeps = (lines = []) => ({
  supabase: holder.fake,
  isQuotesEnabled: async () => !!overrideRow() && overrideRow().is_enabled === true,
  listQuotableRoutes: async () => routes,
  invalidateCache: async () => {},
  saveSnapshot: async (id, name, nodes, edges) => { snapshots.push({ id, name, nodes, edges }); },
  findProtectedBusinessIds: () => installer.findProtectedBusinessIds(holder.fake),
  log: (line) => lines.push(line)
});
const runInstaller = async (options) => {
  const lines = [];
  const code = await installer.run(options, installerDeps(lines));
  return { code, lines };
};
const readinessDeps = () => ({
  supabase: holder.fake,
  isEnabled: async () => !!overrideRow() && overrideRow().is_enabled === true,
  listQuotableRoutes: async () => routes,
  listRoutes: async () => [],
  getSubscription: async () => ({ status: 'active', end_date: '2027-01-01T00:00:00Z' }),
  getUsage: async () => ({ used: 0, cap: 100, remaining: 100 }),
  findProtectedBusinessIds: () => installer.findProtectedBusinessIds(holder.fake)
});
const switchDeps = () => ({ getReadiness: (id, entry) => readiness.getQuoteReadiness(id, entry, readinessDeps()), runInstaller });
const dormantInstall = (businessId = BIZ) => runInstaller({ mode: 'install', confirm: true, businessId, dormantAtSignup: true });

// ── the dormant install ─────────────────────────────────────────────────────────────────────────

test('dormant install: 11 nodes + 11 edges, no Rates button, keyword reply inactive, nothing else touched, no gate, no restore point', async () => {
  const before = { nodes: rowsOf('flow_nodes'), edges: rowsOf('flow_edges') };
  const { code, lines } = await dormantInstall(); // switch OFF and NO routes: the gate is skipped on purpose
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(own(db.flow_nodes).length, 11);
  assert.equal(own(db.flow_edges, 'edge').length, 11);
  assert.equal(db.flow_edges.some((e) => e.id === ids.E.rates || e.id === ids.E.menu), false, 'no entry button on Rates or the main menu');
  assert.equal(trigger().is_active, false);
  assert.equal(trigger().keyword, 'quote');
  assert.equal(rowsOf('flow_nodes', ids.nodeIds), before.nodes, 'every pre-existing node byte-identical');
  assert.equal(rowsOf('flow_edges', ids.edgeIds), before.edges, 'every pre-existing edge byte-identical');
  assert.equal(ratesEdges().length, 1, 'the Rates reply still has only its own button');
  assert.equal(overrideRow(), undefined, 'travel_quotes is not switched on');
  assert.equal(snapshots.length, 0);
  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0].p_node_deletes, []);
});

test('dormant install is idempotent: a second run writes nothing', async () => {
  await dormantInstall();
  rpcCalls.length = 0;
  const again = await dormantInstall();
  assert.equal(again.code, 0);
  assert.equal(rpcCalls.length, 0);
  assert.equal(own(db.flow_nodes).length, 11);
});

test('dormant install is refused for Search cab AI (by id), for a cab business, and as an activate/rollback option', async () => {
  db.flow_nodes = fixture.nodes().map((n) => ({ ...n, business_id: SEARCH_CAB }));
  const protectedRun = await dormantInstall(SEARCH_CAB);
  assert.equal(protectedRun.code, 1);
  assert.match(protectedRun.lines.join('\n'), /Search cab AI/);
  const cab = await dormantInstall('cab-1');
  assert.equal(cab.code, 1);
  assert.match(cab.lines.join('\n'), /travels businesses only/);
  const wrongMode = await runInstaller({ mode: 'activate', confirm: true, businessId: BIZ, dormantAtSignup: true });
  assert.equal(wrongMode.code, 1);
  assert.equal(rpcCalls.length, 0);
});

test('while dormant, the keyword reaches nothing and the button is not on any reply (what the bot loads is active replies only)', async () => {
  await dormantInstall();
  const activeReplies = db.flow_nodes.filter((n) => n.node_type === 'reply' && n.is_active !== false).map(toCamelCase);
  for (const text of ['quote', 'get a quote', 'कोटेशन', 'Quote']) {
    const hit = matchNodeInList(activeReplies, text, { unicode: true });
    assert.ok(!hit || hit.id !== ids.N.trigger, `"${text}" must not reach the dormant trigger`);
  }
  assert.equal(db.flow_edges.filter((e) => e.to_node_id === ids.N.tripType && e.from_node_id !== ids.N.trigger).length, 0, 'no edge enters the quote flow from outside');
});

test('readiness: a dormant install reports installed.state "dormant" and enabled false; a normal install is "installed"', async () => {
  await dormantInstall();
  const dormant = await readiness.getQuoteReadiness(BIZ, {}, readinessDeps());
  assert.equal(dormant.installed.state, 'dormant');
  assert.equal(dormant.enabled, false);
  assert.equal(dormant.keyword.value, 'quote');

  // a paused keyword whose button is still on Rates is not dormant; neither is a deleted button with an active keyword
  const paused = JSON.parse(JSON.stringify(db));
  const pausedFacts = { nodes: paused.flow_nodes, edges: [...paused.flow_edges, { id: ids.E.rates, business_id: BIZ, from_node_id: fixture.RATES, to_node_id: ids.N.tripType }] };
  const base = { businessId: BIZ, protectedBusiness: false, category: 'travels', featureOn: true, oneWayRoutes: 1, roundTripRoutes: 1, routes: [], vehicles: [], settingsSaved: true,
    advance: { requireAdvancePayment: false }, whatsappConnected: true, subscription: { status: 'active' }, languages: ['en'], usage: null };
  assert.equal(readiness.buildReadiness({ ...base, ...pausedFacts }).installed.state, 'installed');
  const noButtonActive = paused.flow_nodes.map((n) => (n.id === ids.N.trigger ? { ...n, is_active: true } : n));
  assert.equal(readiness.buildReadiness({ ...base, nodes: noButtonActive, edges: paused.flow_edges }).installed.state, 'installed');
});

// ── Enable on a dormant business ────────────────────────────────────────────────────────────────

test('Enable keeps the FULL gate on a dormant business: no active One Way route -> refused, nothing written, switch untouched', async () => {
  await dormantInstall();
  routes = [];
  rpcCalls.length = 0;
  const before = JSON.stringify({ n: db.flow_nodes, e: db.flow_edges });
  const result = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_READY');
  assert.ok(result.blockers.some((b) => b.key === 'routes_one_way'));
  assert.equal(rpcCalls.length, 0);
  assert.equal(overrideRow(), undefined);
  assert.equal(JSON.stringify({ n: db.flow_nodes, e: db.flow_edges }), before);
});

test('Enable on a dormant business: ONLY the keyword reply is activated and the Rates button added; everything else byte-identical; switch on', async () => {
  await dormantInstall();
  const triggerBefore = JSON.parse(JSON.stringify(trigger()));
  const othersNodes = rowsOf('flow_nodes', [ids.N.trigger]);
  const othersEdges = rowsOf('flow_edges', [ids.E.rates]);
  rpcCalls.length = 0;

  const result = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.readiness.installed.state, 'installed');
  assert.equal(result.readiness.enabled, true);
  assert.equal(overrideRow().is_enabled, true);

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].p_node_upserts.length, 1, 'one node written: the keyword reply');
  assert.equal(rpcCalls[0].p_edge_upserts.length, 1, 'one edge written: the button');
  assert.deepEqual([rpcCalls[0].p_node_deletes, rpcCalls[0].p_edge_deletes], [[], []]);

  assert.equal(trigger().is_active, true, 'the keyword reply is ACTIVE now');
  assert.deepEqual({ ...trigger(), is_active: false }, triggerBefore, 'and nothing else about it changed');
  const button = db.flow_edges.find((e) => e.id === ids.E.rates);
  assert.ok(button, 'the button exists');
  assert.deepEqual([button.from_node_id, button.to_node_id, button.label], [fixture.RATES, ids.N.tripType, 'Get a quote']);
  const shown = ratesEdges().sort((a, b) => a.display_order - b.display_order);
  assert.equal(shown[0].id, ids.E.rates, 'it is shown first');
  assert.equal(rowsOf('flow_nodes', [ids.N.trigger]), othersNodes);
  assert.equal(rowsOf('flow_edges', [ids.E.rates]), othersEdges);
  assert.equal(snapshots.length, 1);
  assert.match(snapshots[0].name, /^Before activating the quote flow/);

  // and the keyword now reaches the trigger
  const activeReplies = db.flow_nodes.filter((n) => n.node_type === 'reply' && n.is_active !== false).map(toCamelCase);
  assert.equal(matchNodeInList(activeReplies, 'quote', { unicode: true }).id, ids.N.trigger);

  // a second Enable is a no-op
  rpcCalls.length = 0;
  const again = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(again.alreadyEnabled, true);
  assert.equal(rpcCalls.length, 0);
});

test('Enable on a dormant business: a Rates reply that now shows 3 buttons blocks it (a 4th would hide one); nothing written', async () => {
  await dormantInstall();
  db.flow_edges.push({ id: 'extra-btn', business_id: BIZ, from_node_id: fixture.RATES, to_node_id: fixture.CONTACT, label: 'Extra', display_order: 5 });
  db.flow_edges.push({ id: 'extra-btn2', business_id: BIZ, from_node_id: fixture.RATES, to_node_id: fixture.CONTACT, label: 'Extra 2', display_order: 6 });
  rpcCalls.length = 0;
  const result = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.key === 'rates_button'));
  assert.equal(rpcCalls.length, 0);
  assert.equal(trigger().is_active, false);
});

test('Enable on a dormant business: a keyword another active reply took since signup blocks it', async () => {
  await dormantInstall();
  db.flow_nodes.push({ id: 'owner-quote', business_id: BIZ, node_type: 'reply', keyword: 'quote', match_type: 'exact', hindi_aliases: [], content_type: 'text', label: 'Mine', is_active: true });
  rpcCalls.length = 0;
  const result = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((b) => b.key === 'keyword'));
  assert.equal(rpcCalls.length, 0);
  assert.equal(trigger().is_active, false);
});

test('Enable on a dormant business with a keyword chosen at Enable: the trigger takes it, still only that row changes', async () => {
  await dormantInstall();
  const result = await switchService.enableQuoteFlow(BIZ, { keyword: 'fare', aliases: ['get fare'] }, switchDeps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(trigger().keyword, 'fare');
  assert.deepEqual(trigger().hindi_aliases, ['get fare']);
  assert.equal(trigger().is_active, true);
});

test('a failed activation puts the switch back to what it was', async () => {
  await dormantInstall();
  const result = await switchService.enableQuoteFlow(BIZ, {}, { ...switchDeps(), runInstaller: async () => { throw new Error('connection reset'); } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INSTALL_FAILED');
  assert.equal(overrideRow(), undefined);
  assert.equal(trigger().is_active, false);
});

test('Enable on a business with NO flow installed is the normal install: 11 nodes, 12 edges, keyword active, button present', async () => {
  const result = await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(own(db.flow_nodes).length, 11);
  assert.equal(own(db.flow_edges, 'edge').length, 12);
  assert.equal(trigger().is_active, true);
  assert.ok(db.flow_edges.some((e) => e.id === ids.E.rates));
});

test('Disable on a dormant business removes everything (nodes, edges) and sets the switch to an explicit off', async () => {
  await dormantInstall();
  const baseNodes = rowsOf('flow_nodes', ids.nodeIds);
  const baseEdges = rowsOf('flow_edges', ids.edgeIds);
  const result = await switchService.disableQuoteFlow(BIZ, switchDeps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(own(db.flow_nodes).length, 0);
  assert.equal(own(db.flow_edges, 'edge').length, 0);
  assert.equal(rowsOf('flow_nodes'), baseNodes);
  assert.equal(rowsOf('flow_edges'), baseEdges);
  assert.equal(overrideRow().is_enabled, false);
});

test('Disable after Enable removes the button edge too', async () => {
  await dormantInstall();
  await switchService.enableQuoteFlow(BIZ, {}, switchDeps());
  await switchService.disableQuoteFlow(BIZ, switchDeps());
  assert.equal(db.flow_edges.some((e) => e.id === ids.E.rates), false);
  assert.equal(own(db.flow_nodes).length, 0);
  assert.equal(ratesEdges().length, 1);
});

// ── signup: applyDefaultSetup ───────────────────────────────────────────────────────────────────

const { applyDefaultSetup } = require('./defaultSetup.service');
const signupTemplate = (category = 'travels') => ({
  id: 'tpl-travels', category, name: 'Travels default', is_category_template: true, is_default: true, is_active: true, business_id: null,
  nodes: fixture.nodes().map((n) => ({ ...n, business_id: undefined })), edges: fixture.edges().map((e) => ({ ...e, business_id: undefined }))
});
const signup = (businessId, category, name = 'New Travels') => {
  db.flow_nodes = []; db.flow_edges = [];
  db.businesses.push({ id: businessId, name, display_name: null, business_category: category, flow_fields: [], enabled_languages: ['en'], phone_number_id: null });
  db.flow_snapshots = [signupTemplate(category === 'travels' ? 'travels' : category)];
};
const mine = (businessId, table) => db[table].filter((r) => r.business_id === businessId);

test('signup: a new travels business gets the default flow PLUS the dormant quote flow - exact state', async () => {
  signup('new-biz-1', 'travels');
  const result = await applyDefaultSetup('new-biz-1');
  assert.equal(result.applied, true);
  assert.equal(result.quoteFlowDormant, true);
  const nodes = mine('new-biz-1', 'flow_nodes');
  const edges = mine('new-biz-1', 'flow_edges');
  const qids = derive('new-biz-1');
  assert.equal(nodes.length, 17 + 11);
  assert.equal(edges.length, 22 + 11);
  assert.equal(nodes.filter((n) => qids.nodeIds.includes(n.id)).length, 11);
  assert.equal(edges.filter((e) => qids.edgeIds.includes(e.id)).length, 11);
  assert.equal(edges.some((e) => e.id === qids.E.rates), false, 'button absent');
  assert.equal(nodes.find((n) => n.id === qids.N.trigger).is_active, false, 'keyword reply inactive');
  assert.equal(db.business_features.filter((r) => r.business_id === 'new-biz-1').length, 0, 'travel_quotes: no override row -> off (category default off)');
  // the template's own nodes ("hi", "rates", "book", "contactinfo") are untouched: "hi" keeps its 3 buttons, Rates its 1
  const hi = nodes.find((n) => n.keyword === 'hi');
  assert.equal(edges.filter((e) => e.from_node_id === hi.id).length, 3);
  const rates = nodes.find((n) => n.keyword === 'rates');
  assert.equal(edges.filter((e) => e.from_node_id === rates.id).length, 1);
  // the shared template is not modified
  assert.equal(db.flow_snapshots[0].nodes.length, 17);
});

test('signup: the real readiness of that business says "dormant", ready false only for the routes it does not have yet', async () => {
  signup('new-biz-2', 'travels');
  await applyDefaultSetup('new-biz-2');
  routes = [];
  const r = await readiness.getQuoteReadiness('new-biz-2', {}, readinessDeps());
  assert.equal(r.installed.state, 'dormant');
  assert.equal(r.enabled, false);
  assert.deepEqual(r.items.filter((i) => i.status === 'block').map((i) => i.key), ['routes_one_way']);
});

test('signup: other categories (general, cab) get no quote flow; Search cab AI-named business is refused by the installer and keeps the default flow', async () => {
  signup('new-biz-3', 'general');
  await applyDefaultSetup('new-biz-3');
  assert.equal(mine('new-biz-3', 'flow_nodes').length, 17);

  signup('new-biz-4', 'cab');
  await applyDefaultSetup('new-biz-4');
  assert.equal(mine('new-biz-4', 'flow_nodes').length, 17);

  signup('new-biz-5', 'travels', 'Search cab AI');
  const result = await applyDefaultSetup('new-biz-5');
  assert.equal(result.applied, true);
  assert.equal(result.quoteFlowDormant, false);
  assert.equal(mine('new-biz-5', 'flow_nodes').length, 17, 'the normal default flow, no quote nodes');
});

test('signup: an installer failure never fails signup - the business keeps the normal default flow', async () => {
  signup('new-biz-6', 'travels');
  const original = holder.fake.rpc;
  holder.fake.rpc = async () => { throw new Error('rpc down'); };
  const result = await applyDefaultSetup('new-biz-6');
  holder.fake.rpc = original;
  assert.equal(result.applied, true);
  assert.equal(result.quoteFlowDormant, false);
  assert.equal(mine('new-biz-6', 'flow_nodes').length, 17);
  assert.equal(mine('new-biz-6', 'flow_edges').length, 22);
});

test('signup: an existing business (it already has nodes) is left alone - no quote flow is added', async () => {
  // BIZ already has the fixture flow
  db.flow_snapshots = [signupTemplate('travels')];
  const result = await applyDefaultSetup(BIZ);
  assert.deepEqual(result, { applied: false, reason: 'already_has_nodes' });
  assert.equal(own(db.flow_nodes).length, 0);
  assert.equal(rpcCalls.length, 0);
});
