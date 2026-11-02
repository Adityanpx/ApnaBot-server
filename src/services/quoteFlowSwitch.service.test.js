// Run: node --test src/services/quoteFlowSwitch.service.test.js
// "Enable quotes" / "Disable quotes": the REAL installer and the REAL categoryFeature override code against an in-memory
// database shaped like a travels business (Travels default fixture). Only the checklist (getReadiness) is a stand-in whose
// blockers the tests choose. Covers: ready, blocked, Search cab AI, an install failure rolling the override back, the
// second call, the acknowledgement, a failed verification, and disable.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const holder = { fake: null };
stub('../config/env', { ENCRYPTION_KEY: 'x'.repeat(32) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/supabase', { from: (t) => holder.fake.from(t), rpc: (n, a) => holder.fake.rpc(n, a) });
require('../test-support/stubRedis');
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const switchService = require('./quoteFlowSwitch.service');
const { isOurNode } = require('../utils/quoteFlowIds');

const BIZ = fixture.BIZ;
const SEARCH_CAB = '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2';
let db; let rpcCalls; let blocking; let roundTripRoutes; let installerCodes; let readinessCalls;

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
    { id: BIZ, name: 'Demo Travels', display_name: null, business_category: 'travels' },
    { id: SEARCH_CAB, name: 'Search cab AI', display_name: 'Search cab AI', business_category: 'travels' }
  ];
  db.category_features = [];
  db.business_features = [];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  rpcCalls = []; blocking = []; roundTripRoutes = [{ id: 'r1' }]; installerCodes = []; readinessCalls = 0;
});

const overrideRow = (id = BIZ) => db.business_features.find((r) => r.business_id === id && r.feature === 'travel_quotes');
const ownCount = () => db.flow_nodes.filter((n) => isOurNode(BIZ, n.id)).length;
const savedPoints = () => (db.flow_snapshots || []);

// The real installer, wired to the in-memory database. `installerCodes` can force an exit code (or a throw) per call.
const runInstaller = async (options) => {
  const forced = installerCodes.shift();
  if (forced === 'throw') throw new Error('connection reset');
  if (typeof forced === 'number') return { code: forced, lines: [`REFUSED: forced ${forced}`] };
  const lines = [];
  const code = await installer.run(options, {
    supabase: holder.fake,
    isQuotesEnabled: async (category, id) => !!overrideRow(id) && overrideRow(id).is_enabled === true,
    listQuotableRoutes: async (id, tripType) => (tripType === 'round_trip' ? roundTripRoutes : [{ id: 'r1' }]),
    invalidateCache: async () => {},
    saveSnapshot: async (id, name, nodes, edges) => { db.flow_snapshots = [...(db.flow_snapshots || []), { id, name, nodes, edges }]; },
    findProtectedBusinessIds: () => installer.findProtectedBusinessIds(holder.fake),
    log: (line) => lines.push(line)
  });
  return { code, lines };
};

// A checklist as the real one would answer for the current database state; the tests choose what blocks.
const getReadiness = async () => {
  readinessCalls += 1;
  const installed = ownCount() === 11 ? 'installed' : 'not_installed';
  const on = !!overrideRow() && overrideRow().is_enabled === true;
  return {
    ready: blocking.length === 0,
    enabled: on && installed === 'installed',
    installed: { state: installed },
    acknowledgements: [{ key: 'round_trip_to_team', text: 'Round Trip goes to my team', required: roundTripRoutes.length === 0 }],
    items: blocking.map((key) => ({ key, status: 'block', title: `Fix ${key}`, detail: '' }))
  };
};
const deps = () => ({ getReadiness, runInstaller });

test('ready: turns the override ON, then installs the flow (restore point first), and returns the new readiness', async () => {
  const result = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(overrideRow().is_enabled, true);
  assert.equal(ownCount(), 11);
  assert.equal(savedPoints().length, 1, 'the restore point is reused from flow_snapshots (no new table)');
  assert.match(savedPoints()[0].name, /^Before quote flow/);
  assert.equal(result.readiness.enabled, true);
  assert.equal(result.readiness.installed.state, 'installed');
});

