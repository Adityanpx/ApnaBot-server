// Run: node --test src/controllers/flowGraph.activeKeywords.test.js
// Only ACTIVE replies compete for a keyword (the bot's rules cache loads active nodes only). The Catalogue's
// "Replace" deactivates - never deletes - the older reply that used the catalogue's keyword, so a business can
// legitimately hold an active and a paused reply with the same word; the canvas save and the single-node
// create / edit must not trip over that, while two ACTIVE replies with one keyword stay refused - including
// when a paused one is switched back on. In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };
const controller = require('./flowGraph.controller');
const { saveFullGraph } = require('../services/flowGraph.service');

const { B1, uuid } = h;
const HI = uuid(300); const CAT = uuid(301); const OLD = uuid(302); const SHIRTS = uuid(303);
const E_HI_CAT = uuid(400); const E_OLD_SHIRTS = uuid(401);

let db; let rpcCalls;
test.beforeEach(() => {
  db = h.reset(); rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  // The shape the Catalogue's "Replace" leaves (SG Travels): the active Catalogue reply, and the older carousel reply with
  // the same keyword, paused, still holding its buttons.
  db.flow_nodes = [
    { id: HI, business_id: B1, node_type: 'reply', keyword: 'hi', match_type: 'exact', content_type: 'buttons', reply_kind: 'text', label: 'Welcome', is_active: true, trigger_count: 0 },
    { id: CAT, business_id: B1, node_type: 'reply', keyword: 'catalogue', match_type: 'contains', hindi_aliases: [], content_type: 'catalog', reply_kind: 'text', label: 'Here is our catalogue', is_active: true, trigger_count: 1 },
    { id: OLD, business_id: B1, node_type: 'reply', keyword: 'catalogue', match_type: 'exact', hindi_aliases: [], content_type: 'text', reply_kind: 'text', label: 'Our new collection', is_active: false, trigger_count: 2 },
    { id: SHIRTS, business_id: B1, node_type: 'reply', keyword: 'shirt-designs', match_type: 'contains', content_type: 'text', reply_kind: 'text', label: 'Shirts', is_active: true, trigger_count: 0 }
  ];
  db.flow_edges = [
    { id: E_HI_CAT, business_id: B1, from_node_id: HI, to_node_id: CAT, label: 'Catalogue', display_order: 0 },
    { id: E_OLD_SHIRTS, business_id: B1, from_node_id: OLD, to_node_id: SHIRTS, label: 'View designs', display_order: 0 }
  ];
});

const save = (payload) => saveFullGraph({ businessId: B1, graphBusiness: { businessCategory: 'travels' }, questionNodes: [], ...payload });
const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'travels' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const node = (id) => db.flow_nodes.find((n) => n.id === id);

// What the canvas sends: every reply node as GET /full returned it.
const echo = (over = {}) => ({
  replyNodes: db.flow_nodes.map((n) => ({
    id: n.id, keyword: n.keyword, matchType: n.match_type, contentType: n.content_type, replyKind: n.reply_kind, label: n.label,
    hindiAliases: n.hindi_aliases || [], isActive: n.is_active, ...(over[n.id] || {})
  })),
  edges: db.flow_edges.map((e) => ({ id: e.id, fromNodeId: e.from_node_id, toNodeId: e.to_node_id, label: e.label }))
});
const items = (...list) => ({ replyNodes: list, edges: [] });

// ── Canvas batch save ───────────────────────────────────────────────────────────────────────────

test('(c) the Catalogue-replace shape - an active catalogue reply and a paused carousel reply with the same keyword - saves', async () => {
  const result = await save(echo());
  assert.equal(result.error, null);
  const upserts = rpcCalls[0].args.p_node_upserts;
  assert.deepEqual(upserts.filter((n) => n.keyword === 'catalogue').map((n) => [n.id, n.is_active]).sort(), [[CAT, true], [OLD, false]].sort());
  assert.deepEqual(rpcCalls[0].args.p_node_deletes, []);
});

test('(a) an active and a paused reply with the same keyword save, in either order', async () => {
  db.flow_nodes = []; db.flow_edges = [];
  const a = { keyword: 'offers', label: 'A', isActive: true };
  const b = { keyword: 'offers', label: 'B', isActive: false };
  assert.equal((await save(items(a, b))).error, null);
  assert.equal((await save(items(b, a))).error, null);
});

test('two paused replies with one keyword save too (neither is matched)', async () => {
  db.flow_nodes = []; db.flow_edges = [];
  assert.equal((await save(items({ keyword: 'offers', label: 'A', isActive: false }, { keyword: 'offers', label: 'B', isActive: false }))).error, null);
});

test('(b) two ACTIVE replies with one keyword are still refused - case and spacing ignored, isActive omitted counts as active', async () => {
  const both = await save(items({ keyword: 'offers', label: 'A', isActive: true }, { keyword: 'offers', label: 'B', isActive: true }));
  assert.match(both.error, /replyNodes\[1\]: duplicate keyword "offers" among active replyNodes in this save/);
  const omitted = await save(items({ keyword: 'offers', label: 'A' }, { keyword: ' Offers ', label: 'B' }));
  assert.match(omitted.error, /duplicate keyword "offers"/);
  assert.equal(rpcCalls.length, 0, 'nothing is written');
});

test('(b) switching the paused carousel reply back on in the canvas, while the Catalogue reply is active, is refused', async () => {
  const result = await save(echo({ [OLD]: { isActive: true } }));
  assert.match(result.error, /duplicate keyword "catalogue" among active replyNodes/);
  assert.equal(rpcCalls.length, 0);
});

