// Run: node --test src/services/carouselBundle.service.test.js
// POST /api/flow-graph/carousel-bundle: validation, plan limits, keyword generation/clash, canvas positions,
// the response shape and the all-or-nothing contract. In-memory Supabase (storage test harness); the
// create_carousel_bundle RPC is modelled in memory (insert + rollback on failure), so the real
// transaction is verified by supabase/verification/verify_carousel_bundle.sql instead.
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
const supabase = require('../config/supabase');
const controller = require('../controllers/flowGraph.controller');
const { createCarouselBundle, slugOf, H_SPACING, V_SPACING } = require('./carouselBundle.service');

const { B1, B2, uuid, url, state } = h;
const M = [1, 2, 3, 4, 5, 6].map(n => uuid(100 + n));
const FOREIGN = uuid(120); const VIDEO = uuid(121);
const EXISTING_TEXT = uuid(300); const EXISTING_BOOKING = uuid(301); const QNODE = uuid(302); const OTHER_BIZ_NODE = uuid(303);

const BASIC = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3, images_per_reply: 1, video_per_reply: false };
const BUSINESS = { name: 'business', display_name: 'Business', carousel_max_cards: 10, images_per_reply: 10, video_per_reply: true };

let db; let rpcCalls; let failRpc;
test.beforeEach(() => {
  db = h.reset();
  plan = BUSINESS; rpcCalls = 0; failRpc = null;
  db.flow_nodes = [
    { id: EXISTING_TEXT, business_id: B1, node_type: 'reply', keyword: 'fees', content_type: 'text', label: 'Fees', position_x: 100, position_y: 0 },
    { id: EXISTING_BOOKING, business_id: B1, node_type: 'reply', keyword: 'order', reply_kind: 'booking_trigger', content_type: 'text', label: 'Start', position_x: 900, position_y: 50 },
    { id: QNODE, business_id: B1, node_type: 'question', field_key: 'name', content_type: 'text', label: 'Name?', position_x: 2000 },
    { id: OTHER_BIZ_NODE, business_id: B2, node_type: 'reply', keyword: 'other', content_type: 'text', label: 'Other', position_x: 5000 }
  ];
  db.flow_edges = [];
  const img = (id, extra = {}) => ({ id, business_id: B1, url: url(`business-media/${id}.jpeg`), media_type: 'image', file_size_bytes: 1000, ...extra });
  db.business_media = [...M.map(id => img(id)), img(FOREIGN, { business_id: B2 }), img(VIDEO, { media_type: 'video' })];

  // In-memory create_carousel_bundle: keyword/target checks like the function, then insert; a failure
  // (failRpc) rolls back everything it inserted, which is what a plpgsql transaction does.
  supabase.rpc = async (name, args) => {
    if (name !== 'create_carousel_bundle') return { data: null, error: { message: `unexpected rpc ${name}` } };
    rpcCalls += 1;
    const before = { nodes: [...db.flow_nodes], edges: [...db.flow_edges] };
    try {
      for (const n of args.p_nodes) {
        if (db.flow_nodes.some(x => x.business_id === args.p_business_id && x.node_type === 'reply' && x.keyword === n.keyword)) {
          return { data: null, error: { message: 'bundle_keyword_exists', details: n.keyword } };
        }
      }
      args.p_nodes.forEach((n, i) => {
        db.flow_nodes.push({ business_id: args.p_business_id, node_type: 'reply', reply_kind: 'text', trigger_count: 0, is_active: true, ...n });
        if (failRpc === `after-node-${i}`) throw new Error('boom');
      });
      args.p_edges.forEach((e, i) => {
        db.flow_edges.push({ business_id: args.p_business_id, ...e });
        if (failRpc === `after-edge-${i}`) throw new Error('boom');
      });
      return { data: null, error: null };
    } catch (err) {
      db.flow_nodes = before.nodes; db.flow_edges = before.edges;
      return { data: null, error: { message: err.message } };
    }
  };
});