test('blocked: a blocking item refuses with what blocks; nothing is written, the override is untouched', async () => {
  blocking = ['routes_one_way'];
  const result = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, 'NOT_READY');
  assert.deepEqual(result.blockers.map((b) => b.key), ['routes_one_way']);
  assert.match(result.message, /Fix routes_one_way/);
  assert.equal(overrideRow(), undefined);
  assert.equal(rpcCalls.length, 0);
});

test('the "switch is off" item never blocks an enable - pressing Enable is what turns it on', async () => {
  const off = await getReadiness();
  off.items.push({ key: 'feature', status: 'block', title: 'x', detail: '' });
  const result = await switchService.enableQuoteFlow(BIZ, {}, { getReadiness: async () => off, runInstaller });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('Search cab AI is refused by id on enable and on disable, with a clear message; nothing is written or read of its flow', async () => {
  for (const call of [() => switchService.enableQuoteFlow(SEARCH_CAB, {}, deps()), () => switchService.disableQuoteFlow(SEARCH_CAB, deps())]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'PROTECTED_BUSINESS');
    assert.match(result.message, /Search cab AI .* live production/);
  }
  assert.equal(readinessCalls, 0, 'refused before its data is even read');
  assert.equal(overrideRow(SEARCH_CAB), undefined);
  assert.equal(rpcCalls.length, 0);
});

test('install failure rolls the override back to what it was (no row before -> no row after; an explicit off -> off again)', async () => {
  installerCodes = [1];
  const first = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(first.ok, false);
  assert.equal(first.code, 'INSTALL_FAILED');
  assert.equal(overrideRow(), undefined, 'the row that did not exist is removed again');
  assert.equal(ownCount(), 0);

  db.business_features.push({ business_id: BIZ, feature: 'travel_quotes', is_enabled: false });
  installerCodes = ['throw'];
  const second = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(second.ok, false);
  assert.equal(overrideRow().is_enabled, false, 'an explicit off is put back, not deleted');
  assert.match(second.message, /connection reset/);
});

test('an override that was already ON stays on when the install fails', async () => {
  db.business_features.push({ business_id: BIZ, feature: 'travel_quotes', is_enabled: true });
  installerCodes = [1];
  const result = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(result.ok, false);
  assert.equal(overrideRow().is_enabled, true);
});

test('a flow that was written but failed its check (exit 2) is removed again before the override is put back', async () => {
  await switchService.enableQuoteFlow(BIZ, {}, deps()); // installs for real
  assert.equal(ownCount(), 11);
  // Pretend the next install wrote rows but could not verify: the second runInstaller call must be the rollback.
  const modes = [];
  const result = await switchService.enableQuoteFlow(BIZ, {}, {
    getReadiness: async () => ({ ...(await getReadiness()), installed: { state: 'not_installed' }, enabled: false }),
    runInstaller: async (options) => { modes.push(options.mode); return options.mode === 'install' ? { code: 2, lines: ['REFUSED: not identical'] } : runInstaller(options); }
  });
  assert.equal(result.ok, false);
  assert.deepEqual(modes, ['install', 'rollback']);
  assert.equal(ownCount(), 0);
});

test('second call: already installed and on - nothing is written, no second restore point, the readiness comes back', async () => {
  await switchService.enableQuoteFlow(BIZ, {}, deps());
  rpcCalls.length = 0;
  const again = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(again.ok, true);
  assert.equal(again.alreadyEnabled, true);
  assert.equal(rpcCalls.length, 0);
  assert.equal(savedPoints().length, 1);
  assert.equal(db.business_features.filter((r) => r.business_id === BIZ).length, 1);
});

test('Round Trip with no priceable route needs the acknowledgement; with it the install goes ahead', async () => {
  roundTripRoutes = [];
  const refused = await switchService.enableQuoteFlow(BIZ, {}, deps());
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ACKNOWLEDGEMENT_REQUIRED');
  assert.equal(overrideRow(), undefined);
  assert.equal(rpcCalls.length, 0);
  const accepted = await switchService.enableQuoteFlow(BIZ, { acknowledgeRoundTripTeam: true }, deps());
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(ownCount(), 11);
});

test('a chosen keyword reaches the installer', async () => {
  await switchService.enableQuoteFlow(BIZ, { keyword: 'fare', aliases: ['get fare'] }, deps());
  const trigger = db.flow_nodes.find((n) => isOurNode(BIZ, n.id) && n.node_type === 'reply');
  assert.equal(trigger.keyword, 'fare');
  assert.deepEqual(trigger.hindi_aliases, ['get fare']);
});

test('disable: removes only the quote nodes, then sets the override OFF; a second disable changes nothing', async () => {
  await switchService.enableQuoteFlow(BIZ, {}, deps());
  const baseNodes = JSON.stringify(db.flow_nodes.filter((n) => !isOurNode(BIZ, n.id)));
  const result = await switchService.disableQuoteFlow(BIZ, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(ownCount(), 0);
  assert.equal(JSON.stringify(db.flow_nodes), baseNodes);
  assert.equal(overrideRow().is_enabled, false);
  assert.equal(result.readiness.enabled, false);
  rpcCalls.length = 0;
  const again = await switchService.disableQuoteFlow(BIZ, deps());
  assert.equal(again.ok, true);
  assert.equal(rpcCalls.length, 0);
  assert.equal(overrideRow().is_enabled, false);
});

test('disable: if the flow cannot be removed the override is left ON, so the switch and the flow never disagree', async () => {
  await switchService.enableQuoteFlow(BIZ, {}, deps());
  installerCodes = [1];
  const result = await switchService.disableQuoteFlow(BIZ, deps());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DISABLE_FAILED');
  assert.equal(overrideRow().is_enabled, true);
  assert.equal(ownCount(), 11);
});

// ── openRates: the override ON without the flow ─────────────────────────────────────────────────

const withFeature = (categoryBlocks = false) => async () => {
  const on = !!overrideRow() && overrideRow().is_enabled === true;
  return {
    ...(await getReadiness()),
    items: [
      { key: 'category', status: categoryBlocks ? 'block' : 'ok', title: 'Travel business', detail: 'The quote flow is for travels and cab businesses only.' },
      { key: 'feature', status: on ? 'ok' : 'warn', title: 'Quotes switched on', detail: '' }
    ]
  };
};
const openDeps = (categoryBlocks) => ({ getReadiness: withFeature(categoryBlocks), runInstaller });

test('open rates: turns the override ON and installs nothing; a second press changes nothing', async () => {
  const result = await switchService.openRates(BIZ, openDeps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(overrideRow().is_enabled, true);
  assert.equal(ownCount(), 0, 'no flow rows');
  assert.equal(rpcCalls.length, 0);
  assert.equal(savedPoints().length, 0, 'no restore point: nothing of the flow is touched');
  const again = await switchService.openRates(BIZ, openDeps());
  assert.equal(again.ok, true);
  assert.equal(again.alreadyOpen, true);
  assert.equal(db.business_features.filter((r) => r.business_id === BIZ).length, 1);
});

test('open rates: Search cab AI is refused by id, a non-travel business is refused, nothing is written', async () => {
  const protectedRun = await switchService.openRates(SEARCH_CAB, openDeps());
  assert.equal(protectedRun.status, 403);
  assert.equal(protectedRun.code, 'PROTECTED_BUSINESS');
  assert.equal(overrideRow(SEARCH_CAB), undefined);
  const salon = await switchService.openRates(BIZ, openDeps(true));
  assert.equal(salon.ok, false);
  assert.equal(salon.code, 'NOT_TRAVEL');
  assert.equal(overrideRow(), undefined);
});

test('open rates, then enable: the flow is installed and the override stays on; disable then sets the explicit off', async () => {
  await switchService.openRates(BIZ, openDeps());
  assert.equal((await switchService.enableQuoteFlow(BIZ, {}, deps())).ok, true);
  assert.equal(ownCount(), 11);
  await switchService.disableQuoteFlow(BIZ, deps());
  assert.equal(overrideRow().is_enabled, false);
});

test('open rates, then a failed install leaves the Rates page open (the override was already on)', async () => {
  await switchService.openRates(BIZ, openDeps());
  installerCodes = [1];
  assert.equal((await switchService.enableQuoteFlow(BIZ, {}, deps())).ok, false);
  assert.equal(overrideRow().is_enabled, true);
});
