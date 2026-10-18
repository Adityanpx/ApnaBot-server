// Run: node --test src/services/flowGraph.carousel.test.js
// Canvas batch save (PUT /api/flow-graph/full -> saveFullGraph) with carousel nodes: carousel_cards and
// card_index travel through the save_flow_graph_full payload, are preserved when the client omits them,
// and the whole-carousel checks (button parity, cardIndex only on carousel parents) run on the end state.
// In-memory Supabase; the RPC is captured instead of run.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = null;
const subPath = require.resolve('./subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: {
  getActiveSubscription: async () => (plan ? { status: 'active', plan } : null)
} };
const { saveFullGraph } = require('./flowGraph.service');

const { B1, uuid, url } = h;
const [M1, M2] = [uuid(101), uuid(102)];
const CAR = uuid(200); const TARGET = uuid(201);
const [E1, E2] = [uuid(300), uuid(301)];
const BUSINESS = { name: 'business', display_name: 'Business', carousel_max_cards: 10, images_per_reply: 10, video_per_reply: true };

let db; let rpcCalls;
test.beforeEach(() => {
  db = h.reset();
  plan = BUSINESS;
  rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  db.business_media = [M1, M2].map(id => ({ id, business_id: B1, url: url(`business-media/${id}.jpeg`), media_type: 'image', file_size_bytes: 10 }));
  db.flow_nodes = [
    { id: TARGET, business_id: B1, node_type: 'reply', keyword: 'details', match_type: 'contains', reply_kind: 'text', content_type: 'text', label: 'Details', is_active: true, trigger_count: 0 }
  ];
  db.flow_edges = [];
});

const targetNode = { id: TARGET, keyword: 'details', label: 'Details' };
const carNode = (over = {}) => ({
  keyword: 'rooms', label: 'Our rooms', contentType: 'carousel',
  carouselCards: [{ mediaId: M1, body: 'Deluxe' }, { mediaId: M2, body: 'Suite' }], ...over
});
const save = (payload) => saveFullGraph({ businessId: B1, graphBusiness: { businessCategory: 'coaching' }, questionNodes: [], ...payload });
const rpcArgs = () => rpcCalls.find(c => c.name === 'save_flow_graph_full').args;

test('a new carousel node and its card buttons reach the RPC with carousel_cards / card_index', async () => {
  const res = await save({
    replyNodes: [targetNode, carNode({ id: 'tmp-car' })],
    edges: [
      { fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'Book', cardIndex: 0 },
      { fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'Book', cardIndex: 1 }
    ]
  });
  assert.equal(res.error, null);
  const args = rpcArgs();
  const car = args.p_node_upserts.find(n => n.keyword === 'rooms');
  assert.equal(car.content_type, 'carousel');
  assert.deepEqual(car.carousel_cards, [
    { media_id: M1, media_type: 'image', body: 'Deluxe', body_translations: null },
    { media_id: M2, media_type: 'image', body: 'Suite', body_translations: null }
  ]);
  assert.deepEqual(args.p_edge_upserts.map(e => e.card_index), [0, 1]);
  assert.equal(args.p_node_upserts.find(n => n.keyword === 'details').carousel_cards, null, 'other nodes send an explicit null');
});

test('cards with unequal buttons are refused on the end state, naming the problem', async () => {
  const res = await save({
    replyNodes: [targetNode, carNode({ id: 'tmp-car' })],
    edges: [{ fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'Book', cardIndex: 0 }]
  });
  assert.match(res.error, /Card 2 needs at least 1 button/);
  assert.equal(rpcCalls.length, 0, 'nothing written');

  const uneven = await save({
    replyNodes: [targetNode, carNode({ id: 'tmp-car' })],
    edges: [
      { fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'A', cardIndex: 0 },
      { fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'B', cardIndex: 0 },
      { fromNodeId: 'tmp-car', toNodeId: TARGET, label: 'A', cardIndex: 1 }
    ]
  });
  assert.match(uneven.error, /same number of buttons/);
});

