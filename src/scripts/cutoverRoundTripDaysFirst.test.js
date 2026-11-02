// Run: node --test src/scripts/cutoverRoundTripDaysFirst.test.js
// The SG Travels "days before the vehicles" cutover against an in-memory database shaped like SG Travels' real
// flow, seeded by the REAL seed script first: dry run writes nothing, --confirm changes only tagged edges (no node,
// no other edge), --rollback restores the seeded state byte for byte, and every wrong target or state is refused.
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
const fixture = require('../test-support/sgTravelsFlowFixture');
const seed = require('./seedTravelQuoteFlow');
const cutover = require('./cutoverRoundTripDaysFirst');

const { SG } = fixture;
const { N, E } = seed;
const OTHER = 'b2b2b2b2-0000-4000-8000-000000000002';
let db; let rpcCalls; let lines; let cacheFlushes; let migration; let rtRoutes;

// save_flow_graph_full, modelled: upserts by id, deletes scoped to the business.
const rpcImpl = (args, database) => {
  rpcCalls.push(args);
  const upsert = (table, rows) => {
    for (const row of rows) {
      const existing = database[table].find((r) => r.id === row.id);
      const value = JSON.parse(JSON.stringify({ ...row, business_id: args.p_business_id }));
      if (existing) Object.assign(existing, value); else database[table].push(value);
    }
  };
  upsert('flow_nodes', args.p_node_upserts || []);
  database.flow_edges = database.flow_edges.filter((e) => !(args.p_edge_deletes || []).includes(e.id) || e.business_id !== args.p_business_id);
  database.flow_nodes = database.flow_nodes.filter((n) => !(args.p_node_deletes || []).includes(n.id) || n.business_id !== args.p_business_id);
  upsert('flow_edges', args.p_edge_upserts || []);
  return null;
};

const seedDeps = () => ({
  supabase: holder.fake, isQuotesEnabled: async () => true, listQuotableRoutes: async () => [{ id: 'r1' }], invalidateCache: async () => {}, log: () => {}
});
const deps = () => ({
  supabase: holder.fake,
  migrationApplied: async () => migration,
  listQuotableRoutes: async () => rtRoutes,
  invalidateCache: async (id) => { cacheFlushes.push(id); },
  log: (line) => lines.push(line)
});
const opts = (over = {}) => ({ mode: 'cutover', confirm: false, businessArg: null, expectDeletes: null, expectCreates: null, ...over });
const go = (over) => cutover.run(opts(over), deps());
const out = () => lines.join('\n');
const snapshot = () => JSON.stringify({ n: db.flow_nodes, e: db.flow_edges });
const sorted = (rows) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));

test.beforeEach(async () => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: rpcImpl } });
  db = holder.fake.db;
  rpcCalls = []; lines = []; cacheFlushes = []; migration = true; rtRoutes = [{ id: 'r1' }];
  db.businesses = [{ id: SG, name: 'SG Travels', business_category: 'travels' }, { id: OTHER, name: 'Search cab AI', business_category: 'travels' }];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  // another business with its own flow: must never be touched
  db.flow_nodes.push({ id: 'oo-1', business_id: OTHER, node_type: 'question', field_key: 'vehicleType', is_active: true });
  db.flow_edges.push({ id: 'oo-e1', business_id: OTHER, from_node_id: 'oo-1', to_node_id: 'oo-1', condition: null, display_order: 0 });
  // seed SG Travels with the real seed script, then forget the seed's own writes
  const code = await seed.run({ mode: 'seed', confirm: true, menuButton: false, businessArg: null, expectNodes: null, expectEdges: null }, seedDeps());
  assert.equal(code, 0);
  rpcCalls = [];
});

const removedIds = () => [E.timeToDays, E.timeManualToDays, E.daysToQuote];
const addedIds = () => [E.paxToDays, E.daysToVehicle];
const edge = (id) => db.flow_edges.find((e) => e.id === id);

// ── Dry run ─────────────────────────────────────────────────────────────────────────────────────

