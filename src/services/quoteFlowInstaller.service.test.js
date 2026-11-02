// Run: node --test src/services/quoteFlowInstaller.service.test.js
// The quote-flow installer against an in-memory database shaped like a real travels business: the "Travels default" flow
// (test-support/travelsDefaultFlowFixture.js - the legacy booking questions included). Dry run writes nothing, --confirm
// creates only the business's own derived-id rows after saving a restore point and leaves every existing row
// byte-identical, a second run is refused, rollback removes only those rows, and every wrong target is refused.
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
const fixture = require('../test-support/travelsDefaultFlowFixture');
const installer = require('./quoteFlowInstaller.service');
const { derive, isOurNode, isOurEdge } = require('../utils/quoteFlowIds');

const BIZ = fixture.BIZ;
const SEARCH_CAB = '8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2';
const ids = derive(BIZ);
let db; let rpcCalls; let lines; let events; let switchOn; let oneWayRoutes; let roundTripRoutes; let cacheFlushes; let snapshotFails;

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
  return null;
};

const freshDb = () => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: rpcImpl } });
  db = holder.fake.db;
  db.businesses = [
    { id: BIZ, name: 'Demo Travels', display_name: null, business_category: 'travels' },
    { id: SEARCH_CAB, name: 'Search cab AI', display_name: 'Search cab AI', business_category: 'travels' }
  ];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
};
test.beforeEach(() => {
  freshDb();
  rpcCalls = []; lines = []; events = []; cacheFlushes = []; snapshotFails = false;
  switchOn = true; oneWayRoutes = [{ id: 'r1' }]; roundTripRoutes = [{ id: 'r1' }];
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
const opts = (over = {}) => ({ mode: 'install', confirm: false, businessId: BIZ, menuButton: false, expectNodes: null, expectEdges: null, ...over });
const go = (over) => installer.run(opts(over), deps());
const out = () => lines.join('\n');
const snapshot = () => JSON.stringify({ n: db.flow_nodes, e: db.flow_edges });
const ownNodes = () => db.flow_nodes.filter((n) => isOurNode(BIZ, n.id));
const ownEdges = () => db.flow_edges.filter((e) => isOurEdge(BIZ, e.id));

// ── Dry run ─────────────────────────────────────────────────────────────────────────────────────

test('dry run: writes nothing, names the business, lists the preconditions and exactly what it would create', async () => {
  const before = snapshot();
  const code = await go();
  assert.equal(code, 0, out());
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
  assert.equal(cacheFlushes.length, 0);
  assert.equal((db.saved || []).length, 0, 'no restore point on a dry run');
  const text = out();
  assert.match(text, /dry run - nothing is written/);
  assert.ok(text.includes(`business ${BIZ}`));
  assert.match(text, /✓ the travel_quotes switch is ON/);
  assert.match(text, /✓ at least one active route with an active One Way fare \(1\)/);
  assert.match(text, /Plan: create 11 node\(s\) and 12 edge\(s\)\. Existing rows modified: 0, deleted: 0\./);
  assert.match(text, /\+ .*route_picker .*routePicker/);
  assert.match(text, /button "Get a quote" \(hi "किराया जानें", mr "भाडे जाणून घ्या"\) order -1/);
  assert.match(text, /✓ One Way and Round Trip both reach the quote; Round Trip asks the days once, before the vehicles/);
  assert.match(text, /Dry run only\. Re-run with --confirm/);
  assert.match(text, /main menu "hi" is a buttons reply with 3 button\(s\) - left alone/);
});

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────

test('--confirm: restore point first, then one RPC with the derived ids and no deletes; every existing row is byte-identical', async () => {
  const beforeNodes = JSON.stringify(db.flow_nodes);
  const beforeEdges = JSON.stringify(db.flow_edges);
  const code = await go({ confirm: true });
  assert.equal(code, 0, out());
  assert.deepEqual(events, ['snapshot', 'rpc'], 'the restore point is saved before anything is written');
  assert.equal(db.saved.length, 1);
  assert.match(db.saved[0].name, /^Before quote flow — /);
  assert.equal(JSON.stringify(db.saved[0].nodes), beforeNodes, 'the restore point is the flow as it was');
  assert.equal(JSON.stringify(db.saved[0].edges), beforeEdges);

  assert.equal(rpcCalls.length, 1);
  const call = rpcCalls[0];
  assert.equal(call.p_business_id, BIZ);
  assert.deepEqual([call.p_node_deletes, call.p_edge_deletes], [[], []]);
  assert.equal(call.p_node_upserts.length, 11);
  assert.equal(call.p_edge_upserts.length, 12);
  assert.ok(call.p_node_upserts.every((r) => isOurNode(BIZ, r.id)) && call.p_edge_upserts.every((r) => isOurEdge(BIZ, r.id)), 'every row carries this business\'s derived id');

  assert.equal(ownNodes().length, 11);
  assert.equal(ownEdges().length, 12);
  assert.equal(JSON.stringify(db.flow_nodes.filter((n) => !isOurNode(BIZ, n.id))), beforeNodes);
  assert.equal(JSON.stringify(db.flow_edges.filter((e) => !isOurEdge(BIZ, e.id))), beforeEdges);
  assert.deepEqual(cacheFlushes, [BIZ]);
  assert.match(out(), /all present\. Every pre-existing node and edge byte-identical: yes/);
});

test('the legacy booking questions with the same field keys do not block the install and are left exactly as they are', async () => {
  assert.ok(db.flow_nodes.some((n) => n.field_key === 'tripType'), 'the Travels default has its own tripType question');
  assert.equal(await go({ confirm: true }), 0, out());
  assert.equal(db.flow_nodes.filter((n) => n.field_key === 'tripType').length, 2);
});

test('the "Get a quote" button goes on the Rates reply, before its existing button, without touching that button', async () => {
  await go({ confirm: true });
  const button = db.flow_edges.find((e) => e.id === ids.E.rates);
  assert.deepEqual([button.from_node_id, button.to_node_id, button.label, button.display_order], [fixture.RATES, ids.N.tripType, 'Get a quote', -1]);
  const existing = db.flow_edges.find((e) => e.from_node_id === fixture.RATES && e.label === 'Book a ride');
  assert.equal(existing.display_order, 0);
  assert.equal(db.flow_edges.filter((e) => e.from_node_id === fixture.HI).length, 3, 'the main menu got nothing');
});

test('a second run is refused as already installed - no write, no second restore point', async () => {
  await go({ confirm: true });
  const after = snapshot();
  rpcCalls.length = 0; lines.length = 0;
  const code = await go({ confirm: true });
  assert.equal(code, 0);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snapshot(), after);
  assert.equal(db.saved.length, 1);
  assert.match(out(), /Already installed: 11 node\(s\), 12 edge\(s\)/);
});

test('--expect-nodes / --expect-edges abort when the plan differs', async () => {
  assert.equal(await go({ confirm: true, expectNodes: 10 }), 1);
  assert.match(out(), /--expect-nodes=10 but the plan has 11/);
  assert.equal(await go({ confirm: true, expectEdges: 11 }), 1);
  assert.equal(rpcCalls.length, 0);
  assert.equal(await go({ confirm: true, expectNodes: 11, expectEdges: 12 }), 0);
});

test('a failing write (e.g. the migration is not applied) surfaces the error and leaves the flow as it was', async () => {
  holder.fake = createFakeSupabase({ rpc: { save_flow_graph_full: () => { throw new Error('violates check constraint "flow_nodes_node_type_check"'); } } });
  db = holder.fake.db;
  db.businesses = [{ id: BIZ, name: 'Demo Travels', business_category: 'travels' }];
  db.flow_nodes = fixture.nodes();
  db.flow_edges = fixture.edges();
  const before = snapshot();
  await assert.rejects(go({ confirm: true }), /node_type_check/);
  assert.equal(snapshot(), before);
});

test('no restore point, no write: when the snapshot cannot be saved nothing is changed', async () => {
  snapshotFails = true;
  const before = snapshot();
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /could not save a restore point \(disk full\)\. Nothing was changed\./);
  assert.equal(rpcCalls.length, 0);
  assert.equal(snapshot(), before);
});