test('a button with no / out-of-range cardIndex on a carousel is refused; cardIndex elsewhere is refused', async () => {
  const none = await save({ replyNodes: [targetNode, carNode({ id: 'c' })], edges: [{ fromNodeId: 'c', toNodeId: TARGET, label: 'A' }, { fromNodeId: 'c', toNodeId: TARGET, label: 'B', cardIndex: 1 }] });
  assert.match(none.error, /Card 1 needs at least 1 button/); // the button without a cardIndex is unassigned, not an error
  const range = await save({ replyNodes: [targetNode, carNode({ id: 'c' })], edges: [{ fromNodeId: 'c', toNodeId: TARGET, label: 'A', cardIndex: 7 }] });
  assert.match(range.error, /cardIndex must be an integer from 0 to 9|must belong to one of its 2 cards/);
  const elsewhere = await save({ replyNodes: [{ ...targetNode, contentType: 'buttons' }, { keyword: 'x', label: 'X', id: 'x' }], edges: [{ fromNodeId: TARGET, toNodeId: 'x', label: 'Go', cardIndex: 0 }] });
  assert.match(elsewhere.error, /only applies to buttons of a carousel/);
});

test('card validation runs in the batch save too: too few cards, foreign media, plan cap', async () => {
  assert.match((await save({ replyNodes: [targetNode, carNode({ carouselCards: [{ mediaId: M1 }] })], edges: [] })).error, /replyNodes\[1\]: A carousel needs at least 2 cards/);
  assert.match((await save({ replyNodes: [targetNode, carNode({ carouselCards: [{ mediaId: M1 }, { mediaId: uuid(555) }] })], edges: [] })).error, /not a media library asset of this business/);
  plan = { ...BUSINESS, carousel_max_cards: 2, display_name: 'Basic' };
  const three = await save({ replyNodes: [targetNode, carNode({ carouselCards: [{ mediaId: M1 }, { mediaId: M2 }, { mediaId: M1 }] })], edges: [] });
  assert.match(three.error, /allows up to 2 cards per carousel/);
  assert.equal(rpcCalls.length, 0);
});