const card = (n, extra = {}) => ({ mediaId: M[n - 1], mediaType: 'image', body: `Red Kurta ${n}`, ...extra });
const textBtn = (label = 'Details', text = 'Here are the details') => ({ label, action: { type: 'text', text } });
const bundle = (over = {}) => ({
  keyword: 'catalogue', matchType: 'exact', text: 'Our catalogue', buttonsPerCard: 1,
  cards: [card(1, { buttons: [textBtn()] }), card(2, { buttons: [textBtn()] })], ...over
});
const run = (body) => createCarouselBundle({ businessId: B1, body });
const expectError = async (body, status, pattern) => {
  const out = await run(body);
  assert.equal(out.error?.status, status, JSON.stringify(out));
  if (pattern) assert.match(out.error.message, pattern);
  return out.error;
};
const untouched = () => {
  assert.equal(rpcCalls, 0, 'rpc must not be called');
  assert.equal(db.flow_nodes.length, 4);
  assert.equal(db.flow_edges.length, 0);
  assert.deepEqual(state.invalidated, []);
};

test('happy path: gallery + text + existing buttons, two per card', async () => {
  const body = bundle({
    hindiAliases: ['  कैटलॉग '], textTranslations: { hi: 'हमारा कैटलॉग' }, buttonsPerCard: 2,
    cards: [
      card(1, { bodyTranslations: { hi: 'लाल कुर्ता' }, buttons: [
        { label: 'See photos', labelTranslations: { hi: 'फोटो' }, action: { type: 'gallery', photoMediaIds: [M[2], M[3], M[4]], text: 'Photos of kurta', textTranslations: { hi: 'कुर्ता' } } },
        { label: 'Order now', action: { type: 'existing', nodeId: EXISTING_BOOKING } }
      ] }),
      card(2, { buttons: [
        { label: 'Price', action: { type: 'text', text: 'Rs 999' } },
        { label: 'Fees', action: { type: 'existing', nodeId: EXISTING_TEXT } }
      ] })
    ]
  });
  const out = await run(body);
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  const { carouselNodeId, nodes, edges } = out.data;

  // 1 carousel + 1 gallery + 1 text; the two 'existing' buttons create no node.
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].id, carouselNodeId);
  const carousel = nodes[0];
  assert.equal(carousel.contentType, 'carousel');
  assert.equal(carousel.keyword, 'catalogue');
  assert.equal(carousel.matchType, 'exact');
  assert.deepEqual(carousel.hindiAliases, ['कैटलॉग']);
  assert.equal(carousel.label, 'Our catalogue');
  assert.deepEqual(carousel.labelTranslations, { hi: 'हमारा कैटलॉग' });
  assert.deepEqual(carousel.carouselCards, [
    { media_id: M[0], media_type: 'image', body: 'Red Kurta 1', body_translations: { hi: 'लाल कुर्ता' } },
    { media_id: M[1], media_type: 'image', body: 'Red Kurta 2', body_translations: null }
  ]);

  const gallery = nodes[1];
  assert.equal(gallery.keyword, 'catalogue-red-kurta-1-1');
  assert.equal(gallery.matchType, 'exact');
  assert.equal(gallery.mediaId, M[2]);
  assert.equal(gallery.imageUrl, url(`business-media/${M[2]}.jpeg`));
  assert.deepEqual(gallery.galleryMediaIds, [M[3], M[4]]);
  assert.deepEqual(gallery.labelTranslations, { hi: 'कुर्ता' });
  const text = nodes[2];
  assert.equal(text.keyword, 'catalogue-red-kurta-2-2');
  assert.equal(text.mediaId, null);
  assert.deepEqual(text.galleryMediaIds, []);

  assert.equal(edges.length, 4);
  assert.deepEqual(edges.map(e => [e.cardIndex, e.label, e.toNodeId]), [
    [0, 'See photos', gallery.id], [0, 'Order now', EXISTING_BOOKING],
    [1, 'Price', text.id], [1, 'Fees', EXISTING_TEXT]
  ]);
  assert.ok(edges.every(e => e.fromNodeId === carouselNodeId));
  assert.deepEqual(edges.map(e => e.displayOrder), [0, 1, 2, 3]);
  assert.deepEqual(edges[0].labelTranslations, { hi: 'फोटो' });

  assert.equal(rpcCalls, 1);
  assert.deepEqual(state.invalidated, [B1], 'rules cache invalidated exactly once');
});