test('dry run: writes nothing; lists the preconditions, the 3 edges deleted, the 2 created, and the path before and after', async () => {
  const before = snapshot();
  const code = await go();
  assert.equal(code, 0, out());
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
  assert.equal(cacheFlushes.length, 0);
  const text = out();
  assert.match(text, /dry run - nothing is written/);
  assert.ok(text.includes(`business ${SG} (SG Travels) only`));
  assert.match(text, /✓ it is not Search cab AI/);
  assert.match(text, /✓ migration 20261106120000 is applied/);
  assert.match(text, /✓ state: seeded, not cut over/);
  assert.match(text, /✓ Round Trip has at least one offerable route \(1\)/);
  assert.match(text, /Plan: delete 3 tagged edge\(s\), create 2 tagged edge\(s\)\. Nodes written: 0\. Non-tagged rows touched: 0\./);
  for (const id of removedIds()) assert.ok(text.includes(`- ${id}`), id);
  for (const id of addedIds()) assert.ok(text.includes(`+ ${id}`), id);
  assert.match(text, /\+ .*passengers -> numberOfDays {2}if tripType = Round Trip {2}order -1/);
  assert.match(text, /\+ .*numberOfDays -> vehicleType/);
  assert.match(text, /Round Trip\n {4}before: tripType > routePicker > passengers > vehicleType > travelDate > pickupTime > numberOfDays > quote\n {4}after: {2}tripType > routePicker > passengers > numberOfDays > vehicleType > travelDate > pickupTime > quote/);
  assert.match(text, /One Way\n {4}before: tripType > routePicker > passengers > vehicleType > travelDate > pickupTime > quote\n {4}after: {2}tripType > routePicker > passengers > vehicleType > travelDate > pickupTime > quote {3}\(unchanged\)/);
  assert.match(text, /mid-flow \(5-minute sessions\)/);
  assert.match(text, /Dry run only\. Re-run with --confirm/);
});

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────

test('--confirm: one RPC with tagged edge ids only and no node written; every node and every other edge byte-identical; cache flushed', async () => {
  const beforeNodes = sorted(db.flow_nodes);
  const keep = (rows) => sorted(rows.filter((e) => ![...removedIds(), ...addedIds()].includes(e.id)));
  const beforeEdges = keep(db.flow_edges);
  const code = await go({ confirm: true, expectDeletes: 3, expectCreates: 2 });
  assert.equal(code, 0, out());
  assert.equal(rpcCalls.length, 1);
  const call = rpcCalls[0];
  assert.equal(call.p_business_id, SG);
  assert.deepEqual([call.p_node_upserts, call.p_node_deletes], [[], []]);
  assert.deepEqual([...call.p_edge_deletes].sort(), [...removedIds()].sort());
  assert.deepEqual(call.p_edge_upserts.map((e) => e.id).sort(), [...addedIds()].sort());
  assert.ok([...call.p_edge_deletes, ...call.p_edge_upserts.map((e) => e.id)].every((id) => id.startsWith('5eed7a01-0000-4000-8000-')), 'only tagged ids');

  assert.equal(sorted(db.flow_nodes), beforeNodes);
  assert.equal(keep(db.flow_edges), beforeEdges);
  for (const id of removedIds()) assert.equal(edge(id), undefined, id);
  const paxToDays = edge(E.paxToDays);
  assert.deepEqual([paxToDays.from_node_id, paxToDays.to_node_id, paxToDays.condition, paxToDays.display_order], [N.passengers, N.numberOfDays, { field: 'tripType', equals: 'Round Trip' }, -1]);
  const daysToVehicle = edge(E.daysToVehicle);
  assert.deepEqual([daysToVehicle.from_node_id, daysToVehicle.to_node_id, daysToVehicle.condition, daysToVehicle.display_order], [N.numberOfDays, N.vehicle, null, 0]);
  // passengers -> vehicle is exactly as the seed wrote it
  assert.deepEqual([edge(E.paxToVehicle).display_order, edge(E.paxToVehicle).condition ?? null], [0, null]);
  assert.deepEqual(cacheFlushes, [SG]);
  assert.match(out(), /New edges present and as planned: yes\. Old edges gone: yes\. Every node and every other edge byte-identical: yes/);
});

test('--confirm leaves other businesses untouched (their flow rows are not read for writing or changed)', async () => {
  const other = () => JSON.stringify([db.flow_nodes.filter((n) => n.business_id === OTHER), db.flow_edges.filter((e) => e.business_id === OTHER)]);
  const before = other();
  assert.equal(await go({ confirm: true }), 0, out());
  assert.equal(other(), before);
});