// ── Main menu and buttons ───────────────────────────────────────────────────────────────────────

test('--menu-button is refused while the main menu is a 3-button reply (a 4th would hide Contact Us)', async () => {
  const before = snapshot();
  assert.equal(await go({ menuButton: true, confirm: true }), 1);
  assert.match(out(), /REFUSED: --menu-button: the main menu is a buttons reply with 3 buttons/);
  assert.equal(snapshot(), before);
  assert.equal(rpcCalls.length, 0);
});

test('--menu-button works once the menu is a list: a first button, existing buttons unchanged', async () => {
  db.flow_nodes.find((n) => n.id === fixture.HI).content_type = 'list';
  const before = db.flow_edges.filter((e) => e.from_node_id === fixture.HI).map((e) => e.display_order);
  const code = await go({ menuButton: true, confirm: true });
  assert.equal(code, 0, out());
  const button = db.flow_edges.find((e) => e.id === ids.E.menu);
  assert.deepEqual([button.from_node_id, button.to_node_id, button.display_order], [fixture.HI, ids.N.tripType, -1]);
  assert.deepEqual(db.flow_edges.filter((e) => e.from_node_id === fixture.HI && e.id !== ids.E.menu).map((e) => e.display_order), before);
});

test('the Rates reply with 3 buttons already would also be refused', async () => {
  for (let n = 0; n < 2; n++) db.flow_edges.push({ ...fixture.edges()[0], id: `00000000-0000-4000-8000-00000000099${n}`, from_node_id: fixture.RATES, label: `Extra ${n}`, display_order: 5 + n });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /"Our Rates" reply already has 3 buttons/);
});

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

