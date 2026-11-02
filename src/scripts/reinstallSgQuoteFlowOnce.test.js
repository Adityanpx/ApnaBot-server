// Run: node --test src/scripts/reinstallSgQuoteFlowOnce.test.js
// The one-time SG Travels reinstall against an in-memory database shaped like SG's flow after the first seed: its flow
// (test-support/sgTravelsFlowFixture.js) plus the old 5eed7a01-tagged quote rows and some saved quotes. The dry run writes
// nothing; --confirm saves a restore point, then replaces the old rows with the derived-id install in ONE RPC call, and
// verifies every other row and every saved quote is untouched; every wrong target or state is refused.
// DELETE THIS FILE together with the script it tests, right after the script has run.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
const installer = require('../services/quoteFlowInstaller.service');
const { derive, NODE_SLOTS } = require('../utils/quoteFlowIds');
const script = require('./reinstallSgQuoteFlowOnce');

const SG = fixture.SG;
const SEARCH_CAB = '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2';
const ids = derive(SG);
let db; let rpcCalls; let lines; let events; let switchOn; let oneWayRoutes; let roundTripRoutes; let cacheFlushes; let snapshotFails; let rpcDamagesQuotes;

// The old install, as it stands on SG: the installer's plan with every id replaced by its old fixed tag. (The live old edges
// are exactly these twelve: the Rates button, the entry, and the days-first edges the cutover had written.)
const OLD_EDGE_OF = {
  rates: 101, triggerToTrip: 103, tripToPicker: 104, pickerToPax: 105, paxToVehicle: 106, vehicleToDate: 107, dateToTime: 108,
  dateManualToTime: 109, timeToQuote: 111, timeManualToQuote: 113, paxToDays: 115, daysToVehicle: 116
};
const oldIdOf = (() => {
  const map = new Map();
  NODE_SLOTS.forEach((slot, i) => map.set(ids.N[slot], script.OLD_NODE_IDS[i]));
  for (const [slot, n] of Object.entries(OLD_EDGE_OF)) map.set(ids.E[slot], `5eed7a01-0000-4000-8000-${String(n).padStart(12, '0')}`);
  return (id) => map.get(id) || id;
})();
const oldInstall = () => {
  const plan = installer.buildPlan({ businessId: SG, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()), ids });
  return {
    nodes: plan.nodes.map((n) => ({ ...n, id: oldIdOf(n.id), business_id: SG })),
    edges: plan.edges.map((e) => ({ ...e, id: oldIdOf(e.id), from_node_id: oldIdOf(e.from_node_id), to_node_id: oldIdOf(e.to_node_id), business_id: SG }))
  };
};

// save_flow_graph_full, modelled: upserts by id (setting business_id), deletes scoped to the business.
const rpcImpl = (args, database) => {
  rpcCalls.push(args);
  events.push('rpc');
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
  if (rpcDamagesQuotes) database.travel_quotes = database.travel_quotes.slice(1);
  return null;
};

test.beforeEach(() => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: rpcImpl } });
  db = holder.fake.db;
  rpcCalls = []; lines = []; events = []; cacheFlushes = []; snapshotFails = false; rpcDamagesQuotes = false;
  switchOn = true; oneWayRoutes = [{ id: 'r1' }]; roundTripRoutes = [{ id: 'r1' }];
  db.businesses = [
    { id: SG, name: 'SG Travels', display_name: null, business_category: 'travels' },
    { id: SEARCH_CAB, name: 'Search cab AI', display_name: 'Search cab AI', business_category: 'travels' }
  ];
  const old = oldInstall();
  db.flow_nodes = [...fixture.nodes(), ...old.nodes];
  db.flow_edges = [...fixture.edges(), ...old.edges];
  db.travel_quotes = [
    { id: 'q1', business_id: SG, status: 'sent', total_amount: 3500, collected: { tripLabel: 'One Way' } },
    { id: 'q2', business_id: SG, status: 'paid', total_amount: 8800, collected: { tripLabel: 'Round Trip', days: 2 } },
    { id: 'q3', business_id: SG, status: 'expired', total_amount: 2100, collected: {} },
    { id: 'q-other', business_id: 'someone-else', status: 'sent', total_amount: 100, collected: {} }
  ];
  db.booking_form_tokens = [];
});