test('response nodes/edges have the same shape as GET /full', async () => {
  const { data } = await run(bundle());
  const res = {};
  const resObj = { status: (c) => { res.status = c; return resObj; }, json: (p) => { res.body = p; return resObj; } };
  await controller.getFullGraph({ user: { businessId: B1 } }, resObj, (e) => { throw e; });
  const full = res.body.data;
  for (const node of data.nodes) assert.deepEqual(node, full.replyNodes.find(n => n.id === node.id));
  for (const edge of data.edges) assert.deepEqual(edge, full.edges.find(e => e.id === edge.id));
});

test('controller answers 201 with the data and maps errors', async () => {
  const call = async (body) => {
    const out = {};
    const res = { status: (c) => { out.status = c; return res; }, json: (p) => { out.body = p; return res; } };
    await controller.createCarouselBundle({ body, user: { businessId: B1 } }, res, (e) => { throw e; });
    return out;
  };
  const ok = await call(bundle());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.success, true);
  assert.ok(ok.body.data.carouselNodeId);
  const clash = await call(bundle());
  assert.equal(clash.status, 409);
  assert.equal(clash.body.success, false);
  assert.equal(clash.body.errors.code, 'KEYWORD_EXISTS');
});

test('keyword clash with an existing reply node is a 409 and writes nothing', async () => {
  const err = await expectError(bundle({ keyword: '  FEES ' }), 409, /"fees" already exists/);
  assert.equal(err.errors.code, 'KEYWORD_EXISTS');
  untouched();
});

test('a keyword used only by another business is fine', async () => {
  const out = await run(bundle({ keyword: 'other' }));
  assert.equal(out.error, undefined);
});

test('generated keywords: slug of the card text, running counter, skipping taken ones', async () => {
  db.flow_nodes.push({ id: uuid(400), business_id: B1, node_type: 'reply', keyword: 'catalogue-red-kurta-1-1', content_type: 'text', label: 'x', position_x: 0 });
  const { data } = await run(bundle({
    cards: [card(1, { body: '', buttons: [textBtn()] }), card(2, { body: 'साड़ी', buttons: [textBtn()] })]
  }));
  assert.deepEqual(data.nodes.slice(1).map(n => n.keyword), ['catalogue-card1-1', 'catalogue-card2-2']);
  assert.equal(slugOf('Red Kurta & Co. Special Edition'), 'red-kurta-co');
  const second = await run(bundle({ keyword: 'catalogue2', cards: [card(1, { body: 'Red Kurta 1', buttons: [textBtn()] }), card(2, { buttons: [textBtn()] })] }));
  assert.equal(second.data.nodes[1].keyword, 'catalogue2-red-kurta-1-1');
});

test('canvas: carousel right of the graph (or at position), targets in a non-overlapping column', async () => {
  const { data } = await run(bundle({ buttonsPerCard: 2, cards: [
    card(1, { buttons: [textBtn('A'), textBtn('B')] }), card(2, { buttons: [textBtn('C'), textBtn('D')] })
  ] }));
  const [carousel, ...targets] = data.nodes;
  assert.equal(carousel.positionX, 2000 + H_SPACING, 'right of the max x of ALL this business nodes (other business ignored)');
  assert.equal(carousel.positionY, 0);
  assert.equal(targets.length, 4);
  targets.forEach((t, i) => {
    assert.equal(t.positionX, carousel.positionX + H_SPACING);
    assert.equal(t.positionY, carousel.positionY + i * V_SPACING);
  });
  const spots = data.nodes.map(n => `${n.positionX},${n.positionY}`);
  assert.equal(new Set(spots).size, spots.length);

  const placed = await run(bundle({ keyword: 'placed', position: { x: 10, y: 20 } }));
  assert.deepEqual([placed.data.nodes[0].positionX, placed.data.nodes[0].positionY], [10, 20]);
  assert.deepEqual([placed.data.nodes[1].positionX, placed.data.nodes[1].positionY], [10 + H_SPACING, 20]);

  db.flow_nodes = [];
  const empty = await run(bundle({ keyword: 'first' }));
  assert.equal(empty.data.nodes[0].positionX, 0);
});