test('after the cutover the real walker: Round Trip asks the days after passengers; One Way and the typed date / time siblings still reach the quote', async () => {
  await go({ confirm: true });
  const edges = db.flow_edges.filter((e) => seed.EDGE_ID_LIST.includes(e.id) && e.id !== E.rates);
  const rt = cutover.walk(edges, N.tripType, 'Round Trip');
  assert.deepEqual(rt, { ok: true, path: ['tripType', 'routePicker', 'passengers', 'numberOfDays', 'vehicleType', 'travelDate', 'pickupTime', 'quote'] });
  assert.equal(cutover.walk(edges, N.tripType, 'One Way').path.includes('numberOfDays'), false);
  for (const start of [N.travelDateManual, N.pickupTimeManual]) {
    for (const type of ['One Way', 'Round Trip']) assert.equal(cutover.walk(edges, start, type).ok, true, `${start} ${type}`);
  }
  assert.deepEqual(cutover.walk(edges, N.pickupTimeManual, 'Round Trip').path, ['pickupTime', 'quote']);
});

test('a second --confirm is a no-op: already cut over, nothing written', async () => {
  await go({ confirm: true });
  rpcCalls = []; lines = []; cacheFlushes = [];
  const before = snapshot();
  assert.equal(await go({ confirm: true }), 0);
  assert.match(out(), /Already cut over\. Nothing to do/);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snapshot(), before);
});

// ── Rollback ────────────────────────────────────────────────────────────────────────────────────

test('--rollback dry run: names the 2 edges it would delete and the 3 it would restore; writes nothing', async () => {
  await go({ confirm: true });
  rpcCalls = []; lines = [];
  const before = snapshot();
  assert.equal(await go({ mode: 'rollback' }), 0, out());
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
  assert.match(out(), /Plan: delete 2 tagged edge\(s\), create 3 tagged edge\(s\)/);
  assert.match(out(), /Dry run only\. Re-run with --rollback --confirm/);
});

test('--rollback --confirm restores the seeded graph byte for byte, touching tagged edges only', async () => {
  const seeded = sorted(db.flow_edges);
  const seededNodes = sorted(db.flow_nodes);
  await go({ confirm: true });
  assert.notEqual(sorted(db.flow_edges), seeded);
  rpcCalls = []; cacheFlushes = [];
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0, out());
  assert.equal(sorted(db.flow_edges), seeded);
  assert.equal(sorted(db.flow_nodes), seededNodes);
  const call = rpcCalls[0];
  assert.deepEqual([call.p_node_upserts, call.p_node_deletes], [[], []]);
  assert.deepEqual([...call.p_edge_deletes].sort(), [...addedIds()].sort());
  assert.deepEqual(call.p_edge_upserts.map((e) => e.id).sort(), [...removedIds()].sort());
  assert.deepEqual(cacheFlushes, [SG]);
});

test('--rollback when the flow was never cut over: nothing to do', async () => {
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0);
  assert.match(out(), /Nothing to roll back/);
  assert.equal(rpcCalls.length, 0);
});