const deps = () => ({
  supabase: holder.fake,
  isQuotesEnabled: async () => switchOn,
  listQuotableRoutes: async (id, tripType) => (tripType === 'round_trip' ? roundTripRoutes : oneWayRoutes),
  invalidateCache: async (id) => { cacheFlushes.push(id); },
  saveSnapshot: async (id, name, nodes, edges) => {
    if (snapshotFails) throw new Error('disk full');
    events.push('snapshot');
    db.saved = [...(db.saved || []), { id, name, nodes: JSON.parse(JSON.stringify(nodes)), edges: JSON.parse(JSON.stringify(edges)) }];
  },
  findProtectedBusinessIds: () => installer.findProtectedBusinessIds(holder.fake),
  log: (line) => lines.push(line)
});
const go = (over = {}) => script.run({ confirm: false, ...over }, deps());
const out = () => lines.join('\n');
const snap = () => JSON.stringify({ n: db.flow_nodes, e: db.flow_edges, q: db.travel_quotes });
const oldRows = () => ({
  nodes: db.flow_nodes.filter((n) => script.OLD_NODE_IDS.includes(n.id)),
  edges: db.flow_edges.filter((e) => script.OLD_EDGE_IDS.includes(e.id))
});
const newRows = () => ({
  nodes: db.flow_nodes.filter((n) => ids.nodeIds.includes(n.id)),
  edges: db.flow_edges.filter((e) => ids.edgeIds.includes(e.id))
});

test('the starting state is what the live SG flow is: 11 old nodes, 12 old edges, the old Rates button next to "Book a ride"', () => {
  assert.equal(oldRows().nodes.length, 11);
  assert.equal(oldRows().edges.length, 12);
  assert.equal(db.flow_edges.filter((e) => e.from_node_id === fixture.RATES).length, 2);
  assert.equal(newRows().nodes.length, 0);
});

test('dry run: writes nothing, saves no restore point, and lists what it would remove and install', async () => {
  const before = snap();
  assert.equal(await go(), 0, out());
  assert.equal(snap(), before);
  assert.equal(rpcCalls.length, 0);
  assert.equal((db.saved || []).length, 0);
  assert.equal(cacheFlushes.length, 0);
  const text = out();
  assert.match(text, /dry run - nothing is written/);
  assert.match(text, /remove 11 old node\(s\) and 12 old edge\(s\)/);
  assert.match(text, /install 11 node\(s\) and 12 edge\(s\) with the derived ids\. Other rows modified: 0, deleted: 0\./);
  assert.match(text, /3 saved quote\(s\) in travel_quotes - never written/);
  assert.match(text, /✓ the "Get a quote" button on the Rates reply will come back/);
  assert.match(text, /Dry run only\. Re-run with --confirm/);
});

test('--confirm: restore point first, then ONE rpc that deletes the old rows and upserts the derived ones', async () => {
  const beforeNodes = JSON.stringify(db.flow_nodes);
  const beforeEdges = JSON.stringify(db.flow_edges);
  assert.equal(await go({ confirm: true }), 0, out());
  assert.deepEqual(events, ['snapshot', 'rpc']);
  assert.equal(JSON.stringify(db.saved[0].nodes), beforeNodes, 'the restore point holds the whole flow as it was, old rows included');
  assert.equal(JSON.stringify(db.saved[0].edges), beforeEdges);
  assert.match(db.saved[0].name, /^Before quote flow reinstall — /);

  assert.equal(rpcCalls.length, 1, 'one transaction');
  const call = rpcCalls[0];
  assert.equal(call.p_business_id, SG);
  assert.deepEqual([...call.p_node_deletes].sort(), [...script.OLD_NODE_IDS].sort());
  assert.deepEqual([...call.p_edge_deletes].sort(), db.saved[0].edges.filter((e) => script.OLD_EDGE_IDS.includes(e.id)).map((e) => e.id).sort());
  assert.deepEqual(call.p_node_upserts.map((n) => n.id).sort(), [...ids.nodeIds].sort());
  assert.equal(call.p_edge_upserts.length, 12);
  assert.ok(call.p_edge_upserts.every((e) => ids.edgeIds.includes(e.id)));

  assert.equal(oldRows().nodes.length + oldRows().edges.length, 0, 'the old rows are gone');
  assert.equal(newRows().nodes.length, 11);
  assert.equal(newRows().edges.length, 12);
  assert.deepEqual(cacheFlushes, [SG]);
  assert.match(out(), /New rows: all present\. Old rows: all gone\. Every other node and edge byte-identical: yes\. Saved quotes untouched \(3\): yes/);
});