test('a business id is required', async () => {
  assert.equal(await go({ businessId: null, confirm: true }), 1);
  assert.match(out(), /a business id is required/);
  assert.equal(rpcCalls.length, 0);
});

test('Search cab AI is refused by id (looked up fresh from businesses), before anything of it is read, with or without --confirm', async () => {
  for (const mode of ['install', 'rollback']) {
    for (const confirm of [false, true]) {
      lines.length = 0;
      assert.equal(await go({ businessId: SEARCH_CAB, mode, confirm }), 1);
      assert.match(out(), /REFUSED: this is Search cab AI/);
    }
  }
  assert.equal(rpcCalls.length, 0);
  assert.equal((db.saved || []).length, 0);
});

test('Search cab AI is found by its display name too, and by a different spelling; a similar-looking other business is not', async () => {
  db.businesses.push({ id: 'aaaa0000-0000-4000-8000-000000000001', name: 'Cab Services', display_name: 'SearchCab AI', business_category: 'travels' });
  db.businesses.push({ id: 'aaaa0000-0000-4000-8000-000000000002', name: 'Search Tours', display_name: null, business_category: 'travels' });
  const found = await installer.findProtectedBusinessIds(holder.fake);
  assert.deepEqual(found.sort(), [SEARCH_CAB, 'aaaa0000-0000-4000-8000-000000000001'].sort());
});

test('the installer names no business: another name for the same id is still refused only because the id is in the fresh lookup', async () => {
  db.businesses.find((b) => b.id === BIZ).name = 'Search cab AI';
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /this is Search cab AI/);
  assert.equal(rpcCalls.length, 0);
});

test('a business that does not exist, or is not a travels / cab business, is refused', async () => {
  assert.equal(await go({ businessId: '11111111-1111-4111-8111-111111111111', confirm: true }), 1);
  assert.match(out(), /business not found/);
  db.businesses.find((b) => b.id === BIZ).business_category = 'salon';
  lines.length = 0;
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /travels \/ cab businesses only/);
  db.businesses.find((b) => b.id === BIZ).business_category = 'cab';
  assert.equal(await go(), 0);
  assert.equal(rpcCalls.length, 0);
});

test('the travel_quotes switch off is refused', async () => {
  switchOn = false;
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /travel_quotes is not switched on/);
  assert.equal(rpcCalls.length, 0);
});

test('no active route with an active One Way fare is refused', async () => {
  oneWayRoutes = [];
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /no active route with an active One Way fare/);
  assert.equal(rpcCalls.length, 0);
});

test('no route priceable for Round Trip: refused until the owner acknowledges "Round Trip goes to my team"', async () => {
  roundTripRoutes = [];
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /no route can be priced for Round Trip/);
  assert.equal(rpcCalls.length, 0);
  lines.length = 0;
  assert.equal(await go({ confirm: true, ackRoundTripToTeam: true }), 0, out());
  assert.match(out(), /acknowledged - a Round Trip customer is handed to the owner's team/);
  assert.equal(ownNodes().length, 11);
});

test('an id derived for this business that already belongs to another business is refused', async () => {
  db.flow_nodes.push({ id: ids.N.quote, business_id: 'someone-else', node_type: 'reply', keyword: 'x' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /derived ids exists in another business/);
  assert.equal(rpcCalls.length, 0);
});

// ── Keyword ─────────────────────────────────────────────────────────────────────────────────────

const reply = (keyword, over = {}) => ({ ...fixture.nodes().find((n) => n.keyword === 'rates'), id: `00000000-0000-4000-8000-${String(Math.abs(hash(keyword + JSON.stringify(over)))).padStart(12, '0').slice(0, 12)}`, keyword, ...over });
const hash = (s) => [...s].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) | 0, 7);