test('the seed script\'s --rollback also removes the cutover edges (nothing tagged is left behind)', async () => {
  await go({ confirm: true });
  const base = sorted(fixture.edges());
  const code = await seed.run({ mode: 'rollback', confirm: true, menuButton: false, businessArg: null, expectNodes: null, expectEdges: null }, seedDeps());
  assert.equal(code, 0);
  assert.equal(db.flow_edges.filter((e) => seed.EDGE_ID_LIST.includes(e.id)).length, 0);
  assert.equal(sorted(db.flow_edges.filter((e) => e.business_id === SG)), base);
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

const refuses = async (over, pattern) => {
  const before = snapshot();
  const code = await go(over);
  assert.equal(code, 1, out());
  assert.match(out(), pattern);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snapshot(), before);
};

test('refuses any other business id', async () => {
  await refuses({ confirm: true, businessArg: OTHER }, /is not SG Travels' id/);
});

test('refuses when the business is named like Search cab AI, or is not SG Travels / travels', async () => {
  db.businesses[0].name = 'Search cab AI';
  await refuses({ confirm: true }, /this is Search cab AI/);
  lines = [];
  db.businesses[0].name = 'Some Cabs';
  await refuses({ confirm: true }, /not SG Travels/);
  lines = [];
  db.businesses[0].name = 'SG Travels'; db.businesses[0].business_category = 'software_it';
  await refuses({ confirm: true }, /not SG Travels/);
});

test('refuses when the migration is not applied', async () => {
  migration = false;
  await refuses({ confirm: true }, /apply supabase\/migrations\/20261106120000_round_trip_pricing\.sql first/);
});

test('refuses when no Round Trip route can be offered, or the lookup itself fails (server code / migration missing)', async () => {
  rtRoutes = [];
  await refuses({ confirm: true }, /no route can be priced for Round Trip/);
  lines = [];
  const failing = { ...deps(), listQuotableRoutes: async () => { throw new Error('column does not exist'); } };
  const code = await cutover.run(opts({ confirm: true }), failing);
  assert.equal(code, 1);
  assert.match(out(), /could not list the Round Trip routes/);
  assert.equal(rpcCalls.length, 0);
});

test('refuses when the quote flow is not seeded', async () => {
  db.flow_nodes = db.flow_nodes.filter((n) => !seed.NODE_ID_LIST.includes(n.id));
  db.flow_edges = db.flow_edges.filter((e) => !seed.EDGE_ID_LIST.includes(e.id));
  await refuses({ confirm: true }, /tagged node\(s\) missing - run seedTravelQuoteFlow\.js first/);
});

test('refuses a mixed state (only some of the old / new edges present)', async () => {
  db.flow_edges = db.flow_edges.filter((e) => e.id !== E.daysToQuote);
  await refuses({ confirm: true }, /mixed state/);
});

test('refuses when a seeded edge it touches or relies on was edited in the canvas', async () => {
  edge(E.timeToDays).display_order = 5;
  await refuses({ confirm: true }, /edited since: .*110/);
  lines = [];
  edge(E.timeToDays).display_order = 0;
  edge(E.paxToVehicle).display_order = 3;
  await refuses({ confirm: true }, /edited since: .*106/);
  lines = [];
  edge(E.paxToVehicle).display_order = 0;
  edge(E.timeToQuote).to_node_id = N.vehicle;
  await refuses({ confirm: true }, /edited since: .*111/);
});

test('refuses when a non-tagged edge is wired into the seeded nodes', async () => {
  db.flow_edges.push({ id: 'manual-1', business_id: SG, from_node_id: fixture.RATES, to_node_id: N.numberOfDays, condition: null, display_order: 0 });
  await refuses({ confirm: true }, /1 non-tagged edge\(s\) connect to the quote flow \(manual-1\)/);
});

test('refuses when the expected counts do not match the plan', async () => {
  await refuses({ confirm: true, expectDeletes: 4 }, /--expect-deletes=4 but the plan deletes 3/);
  lines = [];
  await refuses({ confirm: true, expectCreates: 1 }, /--expect-creates=1 but the plan creates 2/);
});

test('the plan check itself: it would refuse a change that leaves a path without a quote, changes One Way, or asks the days twice', () => {
  const { remove, add } = cutover.buildCutover();
  const seededEdges = seed.buildPlan({ businessId: SG, anchors: { rates: null, ratesEdges: [], menu: null, menuEdges: [] } }).edges;
  const before = cutover.pathsOf(seededEdges);
  const good = cutover.pathsOf([...seededEdges.filter((e) => !remove.some((r) => r.id === e.id)), ...add]);
  assert.deepEqual(cutover.planProblems(before, good), []);
  // days -> vehicle forgotten: Round Trip dead-ends at the days question
  const noDaysToVehicle = cutover.pathsOf([...seededEdges.filter((e) => !remove.some((r) => r.id === e.id)), add[0]]);
  assert.match(cutover.planProblems(before, noDaysToVehicle).join(';'), /Round Trip: the path from tripType would not reach the quote/);
  // nothing changed: the days are still after the vehicles
  assert.match(cutover.planProblems(before, before).join(';'), /still ask the days after the vehicles/);
});