test('a client that omits carouselCards / cardIndex keeps what is stored (preserve-on-omit)', async () => {
  const stored = [{ media_id: M1, media_type: 'image', body: 'Deluxe', body_translations: null }, { media_id: M2, media_type: 'image', body: 'Suite', body_translations: null }];
  db.flow_nodes.push({ id: CAR, business_id: B1, node_type: 'reply', keyword: 'rooms', match_type: 'contains', reply_kind: 'text', content_type: 'carousel', label: 'Our rooms', is_active: true, trigger_count: 3, carousel_cards: stored });
  db.flow_edges = [
    { id: E1, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Book', card_index: 0, display_order: 0 },
    { id: E2, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Book', card_index: 1, display_order: 1 }
  ];
  const res = await save({
    replyNodes: [targetNode, { id: CAR, keyword: 'rooms', label: 'Our rooms (edited)', contentType: 'carousel' }],
    edges: [
      { id: E1, fromNodeId: CAR, toNodeId: TARGET, label: 'Book now' },
      { id: E2, fromNodeId: CAR, toNodeId: TARGET, label: 'Book now' }
    ]
  });
  assert.equal(res.error, null);
  const args = rpcArgs();
  assert.deepEqual(args.p_node_upserts.find(n => n.id === CAR).carousel_cards, stored);
  assert.deepEqual(args.p_edge_upserts.map(e => [e.id, e.card_index]), [[E1, 0], [E2, 1]]);
});

test('a carousel that is exactly as stored is not re-checked, so an unfinished one never blocks an unrelated save', async () => {
  const stored = [{ media_id: null, media_type: 'image', body: 'A', body_translations: null }, { media_id: null, media_type: 'image', body: 'B', body_translations: null }];
  db.flow_nodes.push({ id: CAR, business_id: B1, node_type: 'reply', keyword: 'rooms', match_type: 'contains', reply_kind: 'text', content_type: 'carousel', label: 'Rooms', is_active: true, trigger_count: 0, carousel_cards: stored });
  db.flow_edges = [{ id: E1, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Book', card_index: 0, display_order: 0 }]; // card 2 has no button
  const res = await save({
    replyNodes: [{ ...targetNode, label: 'Details v2' }, { id: CAR, keyword: 'rooms', label: 'Rooms', contentType: 'carousel' }],
    edges: [{ id: E1, fromNodeId: CAR, toNodeId: TARGET, label: 'Book' }]
  });
  assert.equal(res.error, null);
});

test('switching a carousel to buttons in the canvas clears its cards in the same write', async () => {
  db.flow_nodes.push({ id: CAR, business_id: B1, node_type: 'reply', keyword: 'rooms', match_type: 'contains', reply_kind: 'text', content_type: 'carousel', label: 'Rooms', is_active: true, trigger_count: 0,
    carousel_cards: [{ media_id: M1, media_type: 'image', body: 'A', body_translations: null }, { media_id: M2, media_type: 'image', body: 'B', body_translations: null }] });
  const res = await save({ replyNodes: [targetNode, { id: CAR, keyword: 'rooms', label: 'Rooms', contentType: 'buttons' }], edges: [] });
  assert.equal(res.error, null);
  assert.equal(rpcArgs().p_node_upserts.find(n => n.id === CAR).carousel_cards, null);
});

test('canvas: switching a carousel to buttons nulls card_index even when the client echoes the old cardIndex (or omits it)', async () => {
  db.flow_nodes.push({ id: CAR, business_id: B1, node_type: 'reply', keyword: 'rooms', match_type: 'contains', reply_kind: 'text', content_type: 'carousel', label: 'Rooms', is_active: true, trigger_count: 0,
    carousel_cards: [{ media_id: M1, media_type: 'image', body: 'A', body_translations: null }, { media_id: M2, media_type: 'image', body: 'B', body_translations: null }] });
  db.flow_edges = [
    { id: E1, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Book', card_index: 0, display_order: 0 },
    { id: E2, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Book', card_index: 1, display_order: 1 }
  ];
  const res = await save({
    replyNodes: [targetNode, { id: CAR, keyword: 'rooms', label: 'Rooms', contentType: 'buttons' }],
    edges: [{ id: E1, fromNodeId: CAR, toNodeId: TARGET, label: 'Book', cardIndex: 0 }, { id: E2, fromNodeId: CAR, toNodeId: TARGET, label: 'Book' }]
  });
  assert.equal(res.error, null);
  assert.deepEqual(rpcArgs().p_edge_upserts.map(e => e.card_index), [null, null]);
  assert.equal(rpcArgs().p_node_upserts.find(n => n.id === CAR).carousel_cards, null);
});

test('canvas: a node that never was a carousel still cannot carry a cardIndex', async () => {
  const res = await save({
    replyNodes: [{ ...targetNode, contentType: 'buttons' }, { id: 'x', keyword: 'x', label: 'X' }],
    edges: [{ fromNodeId: TARGET, toNodeId: 'x', label: 'Go', cardIndex: 0 }]
  });
  assert.match(res.error, /only applies to buttons of a carousel/);
});

test('canvas: switching buttons -> carousel with the old buttons unassigned; parity looks only at assigned buttons', async () => {
  db.flow_nodes.push({ id: CAR, business_id: B1, node_type: 'reply', keyword: 'rooms', match_type: 'contains', reply_kind: 'text', content_type: 'buttons', label: 'Rooms', is_active: true, trigger_count: 0 });
  db.flow_edges = [{ id: E1, business_id: B1, from_node_id: CAR, to_node_id: TARGET, label: 'Old', card_index: null, display_order: 0 }];
  const edges = (extra) => [{ id: E1, fromNodeId: CAR, toNodeId: TARGET, label: 'Old' }, ...extra];
  const withCards = { id: CAR, ...carNode() };

  // cards 1 and 2 each get a button; the old unassigned one rides along untouched
  const ok = await save({ replyNodes: [targetNode, withCards], edges: edges([
    { fromNodeId: CAR, toNodeId: TARGET, label: 'A', cardIndex: 0 }, { fromNodeId: CAR, toNodeId: TARGET, label: 'B', cardIndex: 1 }
  ]) });
  assert.equal(ok.error, null);
  assert.deepEqual(rpcArgs().p_edge_upserts.map(e => [e.label, e.card_index]), [['Old', null], ['A', 0], ['B', 1]]);

  // only the unassigned button exists: the cards need buttons, the unassigned one does not count
  rpcCalls = [];
  const bad = await save({ replyNodes: [targetNode, withCards], edges: edges([]) });
  assert.match(bad.error, /Card 1 needs at least 1 button/);
  assert.equal(rpcCalls.length, 0);
});
