// Run: node --test src/controllers/catalog.controller.test.js
// The Catalogue endpoints' HTTP contract: status codes, the response envelope, the 409 KEYWORD_EXISTS body,
// replaceKeywordNodes, plan / item limit errors. In-memory Supabase (storage harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3 };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../services/subscription.service', { getActiveSubscription: async () => ({ status: 'active', plan }) });
stub('../services/unicodeMatching.service', { isUnicodeMatchingEnabled: async () => false });
const controller = require('./catalog.controller');

const { B1, uuid, url } = h;
const OLD = uuid(11); const HI = uuid(10);
let db; let nextId;
const installRpc = () => {
  h.state.fake.rpc = async (name, args) => {
    if (name === 'catalog_insights') return { data: [], error: null };
    const n = args.p_node;
    let node = db.flow_nodes.find(x => x.business_id === B1 && x.content_type === 'catalog');
    const fields = { keyword: n.keyword, match_type: 'contains', hindi_aliases: n.hindi_aliases, label: n.label, label_translations: n.label_translations || null, is_active: true };
    if (!node) { node = { id: uuid(nextId++), business_id: B1, node_type: 'reply', reply_kind: 'text', content_type: 'catalog', ...fields }; db.flow_nodes.push(node); } else Object.assign(node, fields);
    const replaced = [];
    for (const id of args.p_replace_ids || []) {
      const old = db.flow_nodes.find(x => x.id === id);
      if (!old) continue;
      old.is_active = false;
      let moved = 0;
      for (const e of db.flow_edges) if (e.to_node_id === old.id) { e.to_node_id = node.id; moved += 1; }
      replaced.push({ id: old.id, keyword: old.keyword, label: old.label, retargetedEdges: moved });
    }
    return { data: { nodeId: node.id, created: true, replaced }, error: null };
  };
};

test.beforeEach(() => {
  db = h.reset(); nextId = 900; plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3 };
  db.flow_nodes = [
    { id: HI, business_id: B1, node_type: 'reply', keyword: 'hi', content_type: 'list', label: 'Welcome', is_active: true },
    { id: OLD, business_id: B1, node_type: 'reply', keyword: 'catalogue', content_type: 'carousel', label: 'Old catalogue', is_active: true }
  ];
  db.flow_edges = [{ id: uuid(50), business_id: B1, from_node_id: HI, to_node_id: OLD, label: 'Catalogue', display_order: 0 }];
  db.catalogs = []; db.catalog_collections = []; db.catalog_items = []; db.catalog_events = [];
  db.businesses = [{ id: B1, name: 'Shambhu', whatsapp_number: '919800000001' }];
  db.business_media = [1, 2].map(n => ({ id: uuid(400 + n), business_id: B1, url: url(`m${n}.jpg`), media_type: 'image', file_size_bytes: 10 }));
  installRpc();
});

const call = async (handler, req = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params: {}, query: {}, body: {}, user: { businessId: B1 }, ...req }, res, (err) => { throw err; });
  return out;
};

test('GET /api/catalog before any save: 200 envelope with exists false and the defaults', async () => {
  const out = await call(controller.getCatalog);
  assert.equal(out.status, 200);
  assert.deepEqual([out.body.success, out.body.errors], [true, null]);
  assert.deepEqual([out.body.data.exists, out.body.data.node, out.body.data.settings.keywords], [false, null, ['catalogue']]);
});

test('PUT /api/catalog: a clashing keyword is a 409 whose body names the node(s) so the app can ask "Replace your old catalogue reply?"', async () => {
  const out = await call(controller.updateCatalog, { body: { enabled: true } });
  assert.equal(out.status, 409);
  assert.deepEqual(out.body, {
    success: false,
    message: '"catalogue" is already used by another reply. Replace it, or pick a different word.',
    data: null,
    errors: {
      code: 'KEYWORD_EXISTS',
      keywords: ['catalogue'],
      nodes: [{ id: OLD, keyword: 'catalogue', label: 'Old catalogue', contentType: 'carousel', replyKind: undefined, matchedWords: ['catalogue'] }]
    }
  });
  assert.equal(db.catalogs.length, 0);
});