test('every row that is not an old or a new quote row is byte-identical, and the saved quotes are untouched', async () => {
  const keep = (rows, ours) => JSON.stringify(rows.filter((r) => !ours.includes(r.id)));
  const nodesBefore = keep(db.flow_nodes, script.OLD_NODE_IDS);
  const edgesBefore = keep(db.flow_edges, script.OLD_EDGE_IDS);
  const quotesBefore = JSON.stringify(db.travel_quotes);
  assert.equal(await go({ confirm: true }), 0, out());
  assert.equal(keep(db.flow_nodes, ids.nodeIds), nodesBefore);
  assert.equal(keep(db.flow_edges, ids.edgeIds), edgesBefore);
  assert.equal(JSON.stringify(db.travel_quotes), quotesBefore);
});

test('the Rates "Get a quote" button comes back: first on the Rates reply, pointing at the new trip type question, "Book a ride" untouched', async () => {
  await go({ confirm: true });
  const buttons = db.flow_edges.filter((e) => e.from_node_id === fixture.RATES);
  assert.equal(buttons.length, 2);
  const quote = buttons.find((e) => e.id === ids.E.rates);
  assert.deepEqual([quote.to_node_id, quote.label, quote.display_order], [ids.N.tripType, 'Get a quote', -1]);
  assert.equal(buttons.find((e) => e.label === 'Book a ride').display_order, 0);
  assert.equal(db.flow_edges.filter((e) => e.from_node_id === fixture.HI).length, 3, 'the main menu got nothing');
});

test('the new install is the installer\'s: days first for Round Trip, the keyword reply back, derived ids only', async () => {
  await go({ confirm: true });
  const edges = newRows().edges;
  assert.ok(edges.some((e) => e.id === ids.E.paxToDays && e.condition && e.condition.equals === 'Round Trip'));
  assert.ok(edges.some((e) => e.id === ids.E.daysToVehicle));
  const trigger = db.flow_nodes.find((n) => n.id === ids.N.trigger);
  assert.deepEqual([trigger.keyword, trigger.reply_kind, trigger.match_type], ['quote', 'booking_trigger', 'exact']);
  assert.ok(![...db.flow_nodes, ...db.flow_edges].some((r) => String(r.id).startsWith('5eed7a01')), 'no old id is left');
});

test('a second run says it is already done - no write', async () => {
  await go({ confirm: true });
  const after = snap();
  rpcCalls.length = 0; lines.length = 0;
  assert.equal(await go({ confirm: true }), 0);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snap(), after);
  assert.match(out(), /Already reinstalled: 11 node\(s\), 12 edge\(s\)/);
});

test('a flow with none of the old rows and none of the new ones is refused (nothing to move)', async () => {
  const old = oldRows();
  db.flow_nodes = db.flow_nodes.filter((n) => !old.nodes.includes(n));
  db.flow_edges = db.flow_edges.filter((e) => !old.edges.includes(e));
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /nothing to move/);
  assert.equal(rpcCalls.length, 0);
});

test('a mixed state (old rows and new rows both present) is refused', async () => {
  db.flow_nodes.push({ ...fixture.nodes()[0], id: ids.N.quote, business_id: SG });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /mixed state/);
  assert.equal(rpcCalls.length, 0);
});