test('top-level validation', async () => {
  await expectError(bundle({ keyword: '' }), 400, /keyword is required/);
  await expectError(bundle({ matchType: 'regex' }), 400, /matchType/);
  await expectError(bundle({ hindiAliases: 'x' }), 400, /hindiAliases/);
  await expectError(bundle({ text: '  ' }), 400, /needs a message/);
  await expectError(bundle({ text: 'x'.repeat(1025) }), 400, /1024 characters/);
  await expectError(bundle({ textTranslations: { zz: 'x' } }), 400, /invalid language code/);
  await expectError(bundle({ buttonsPerCard: 3 }), 400, /buttonsPerCard must be 1 or 2/);
  await expectError(bundle({ position: { x: 'a', y: 1 } }), 400, /position/);
  await expectError(bundle({ cards: 'no' }), 400, /cards must be an array/);
  await expectError(null, 400, /body must be an object/);
  untouched();
});

test('card rules: 2..plan max cards, text and media', async () => {
  const btn = [textBtn()];
  await expectError(bundle({ cards: [card(1, { buttons: btn })] }), 400, /at least 2 cards/);
  plan = BASIC;
  const four = [1, 2, 3, 4].map(n => card(n, { buttons: btn }));
  const err = await expectError(bundle({ cards: four }), 403, /Basic plan allows up to 3 cards/);
  assert.equal(err.errors.code, 'PLAN_LIMIT_CAROUSEL_CARDS');
  plan = BUSINESS;
  await expectError(bundle({ cards: [card(1, { body: 'x'.repeat(161), buttons: btn }), card(2, { buttons: btn })] }), 400, /160 characters/);
  await expectError(bundle({ cards: [card(1, { body: 'a\nb\nc\nd', buttons: btn }), card(2, { buttons: btn })] }), 400, /line breaks/);
  await expectError(bundle({ cards: [card(1, { mediaId: FOREIGN, buttons: btn }), card(2, { buttons: btn })] }), 400, /not a media library asset of this business/);
  await expectError(bundle({ cards: [card(1, { mediaId: VIDEO, buttons: btn }), card(2, { buttons: btn })] }), 400, /is a video, not a image/);
  await expectError(bundle({ cards: [card(1, { mediaId: undefined, buttons: btn }), card(2, { buttons: btn })] }), 400, /needs a photo or video/);
  untouched();
});

test('video cards need a plan that allows video', async () => {
  const btn = [textBtn()];
  const cards = [card(1, { buttons: btn }), card(2, { mediaId: VIDEO, mediaType: 'video', buttons: btn })];
  plan = { ...BUSINESS, video_per_reply: false };
  const err = await expectError(bundle({ cards }), 403, /Video cards are not available/);
  assert.equal(err.errors.code, 'PLAN_LIMIT_VIDEO');
  untouched();
  plan = BUSINESS;
  assert.equal((await run(bundle({ cards }))).error, undefined);
});