test('a paused Catalogue reply does not hold its keyword: the other reply may be active', async () => {
  node(CAT).is_active = false;
  const result = await save(echo({ [OLD]: { isActive: true } }));
  assert.equal(result.error, null);
});

test('the Catalogue reply\'s keyword still counts against a NEW active reply in the same save', async () => {
  const result = await save({ ...echo(), replyNodes: [...echo().replyNodes, { keyword: 'catalogue', label: 'mine', isActive: true }] });
  assert.match(result.error, /duplicate keyword "catalogue"/);
});

// ── Single-node create ──────────────────────────────────────────────────────────────────────────

test('create: a keyword held only by a paused reply is free', async () => {
  const out = await call(controller.createReplyNode, { body: { keyword: 'Shirt-Designs ', label: 'x' } });
  assert.equal(out.status, 409, 'an ACTIVE reply holds it');
  node(SHIRTS).is_active = false;
  const again = await call(controller.createReplyNode, { body: { keyword: 'shirt-designs', label: 'x' } });
  assert.equal(again.status, 201);
  assert.equal(db.flow_nodes.filter((n) => n.keyword === 'shirt-designs' && n.is_active).length, 1);
});

test('create: the same word as the Catalogue reply (active) is refused as before', async () => {
  const out = await call(controller.createReplyNode, { body: { keyword: 'catalogue', label: 'x' } });
  assert.equal(out.status, 409);
  assert.equal(out.body.message, 'A reply node with this keyword already exists.');
});

test('create: a business that already has two active replies on a word gets a 409, not a 500', async () => {
  db.flow_nodes.push({ id: uuid(310), business_id: B1, node_type: 'reply', keyword: 'dup', content_type: 'text', reply_kind: 'text', label: 'a', is_active: true });
  db.flow_nodes.push({ id: uuid(311), business_id: B1, node_type: 'reply', keyword: 'dup', content_type: 'text', reply_kind: 'text', label: 'b', is_active: true });
  assert.equal((await call(controller.createReplyNode, { body: { keyword: 'dup', label: 'x' } })).status, 409);
});

// ── Single-node edit ────────────────────────────────────────────────────────────────────────────

test('edit: renaming an active reply to a word only a paused reply holds works; to an active reply\'s word is refused', async () => {
  const taken = await call(controller.updateReplyNode, { params: { id: SHIRTS }, body: { keyword: 'hi' } });
  assert.equal(taken.status, 409);
  const free = await call(controller.updateReplyNode, { params: { id: SHIRTS }, body: { keyword: 'catalogue-old-word' } });
  assert.equal(free.status, 200);
  db.flow_nodes.push({ id: uuid(312), business_id: B1, node_type: 'reply', keyword: 'sale', content_type: 'text', reply_kind: 'text', label: 'paused sale', is_active: false });
  const toPausedWord = await call(controller.updateReplyNode, { params: { id: SHIRTS }, body: { keyword: 'sale' } });
  assert.equal(toPausedWord.status, 200);
  assert.equal(node(SHIRTS).keyword, 'sale');
});

test('edit: the owner\'s fix for the SG Travels case - renaming the paused carousel reply - works either way', async () => {
  const out = await call(controller.updateReplyNode, { params: { id: OLD }, body: { keyword: 'catalogue-old' } });
  assert.equal(out.status, 200);
  assert.equal(node(OLD).keyword, 'catalogue-old');
  assert.equal(node(OLD).is_active, false);
});

test('edit: renaming a PAUSED reply to an active reply\'s word is allowed (nothing matches it) but cannot then be switched on', async () => {
  const rename = await call(controller.updateReplyNode, { params: { id: OLD }, body: { keyword: 'hi' } });
  assert.equal(rename.status, 200);
  const on = await call(controller.toggleReplyNode, { params: { id: OLD } });
  assert.equal(on.status, 409);
  assert.equal(node(OLD).is_active, false);
});

test('edit: the keyword sent unchanged for an active reply is fine; for a paused reply being switched on it is a clash', async () => {
  assert.equal((await call(controller.updateReplyNode, { params: { id: SHIRTS }, body: { keyword: 'shirt-designs', label: 'new' } })).status, 200);
  const on = await call(controller.updateReplyNode, { params: { id: OLD }, body: { keyword: 'catalogue', isActive: true } });
  assert.equal(on.status, 409);
  assert.equal(node(OLD).is_active, false);
});

// ── Re-activation ───────────────────────────────────────────────────────────────────────────────

test('re-activating the paused reply while the other is active is refused (toggle and edit), with a clear message', async () => {
  const toggle = await call(controller.toggleReplyNode, { params: { id: OLD } });
  assert.equal(toggle.status, 409);
  assert.equal(toggle.body.message, 'Another active reply already uses this keyword. Rename one of them first.');
  const edit = await call(controller.updateReplyNode, { params: { id: OLD }, body: { isActive: true } });
  assert.equal(edit.status, 409);
  assert.equal(node(OLD).is_active, false, 'still paused');
});

test('it can be switched on once the other is off (or has another word); switching OFF is always allowed', async () => {
  node(SHIRTS).keyword = 'catalogue';
  assert.equal((await call(controller.toggleReplyNode, { params: { id: SHIRTS } })).status, 200, 'off');
  assert.equal(node(SHIRTS).is_active, false);
  node(CAT).is_active = false;
  const on = await call(controller.toggleReplyNode, { params: { id: OLD } });
  assert.equal(on.status, 200);
  assert.equal(node(OLD).is_active, true);
});

test('toggle of a reply nobody else shares is unchanged', async () => {
  node(SHIRTS).is_active = false;
  assert.equal((await call(controller.toggleReplyNode, { params: { id: SHIRTS } })).status, 200);
  assert.equal(node(SHIRTS).is_active, true);
});