test('an active reply that already answers "quote" is not taken over: refused, nothing written', async () => {
  db.flow_nodes.push(reply('quote', { match_type: 'exact' }));
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /already used by an active reply: "quote"/);
  assert.equal(rpcCalls.length, 0);
});

test('an active reply with one of the aliases as keyword, or alias, is refused too', async () => {
  db.flow_nodes.push(reply('quotation', { match_type: 'exact' }));
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /"quotation"/);
  db.flow_nodes.pop();
  db.flow_nodes.push(reply('fare-info', { hindi_aliases: ['get a quote'] }));
  lines.length = 0;
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /"get a quote"/);
});

test('a paused reply with the keyword does not block (only active replies compete)', async () => {
  db.flow_nodes.push(reply('quote', { match_type: 'exact', is_active: false }));
  assert.equal(await go({ confirm: true }), 0, out());
});

test('another keyword can be chosen; the default aliases belong to the default keyword only', async () => {
  const code = await go({ confirm: true, keyword: 'fare' });
  assert.equal(code, 0, out());
  const trigger = db.flow_nodes.find((n) => n.id === ids.N.trigger);
  assert.deepEqual([trigger.keyword, trigger.hindi_aliases, trigger.match_type, trigger.reply_kind], ['fare', [], 'exact', 'booking_trigger']);
});

test('aliases can be given for a custom keyword', async () => {
  assert.equal(await go({ confirm: true, keyword: 'fare', aliases: ['get fare', 'rate'] }), 0, out());
  assert.deepEqual(db.flow_nodes.find((n) => n.id === ids.N.trigger).hindi_aliases, ['get fare', 'rate']);
});

test('a custom keyword that an existing reply uses is refused (the existing word, not just the default)', async () => {
  assert.equal(await go({ confirm: true, keyword: 'Rates' }), 1);
  assert.match(out(), /already used by an active reply: "rates"/);
});

test('shadow check, both ways: an existing "contains" reply and the new exact keyword', async () => {
  db.flow_nodes.push(reply('quo', { match_type: 'contains' }));
  const code = await go({ confirm: true });
  assert.equal(code, 1, 'the contains reply "quo" already swallows the typed word "quote": the new exact keyword would not be what answers it');
  assert.match(out(), /✗ the "quote" keyword takes no message that an existing reply answers today/);
  assert.equal(rpcCalls.length, 0);
  db.flow_nodes.pop();
  db.flow_nodes.push(reply('ride', { match_type: 'contains' }));
  lines.length = 0;
  const code2 = await go({ confirm: true, keyword: 'book now' });
  assert.equal(code2, 0, out());
  assert.match(out(), /✓ the "book now" keyword takes no message/);
});

test('an existing quote flow of the business\'s own (not this installer\'s) is refused', async () => {
  db.flow_nodes.push({ ...fixture.nodes()[2], id: '00000000-0000-4000-8000-000000000779', node_type: 'route_picker', field_key: 'pickRoute', is_computed: true });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /already has a route picker \/ quote node that is not this installer's/);
});