test('PUT /api/catalog with replaceKeywordNodes: true replaces the old reply in one go and lists what it did', async () => {
  const out = await call(controller.updateCatalog, { body: { enabled: true, addToMainMenu: true, replaceKeywordNodes: true } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.data.replaced, [{ id: OLD, keyword: 'catalogue', label: 'Old catalogue', retargetedEdges: 1 }]);
  assert.equal(db.flow_nodes.find(n => n.id === OLD).is_active, false);
  assert.equal(db.flow_nodes.some(n => n.id === OLD), true, 'never deleted');
  assert.equal(db.catalogs[0].settings.replaceKeywordNodes, undefined, 'the flag is not a setting');
  assert.equal(out.body.data.node.keyword, 'catalogue');
  assert.equal(out.body.data.menu.requested, true);
});

test('PUT /api/catalog: invalid values are 400, replaceKeywordNodes must be a boolean, the body must be an object', async () => {
  assert.equal((await call(controller.updateCatalog, { body: { photosPerPage: 50 } })).status, 400);
  assert.match((await call(controller.updateCatalog, { body: { replaceKeywordNodes: 'yes' } })).body.message, /replaceKeywordNodes/);
  assert.equal((await call(controller.updateCatalog, { body: [] })).status, 400);
  assert.equal((await call(controller.updateCatalog, { body: { orderAction: { type: 'booking_trigger', nodeId: uuid(999) } } })).status, 400);
});

test('collections: 201 on create, the plan cap is a 403 with errors.code, delete reports unused photos', async () => {
  db.flow_nodes = []; db.flow_edges = [];
  for (const title of ['A', 'B', 'C']) {
    const out = await call(controller.createCollection, { body: { title, coverMediaId: title === 'A' ? uuid(401) : undefined } });
    assert.equal(out.status, 201);
    assert.equal(out.body.data.collection.title, title);
  }
  const over = await call(controller.createCollection, { body: { title: 'D' } });
  assert.equal(over.status, 403);
  assert.deepEqual(over.body.errors, { code: 'PLAN_LIMIT_CATALOG_COLLECTIONS', limit: 3, plan: 'Basic' });
  const list = await call(controller.listCollections);
  assert.deepEqual(list.body.data.collections.map(c => c.title), ['A', 'B', 'C']);
  const first = list.body.data.collections[0];
  const del = await call(controller.deleteCollection, { params: { id: first.id } });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.data.orphanedMedia.map(o => o.mediaId), [uuid(401)]);
  assert.equal((await call(controller.getCollection, { params: { id: first.id } })).status, 404);
});

test('items: 201 on create, 400 CATALOG_ITEM_LIMIT with limit / current / room, 404 for an unknown collection', async () => {
  db.flow_nodes = [];
  const c = (await call(controller.createCollection, { body: { title: 'A' } })).body.data.collection;
  const created = await call(controller.createItems, { params: { id: c.id }, body: { items: [{ mediaId: uuid(401), designNo: 'A-1', priceText: '999' }] } });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.items[0].imageUrl, url('m1.jpg'));
  for (let i = 0; i < 99; i++) db.catalog_items.push({ id: uuid(3000 + i), collection_id: c.id, business_id: B1, media_id: uuid(401), sort_order: 10 + i });
  const over = await call(controller.createItems, { params: { id: c.id }, body: { items: [{ mediaId: uuid(401) }] } });
  assert.deepEqual([over.status, over.body.errors], [400, { code: 'CATALOG_ITEM_LIMIT', limit: 100, current: 100, room: 0 }]);
  assert.equal((await call(controller.createItems, { params: { id: uuid(999) }, body: { items: [{ mediaId: uuid(401) }] } })).status, 404);
  assert.equal((await call(controller.createItems, { params: { id: c.id }, body: {} })).status, 400);
});

test('insights: days defaults to 7, only 7 or 30 are accepted; share returns the wa.me link', async () => {
  const week = await call(controller.getInsights);
  assert.equal(week.status, 200);
  assert.equal(week.body.data.insights.days, 7);
  assert.equal((await call(controller.getInsights, { query: { days: '30' } })).body.data.insights.days, 30);
  assert.equal((await call(controller.getInsights, { query: { days: '14' } })).status, 400);
  const share = await call(controller.getShare);
  assert.deepEqual([share.body.data.keyword, share.body.data.waLink], ['catalogue', 'https://wa.me/919800000001?text=catalogue']);
});