test('an edge that is not the old install\'s but leads into an old node is refused (it would be orphaned)', async () => {
  db.flow_edges.push({ id: '00000000-0000-4000-8000-000000000557', business_id: SG, from_node_id: fixture.CONTACT, to_node_id: script.OLD_NODE_IDS[1], label: 'Quote', display_order: 3 });
  const before = snap();
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /connect to the old quote nodes/);
  assert.equal(snap(), before);
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

test('any other business id is refused before anything is read', async () => {
  assert.equal(await go({ businessArg: 'b2b2b2b2-0000-4000-8000-000000000002', confirm: true }), 1);
  assert.match(out(), /is not SG Travels' id/);
  assert.equal(await go({ businessArg: SEARCH_CAB, confirm: true }), 1);
  assert.equal(rpcCalls.length, 0);
});

test('the SG id passed explicitly is accepted', async () => {
  assert.equal(await go({ businessArg: SG }), 0, out());
});

test('Search cab AI is refused by id from the fresh lookup, even if its row were the SG id', async () => {
  db.businesses.find((b) => b.id === SG).name = 'Search cab AI';
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /REFUSED: this is Search cab AI/);
  assert.equal(rpcCalls.length, 0);
  assert.equal((db.saved || []).length, 0);
});

test('a business that is not named SG Travels, or not a travels business, is refused', async () => {
  db.businesses.find((b) => b.id === SG).name = 'Pradip Tours';
  assert.equal(await go({ confirm: true }), 1);
  db.businesses.find((b) => b.id === SG).name = 'SG Travels';
  db.businesses.find((b) => b.id === SG).business_category = 'cab';
  assert.equal(await go({ confirm: true }), 1);
  assert.equal(rpcCalls.length, 0);
});

test('the installer\'s own refusals apply: switch off, no priceable One Way route, Round Trip without the acknowledgement', async () => {
  switchOn = false;
  assert.equal(await go({ confirm: true }), 1);
  switchOn = true; oneWayRoutes = [];
  assert.equal(await go({ confirm: true }), 1);
  oneWayRoutes = [{ id: 'r1' }]; roundTripRoutes = [];
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /no route can be priced for Round Trip/);
  assert.equal(await go({ confirm: true, ackRoundTripToTeam: true }), 0, out());
  assert.equal(rpcCalls.length, 1);
});

test('a keyword another active reply already uses is refused (the old trigger does not count: it is being replaced)', async () => {
  db.flow_nodes.push({ ...fixture.nodes()[1], id: '00000000-0000-4000-8000-000000000777', keyword: 'quotation', match_type: 'exact' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /already used by an active reply: "quotation"/);
  assert.equal(rpcCalls.length, 0);
});

// ── Failures ────────────────────────────────────────────────────────────────────────────────────

test('no restore point, no write: when the snapshot cannot be saved nothing is changed', async () => {
  snapshotFails = true;
  const before = snap();
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /could not save a restore point \(disk full\)\. Nothing was changed\./);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snap(), before);
});

test('a failing write leaves the old flow exactly as it was (the old rows are not deleted without the new ones)', async () => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: () => { throw new Error('violates check constraint "flow_nodes_node_type_check"'); } } });
  db = holder.fake.db;
  db.businesses = [{ id: SG, name: 'SG Travels', business_category: 'travels' }];
  const old = oldInstall();
  db.flow_nodes = [...fixture.nodes(), ...old.nodes];
  db.flow_edges = [...fixture.edges(), ...old.edges];
  db.travel_quotes = [];
  db.booking_form_tokens = [];
  const before = snap();
  await assert.rejects(go({ confirm: true }), /node_type_check/);
  assert.equal(snap(), before);
});

test('the verification really catches damage: if a saved quote were touched the script reports it and exits non-zero', async () => {
  rpcDamagesQuotes = true;
  assert.equal(await go({ confirm: true }), 2);
  assert.match(out(), /Saved quotes untouched \(3\): NO/);
});

// ── The old ids live here and nowhere else ──────────────────────────────────────────────────────

test('the old 5eed7a01 ids appear in this script only (no other source file names them; other tests only assert their absence)', () => {
  const root = path.join(__dirname, '..');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') && fs.readFileSync(full, 'utf8').includes('5eed7a01')) found.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(found, [['scripts', 'reinstallSgQuoteFlowOnce.js'].join(path.sep)]);
});