test('buttons: same count on every card, label limits, action shape', async () => {
  await expectError(bundle({ cards: [card(1, { buttons: [textBtn()] }), card(2, { buttons: [textBtn(), textBtn('B')] })] }), 400, /Card 2 needs exactly 1 button/);
  await expectError(bundle({ cards: [card(1), card(2)] }), 400, /Card 1 needs exactly 1 button/);
  await expectError(bundle({ cards: [card(1, { buttons: [textBtn('x'.repeat(21))] }), card(2, { buttons: [textBtn()] })] }), 400, /20 characters/);
  await expectError(bundle({ cards: [card(1, { buttons: [textBtn('  ')] }), card(2, { buttons: [textBtn()] })] }), 400, /label is required/);
  await expectError(bundle({ cards: [card(1, { buttons: [{ label: 'a', action: { type: 'call' } }] }), card(2, { buttons: [textBtn()] })] }), 400, /action\.type must be one of/);
  await expectError(bundle({ cards: [card(1, { buttons: [{ label: 'a', action: { type: 'text', text: ' ' } }] }), card(2, { buttons: [textBtn()] })] }), 400, /action\.text is required/);
  await expectError(bundle({ cards: [card(1, { buttons: [{ label: 'a', action: { type: 'gallery', photoMediaIds: [], text: 't' } }] }), card(2, { buttons: [textBtn()] })] }), 400, /at least 1 photo/);
  await expectError(bundle({ cards: [card(1, { buttons: [{ label: 'a', labelTranslations: { hi: 'x'.repeat(21) }, action: { type: 'text', text: 't' } }] }), card(2, { buttons: [textBtn()] })] }), 400, /20 characters/);
  untouched();
});

test('gallery targets: photos belong to the business, are images, and respect the plan photo limit', async () => {
  const gal = (ids) => bundle({ cards: [card(1, { buttons: [{ label: 'a', action: { type: 'gallery', photoMediaIds: ids, text: 't' } }] }), card(2, { buttons: [textBtn()] })] });
  await expectError(gal([FOREIGN]), 400, /not a media library asset/);
  await expectError(gal([VIDEO]), 400, /video asset; only photos/);
  await expectError(gal([M[2], FOREIGN]), 400, /not a media library asset/);
  await expectError(gal([M[2], M[2]]), 400, /more than once/);
  plan = { ...BUSINESS, images_per_reply: 2 };
  const err = await expectError(gal([M[2], M[3], M[4]]), 403, /allows up to 2 photos per reply/);
  assert.equal(err.errors.code, 'PLAN_LIMIT_PHOTOS');
  untouched();
  plan = BASIC;
  assert.equal((await run(gal([M[2]]))).error, undefined, 'one photo fits the Basic plan');
});

test("'existing' targets must be reply nodes of this business", async () => {
  const to = (nodeId) => bundle({ cards: [card(1, { buttons: [{ label: 'a', action: { type: 'existing', nodeId } }] }), card(2, { buttons: [textBtn()] })] });
  await expectError(to('nope'), 400, /must be a reply node id/);
  await expectError(to(QNODE), 400, /not a reply node of this business/);
  await expectError(to(OTHER_BIZ_NODE), 400, /not a reply node of this business/);
  await expectError(to(uuid(999)), 400, /not a reply node of this business/);
  untouched();
  const ok = await run(to(EXISTING_BOOKING));
  assert.equal(ok.error, undefined);
  assert.equal(ok.data.edges[0].toNodeId, EXISTING_BOOKING);
  assert.equal(ok.data.nodes.length, 2, 'only the carousel and the text node of card 2');
});

test('atomic: a failure mid-way creates nothing, invalidates nothing, and surfaces as an error', async () => {
  for (const point of ['after-node-0', 'after-node-1', 'after-edge-0', 'after-edge-1']) {
    failRpc = point;
    await assert.rejects(run(bundle()), (err) => err.message === 'boom');
    assert.equal(db.flow_nodes.length, 4, `${point}: no node left behind`);
    assert.equal(db.flow_edges.length, 0, `${point}: no edge left behind`);
    assert.deepEqual(state.invalidated, [], `${point}: cache untouched`);
  }
  failRpc = null;
  assert.equal((await run(bundle())).error, undefined, 'the same bundle succeeds once the failure is gone');
});

test('a keyword clash raised inside the function (lost race) is a 409, nothing created', async () => {
  const realRpc = supabase.rpc;
  supabase.rpc = async () => ({ data: null, error: { message: 'bundle_keyword_exists', details: 'catalogue' } });
  const err = await expectError(bundle(), 409, /just created/);
  assert.equal(err.errors.keyword, 'catalogue');
  assert.deepEqual(state.invalidated, []);
  supabase.rpc = realRpc;
});