test('an existing question that already uses a field key that exists only in the quote flow is refused', async () => {
  db.flow_nodes.push({ ...fixture.nodes().find((n) => n.field_key === 'tripType'), id: '00000000-0000-4000-8000-000000000778', field_key: 'passengers' });
  assert.equal(await go({ confirm: true }), 1);
  assert.match(out(), /already uses one of this flow's own field keys/);
});

// ── Rollback ────────────────────────────────────────────────────────────────────────────────────

test('--rollback dry run lists exactly the installed rows and changes nothing', async () => {
  await go({ confirm: true });
  const before = snapshot();
  lines.length = 0;
  assert.equal(await go({ mode: 'rollback' }), 0);
  assert.equal(snapshot(), before);
  assert.match(out(), /remove 11 node\(s\) and 12 edge\(s\) carrying this business's quote-flow ids/);
  assert.match(out(), /Dry run only\. Re-run with --rollback --confirm/);
});

test('--rollback --confirm removes only the installed rows: the flow is exactly what it was before installing; a restore point is kept', async () => {
  const originalNodes = JSON.stringify(db.flow_nodes);
  const originalEdges = JSON.stringify(db.flow_edges);
  await go({ confirm: true });
  cacheFlushes.length = 0;
  const code = await go({ mode: 'rollback', confirm: true });
  assert.equal(code, 0, out());
  assert.equal(JSON.stringify(db.flow_nodes), originalNodes);
  assert.equal(JSON.stringify(db.flow_edges), originalEdges);
  assert.deepEqual(cacheFlushes, [BIZ]);
  assert.equal(db.saved.length, 2);
  assert.match(db.saved[1].name, /^Before removing the quote flow — /);
  assert.equal(db.saved[1].nodes.length, 17 + 11, 'the restore point holds the flow with the quote rows (owner edits are recoverable)');
  assert.match(out(), /Own rows gone: yes\. Every other node and edge unchanged: yes/);
});

test('--rollback does not remove anything the owner added since', async () => {
  await go({ confirm: true });
  db.flow_nodes.push({ ...fixture.nodes()[2], id: '00000000-0000-4000-8000-000000000555', keyword: 'owner-added' });
  await go({ mode: 'rollback', confirm: true });
  assert.ok(db.flow_nodes.some((n) => n.id === '00000000-0000-4000-8000-000000000555'));
  assert.equal(ownNodes().length, 0);
});

test('--rollback refuses when an edge of the owner\'s now leads into the quote nodes', async () => {
  await go({ confirm: true });
  db.flow_edges.push({ id: '00000000-0000-4000-8000-000000000556', business_id: BIZ, from_node_id: fixture.CONTACT, to_node_id: ids.N.tripType, label: 'Quote', display_order: 3 });
  const before = snapshot();
  assert.equal(await go({ mode: 'rollback', confirm: true }), 1);
  assert.match(out(), /that are not the installer's connect to its nodes/);
  assert.equal(snapshot(), before);
});

test('--rollback on a flow that was never installed says so', async () => {
  assert.equal(await go({ mode: 'rollback', confirm: true }), 0);
  assert.match(out(), /Nothing to roll back/);
  assert.equal(rpcCalls.length, 0);
});

// ── Two businesses ──────────────────────────────────────────────────────────────────────────────

test('two businesses can both be installed: every id is different and neither install touches the other\'s rows', async () => {
  const B2 = '00000000-0000-4000-8000-0000000000bb';
  const remap = (id) => `bbbbbbbb${id.slice(8)}`;
  db.businesses.push({ id: B2, name: 'Second Travels', business_category: 'travels' });
  db.flow_nodes.push(...fixture.nodes().map((n) => ({ ...n, id: remap(n.id), business_id: B2 })));
  db.flow_edges.push(...fixture.edges().map((e) => ({ ...e, id: remap(e.id), from_node_id: remap(e.from_node_id), to_node_id: remap(e.to_node_id), business_id: B2 })));
  assert.equal(await go({ confirm: true }), 0, out());
  assert.equal(await go({ confirm: true, businessId: B2 }), 0, out());
  const mine = db.flow_nodes.filter((n) => n.business_id === BIZ && isOurNode(BIZ, n.id)).length;
  const theirs = db.flow_nodes.filter((n) => n.business_id === B2 && isOurNode(B2, n.id)).length;
  assert.deepEqual([mine, theirs], [11, 11]);
  assert.equal(db.flow_nodes.filter((n) => n.business_id === BIZ).length, 28);
  assert.equal(db.flow_nodes.filter((n) => n.business_id === B2).length, 28);
  // removing one leaves the other whole
  assert.equal(await go({ mode: 'rollback', confirm: true, businessId: B2 }), 0, out());
  assert.equal(db.flow_nodes.filter((n) => n.business_id === BIZ && isOurNode(BIZ, n.id)).length, 11);
  assert.equal(db.flow_nodes.filter((n) => n.business_id === B2).length, 17);
});

// ── The plan itself ─────────────────────────────────────────────────────────────────────────────

test('plan: unique derived ids; every edge joins two known nodes; copy fits WhatsApp\'s limits with hi and mr everywhere', () => {
  const anchors = installer.findAnchors(fixture.nodes(), fixture.edges());
  const plan = installer.buildPlan({ businessId: BIZ, anchors, menuButton: true });
  const all = [...plan.nodes, ...plan.edges].map((r) => r.id);
  assert.equal(new Set(all).size, all.length);
  assert.ok(plan.nodes.every((n) => isOurNode(BIZ, n.id)) && plan.edges.every((e) => isOurEdge(BIZ, e.id)));
  const known = new Set([...plan.nodes.map((n) => n.id), ...fixture.nodes().map((n) => n.id)]);
  assert.ok(plan.edges.every((e) => known.has(e.from_node_id) && known.has(e.to_node_id)));
  assert.deepEqual(installer.copyProblems(plan), []);
  for (const node of plan.nodes) {
    assert.ok(node.label_translations.hi && node.label_translations.mr, node.field_key);
    for (const o of node.options) assert.ok(o.labelTranslations.hi && o.labelTranslations.mr, `${node.field_key}/${o.value}`);
  }
});

test('plan: the copy checker really does catch an over-long button, a missing translation and too many buttons', () => {
  const anchors = installer.findAnchors(fixture.nodes(), fixture.edges());
  const plan = installer.buildPlan({ businessId: BIZ, anchors });
  plan.nodes.find((n) => n.field_key === 'tripType').options[0].label = 'A button title that is far too long';
  plan.nodes.find((n) => n.field_key === 'passengers').label_translations.mr = '';
  const problems = installer.copyProblems(plan).join('\n');
  assert.match(problems, /tripType option "One Way" \(en\).*max 20/);
  assert.match(problems, /passengers label \(mr\) is empty/);
});

test('plan: every row has the same keys (the RPC reads missing keys as null), and node types are the allowed ones', () => {
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
  const nodeKeys = JSON.stringify(Object.keys(plan.nodes[0]).sort());
  assert.ok(plan.nodes.every((n) => JSON.stringify(Object.keys(n).sort()) === nodeKeys));
  const edgeKeys = JSON.stringify(Object.keys(plan.edges[0]).sort());
  assert.ok(plan.edges.every((e) => JSON.stringify(Object.keys(e).sort()) === edgeKeys));
  assert.deepEqual([...new Set(plan.nodes.map((n) => n.node_type))].sort(), ['question', 'quote', 'reply', 'route_picker', 'vehicle_carousel']);
  assert.ok(plan.nodes.filter((n) => ['route_picker', 'quote', 'vehicle_carousel'].includes(n.node_type)).every((n) => n.is_computed && n.options.length === 0));
});

test('plan: the days are asked once, before the vehicles, for Round Trip only (the days-first order is the default)', () => {
  const plan = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
  assert.deepEqual(installer.walkPlan(plan, ids, 'One Way').path, ['tripType', 'routePicker', 'passengers', 'vehicleType', 'travelDate', 'pickupTime', 'quote']);
  assert.deepEqual(installer.walkPlan(plan, ids, 'Round Trip').path, ['tripType', 'routePicker', 'passengers', 'numberOfDays', 'vehicleType', 'travelDate', 'pickupTime', 'quote']);
  assert.deepEqual(installer.pathProblems(plan, ids), []);
  const paxToDays = plan.edges.find((e) => e.id === ids.E.paxToDays);
  const paxToVehicle = plan.edges.find((e) => e.id === ids.E.paxToVehicle);
  assert.ok(paxToDays.display_order < paxToVehicle.display_order, 'the conditional edge is tried first');
  assert.equal(paxToVehicle.condition, null);
});

test('plan: the path check catches a broken plan (a dead end, the days after the vehicles)', () => {
  const base = installer.buildPlan({ businessId: BIZ, anchors: installer.findAnchors(fixture.nodes(), fixture.edges()) });
  const without = (id) => ({ ...base, edges: base.edges.filter((e) => e.id !== id) });
  assert.match(installer.pathProblems(without(ids.E.paxToVehicle), ids).join(), /One Way: the path would not reach the quote/);
  assert.match(installer.pathProblems(without(ids.E.paxToDays), ids).join(), /Round Trip would ask the days 0 times/);
  const days = base.edges.map((e) => (e.id === ids.E.daysToVehicle ? { ...e, from_node_id: ids.N.pickupTime, to_node_id: ids.N.quote } : e));
  assert.ok(installer.pathProblems({ ...base, edges: days }, ids).length > 0);
});

test('the installer module names no business and no fixed id', () => {
  const source = require('node:fs').readFileSync(require.resolve('./quoteFlowInstaller.service'), 'utf8');
  assert.ok(!/5eed7a01|a94aec66|8440ac0a|sg\s*travels/i.test(source.replace(/\/\/.*$/gm, '')), 'no hard-coded business id or name in code');
});
