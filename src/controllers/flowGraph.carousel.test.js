// Run: node --test src/controllers/flowGraph.carousel.test.js
// Carousel reply node write path (POST/PUT /api/flow-graph/reply-nodes, POST/PUT /edges): card count and
// plan limit, media ownership/type, text limits, button parity, and the cardIndex rules of the edges.
// In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = null;
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: {
  getActiveSubscription: async () => (plan ? { status: 'active', plan } : null)
} };
const controller = require('./flowGraph.controller');
const { carouselParityError } = require('../services/carouselNode.service');

const { B1, B2, uuid, url } = h;
const M = [1, 2, 3, 4].map(n => uuid(100 + n));
const FOREIGN = uuid(120); const VIDEO = uuid(121); const DOC = uuid(122);
const TARGET = uuid(300);

const BASIC = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3, images_per_reply: 1, video_per_reply: false };
const BUSINESS = { name: 'business', display_name: 'Business', carousel_max_cards: 10, images_per_reply: 10, video_per_reply: true };

let db;
test.beforeEach(() => {
  db = h.reset();
  plan = BUSINESS;
  db.flow_nodes = [{ id: TARGET, business_id: B1, node_type: 'reply', keyword: 'target', content_type: 'text', label: 'Target' }];
  db.flow_edges = [];
  const img = (id, extra = {}) => ({ id, business_id: B1, url: url(`business-media/${id}.jpeg`), media_type: 'image', file_size_bytes: 1000, ...extra });
  db.business_media = [
    ...M.map(id => img(id)), img(FOREIGN, { business_id: B2 }), img(VIDEO, { media_type: 'video' }), img(DOC, { media_type: 'document' })
  ];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'coaching' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const card = (n, extra = {}) => ({ mediaId: M[n - 1], body: `Card ${n}`, ...extra });
const create = (over = {}) => call(controller.createReplyNode, { body: { keyword: 'rooms', contentType: 'carousel', label: 'Our rooms', carouselCards: [card(1), card(2)], ...over } });
const node = () => db.flow_nodes.find(n => n.keyword === 'rooms');

test('creates a carousel: cards are stored snake_case and the response carries them', async () => {
  const { status, body } = await create({ carouselCards: [card(1, { bodyTranslations: { hi: 'कार्ड' } }), card(2)] });
  assert.equal(status, 201);
  assert.deepEqual(node().carousel_cards, [
    { media_id: M[0], media_type: 'image', body: 'Card 1', body_translations: { hi: 'कार्ड' } },
    { media_id: M[1], media_type: 'image', body: 'Card 2', body_translations: null }
  ]);
  assert.equal(body.data.carouselCards.length, 2);
});

test('needs 2..10 cards and a message', async () => {
  assert.match((await create({ carouselCards: [card(1)] })).body.message, /at least 2 cards/);
  assert.match((await create({ carouselCards: undefined })).body.message, /at least 2 cards/);
  const eleven = Array.from({ length: 11 }, (_, i) => card((i % 4) + 1));
  assert.match((await create({ carouselCards: eleven })).body.message, /at most 10 cards/);
  const noLabel = await create({ label: '' });
  assert.equal(noLabel.status, 400);
  assert.match(noLabel.body.message, /label is required/);
  const imageOnly = await create({ label: '', mediaId: M[3] });
  assert.equal(imageOnly.status, 400);
  assert.match(imageOnly.body.message, /needs a message/);
  assert.equal(db.flow_nodes.length, 1, 'nothing created');
});

test('the plan caps the card count (403 PLAN_LIMIT_CAROUSEL_CARDS) only when the write increases it', async () => {
  plan = BASIC;
  const over = await create({ carouselCards: [card(1), card(2), card(3), card(4)] });
  assert.equal(over.status, 403);
  assert.equal(over.body.message, 'Your Basic plan allows up to 3 cards per carousel.');
  assert.deepEqual(over.body.errors, { code: 'PLAN_LIMIT_CAROUSEL_CARDS', limit: 3, plan: 'Basic' });

  // A node stored with 4 cards (downgrade) can still be edited without growing.
  db.flow_nodes.push({ id: uuid(400), business_id: B1, node_type: 'reply', keyword: 'old', content_type: 'carousel', reply_kind: 'text', label: 'Old',
    carousel_cards: M.map(id => ({ media_id: id, media_type: 'image', body: '', body_translations: null })) });
  const edit = await call(controller.updateReplyNode, { params: { id: uuid(400) }, body: { label: 'Old v2' } });
  assert.equal(edit.status, 200);
  const shrink = await call(controller.updateReplyNode, { params: { id: uuid(400) }, body: { carouselCards: [card(1), card(2), card(3)] } });
  assert.equal(shrink.status, 200);
});

test('media must be this business\'s image (or a video only on a plan that allows it)', async () => {
  const foreign = await create({ carouselCards: [card(1), { mediaId: FOREIGN }] });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.message, /Card 2: mediaId is not a media library asset of this business/);
  assert.match((await create({ carouselCards: [card(1), { mediaId: DOC }] })).body.message, /is a document, not a image/);
  assert.match((await create({ carouselCards: [card(1), { mediaId: M[1], mediaType: 'video' }] })).body.message, /is a image, not a video/);
  assert.match((await create({ carouselCards: [card(1), { mediaId: null }] })).body.message, /Card 2 needs a photo or video/);

  assert.equal((await create({ carouselCards: [card(1), { mediaId: VIDEO, mediaType: 'video' }] })).status, 201);
  db.flow_nodes = db.flow_nodes.filter(n => n.keyword !== 'rooms');
  plan = { ...BUSINESS, video_per_reply: false };
  const noVideo = await create({ carouselCards: [card(1), { mediaId: VIDEO, mediaType: 'video' }] });
  assert.equal(noVideo.status, 403);
  assert.equal(noVideo.body.errors.code, 'PLAN_LIMIT_VIDEO');
});

test('card text: 160 characters, 2 line breaks, translations too', async () => {
  assert.match((await create({ carouselCards: [card(1, { body: 'x'.repeat(161) }), card(2)] })).body.message, /Card 1 text must be 160 characters or less/);
  assert.match((await create({ carouselCards: [card(1, { body: 'a\nb\nc\nd' }), card(2)] })).body.message, /at most 2 line breaks/);
  assert.match((await create({ carouselCards: [card(1, { bodyTranslations: { hi: 'y'.repeat(161) } }), card(2)] })).body.message, /language "hi"/);
  assert.match((await create({ carouselCards: [card(1, { bodyTranslations: { zz9: 'x' } }), card(2)] })).body.message, /invalid language code/);
  assert.equal((await create({ carouselCards: [card(1, { body: 'a\nb\nc' }), card(2)] })).status, 201);
});

test('only a text-kind reply with no gallery/video can be a carousel; cards only on carousels', async () => {
  assert.match((await create({ replyKind: 'booking_trigger' })).body.message, /replyKind "text"/);
  assert.match((await create({ mediaId: M[3], galleryMediaIds: [M[2]] })).body.message, /cannot carry extra photos/);
  const plain = await create({ contentType: 'buttons' });
  assert.equal(plain.status, 400);
  assert.match(plain.body.message, /only apply to a carousel reply/);
});

test('switching a carousel to another type clears its cards; an unrelated edit leaves them alone', async () => {
  await create();
  const id = node().id;
  assert.equal((await call(controller.updateReplyNode, { params: { id }, body: { label: 'New text' } })).status, 200);
  assert.equal(node().carousel_cards.length, 2);
  assert.equal((await call(controller.updateReplyNode, { params: { id }, body: { contentType: 'buttons' } })).status, 200);
  assert.equal(node().carousel_cards, null);
});

test('echoing the stored cards back unchanged is not re-validated (cards cloned without media)', async () => {
  db.flow_nodes.push({ id: uuid(401), business_id: B1, node_type: 'reply', keyword: 'cloned', content_type: 'carousel', reply_kind: 'text', label: 'Hi',
    carousel_cards: [{ media_id: null, media_type: 'image', body: 'A', body_translations: null }, { media_id: null, media_type: 'image', body: 'B', body_translations: null }] });
  const echo = await call(controller.updateReplyNode, { params: { id: uuid(401) }, body: { carouselCards: [{ mediaId: null, body: 'A' }, { mediaId: null, body: 'B' }], label: 'Hi again' } });
  assert.equal(echo.status, 200);
  const changed = await call(controller.updateReplyNode, { params: { id: uuid(401) }, body: { carouselCards: [{ mediaId: null, body: 'A2' }, { mediaId: null, body: 'B' }] } });
  assert.equal(changed.status, 400);
  assert.match(changed.body.message, /Card 1 needs a photo or video/);
});

test('a question node cannot be a carousel', async () => {
  const { status, body } = await call(controller.createQuestionNode, { body: { fieldKey: 'x', label: 'Q?', contentType: 'carousel' } });
  assert.equal(status, 400);
  assert.doesNotMatch(body.message, /carousel/);
});

// ---- edges ----------------------------------------------------------------------------------
const makeCarousel = async () => { await create(); return node().id; };
const addEdge = (from, over = {}) => call(controller.createEdge, { body: { fromNodeId: from, toNodeId: TARGET, label: 'Book', cardIndex: 0, ...over } });

test('a carousel button needs a cardIndex inside the cards, at most 2 per card, label <= 20', async () => {
  const id = await makeCarousel();
  assert.match((await addEdge(id, { cardIndex: undefined })).body.message, /cardIndex is required/);
  assert.match((await addEdge(id, { cardIndex: 2 })).body.message, /cardIndex is required for a carousel button, from 0 to 1/);
  assert.equal((await addEdge(id)).status, 201);
  assert.equal((await addEdge(id, { label: 'Details' })).status, 201);
  const third = await addEdge(id, { label: 'Third' });
  assert.equal(third.status, 400);
  assert.match(third.body.message, /Card 1 already has 2 buttons/);
  assert.equal((await addEdge(id, { cardIndex: 1 })).status, 201);
  assert.match((await addEdge(id, { cardIndex: 1, label: 'This label is way too long' })).body.message, /20 characters/);
  assert.deepEqual(db.flow_edges.map(e => e.card_index), [0, 0, 1]);
});

test('an edge from any other node cannot carry a cardIndex', async () => {
  const { status, body } = await addEdge(TARGET, { toNodeId: TARGET });
  assert.equal(status, 400);
  assert.match(body.message, /only applies to buttons of a carousel/);
});

test('moving a button to another card keeps the 2-per-card cap', async () => {
  const id = await makeCarousel();
  await addEdge(id); await addEdge(id, { label: 'B' }); await addEdge(id, { cardIndex: 1 });
  const moving = db.flow_edges[2].id;
  const full = await call(controller.updateEdge, { params: { id: moving }, body: { cardIndex: 0 } });
  assert.equal(full.status, 400);
  const free = await call(controller.updateEdge, { params: { id: db.flow_edges[0].id }, body: { cardIndex: 1 } });
  assert.equal(free.status, 200);
  assert.equal(db.flow_edges[0].card_index, 1);
});

test('whole-carousel parity: every card the same 1 or 2 buttons, every button on a real card', () => {
  const e = (cardIndex) => ({ cardIndex });
  assert.equal(carouselParityError(2, [e(0), e(1)]), null);
  assert.equal(carouselParityError(2, [e(0), e(0), e(1), e(1)]), null);
  assert.match(carouselParityError(2, [e(0), e(0), e(1)]), /same number of buttons/);
  assert.match(carouselParityError(2, [e(0)]), /Card 2 needs at least 1 button/);
  assert.match(carouselParityError(2, [e(0), e(0), e(0), e(1)]), /Card 1 can have at most 2 buttons/);
  assert.match(carouselParityError(2, [e(0), e(5)]), /cardIndex 0 to 1/);
  assert.match(carouselParityError(2, [e(0), e(null)]), /cardIndex 0 to 1/);
});

test('carousel -> another type clears card_index on the node buttons; other nodes edges are untouched', async () => {
  const id = await makeCarousel();
  await addEdge(id); await addEdge(id, { cardIndex: 1 });
  db.flow_nodes.push({ id: uuid(310), business_id: B1, node_type: 'reply', keyword: 'menu', content_type: 'carousel', reply_kind: 'text', label: 'M', carousel_cards: [] });
  db.flow_edges.push({ id: uuid(311), business_id: B1, from_node_id: uuid(310), to_node_id: TARGET, card_index: 0 });
  const out = await call(controller.updateReplyNode, { params: { id }, body: { contentType: 'buttons' } });
  assert.equal(out.status, 200);
  assert.equal(node().carousel_cards, null);
  assert.deepEqual(db.flow_edges.filter(e => e.from_node_id === id).map(e => e.card_index), [null, null]);
  assert.equal(db.flow_edges.find(e => e.id === uuid(311)).card_index, 0);
  assert.equal(db.flow_edges.filter(e => e.from_node_id === id).length, 2, 'the buttons themselves stay');
});

test('a node staying a carousel keeps its card_index; anything -> carousel leaves existing buttons untouched (unassigned)', async () => {
  const id = await makeCarousel();
  await addEdge(id);
  await call(controller.updateReplyNode, { params: { id }, body: { label: 'New text' } });
  assert.equal(db.flow_edges[0].card_index, 0);

  db.flow_nodes.push({ id: uuid(320), business_id: B1, node_type: 'reply', keyword: 'btns', content_type: 'buttons', reply_kind: 'text', label: 'Pick' });
  db.flow_edges.push({ id: uuid(321), business_id: B1, from_node_id: uuid(320), to_node_id: TARGET, label: 'One', card_index: null });
  const out = await call(controller.updateReplyNode, { params: { id: uuid(320) }, body: { contentType: 'carousel', carouselCards: [card(1), card(2)] } });
  assert.equal(out.status, 200);
  assert.equal(db.flow_nodes.find(n => n.id === uuid(320)).content_type, 'carousel');
  const kept = db.flow_edges.find(e => e.id === uuid(321));
  assert.deepEqual([kept.card_index, kept.label, kept.to_node_id], [null, 'One', TARGET]);
});
