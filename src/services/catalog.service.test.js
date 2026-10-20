// Run: node --test src/services/catalog.service.test.js
// Catalogue settings: first save creates the bot node, keyword clashes (409 + replace in one go), the
// main-menu row and its MENU_FULL / NO_MENU_NODE statuses, the order action's node check, healing a
// node that was wiped, share link and insights. In-memory Supabase; upsert_catalog_node is modelled in
// memory exactly as the SQL function does it.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 };
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('./subscription.service', { getActiveSubscription: async () => (plan ? { status: 'active', plan } : null) });
let unicodeOn = false;
stub('./unicodeMatching.service', { isUnicodeMatchingEnabled: async () => unicodeOn });
const catalog = require('./catalog.service');

const { B1, B2, uuid } = h;
const HI = uuid(10); const OLD = uuid(11); const FAQ = uuid(12); const BOOK = uuid(13);

let db; let nextId; let rpcLog;
const installRpc = () => {
  h.state.fake.rpc = async (name, args) => {
    rpcLog.push(name);
    if (name === 'catalog_insights') {
      const rows = {};
      for (const e of db.catalog_events || []) {
        if (e.business_id !== args.p_business_id || e.created_at < args.p_since) continue;
        const key = `${e.collection_id}|${e.event}`;
        rows[key] = rows[key] || { collection_id: e.collection_id, event: e.event, total: 0, customers: 0 };
        rows[key].total += 1; rows[key].customers += 1;
      }
      return { data: Object.values(rows), error: null };
    }
    assert.equal(name, 'upsert_catalog_node');
    const biz = args.p_business_id; const n = args.p_node;
    let node = db.flow_nodes.find(x => x.business_id === biz && x.content_type === 'catalog');
    const created = !node;
    const fields = { keyword: n.keyword, match_type: 'contains', hindi_aliases: n.hindi_aliases, label: n.label, label_translations: n.label_translations || null, is_active: true };
    if (created) {
      node = { id: uuid(nextId++), business_id: biz, node_type: 'reply', reply_kind: 'text', content_type: 'catalog', position_x: n.position_x, position_y: n.position_y, ...fields };
      db.flow_nodes.push(node);
    } else Object.assign(node, fields);
    const replaced = [];
    for (const id of args.p_replace_ids || []) {
      const old = db.flow_nodes.find(x => x.id === id && x.business_id === biz && x.node_type === 'reply' && x.content_type !== 'catalog');
      if (!old) continue;
      old.is_active = false;
      db.flow_edges = db.flow_edges.filter(e => !(e.to_node_id === old.id && db.flow_edges.some(x => x.from_node_id === e.from_node_id && x.to_node_id === node.id)));
      let moved = 0;
      for (const e of db.flow_edges) if (e.to_node_id === old.id && e.from_node_id !== node.id) { e.to_node_id = node.id; moved += 1; }
      replaced.push({ id: old.id, keyword: old.keyword, label: old.label, retargetedEdges: moved });
    }
    return { data: { nodeId: node.id, created, replaced }, error: null };
  };
};

const replyNode = (id, keyword, over = {}) => ({
  id, business_id: B1, node_type: 'reply', keyword, match_type: 'contains', hindi_aliases: [], reply_kind: 'text',
  content_type: 'text', label: `Reply for ${keyword}`, is_active: true, position_x: 0, position_y: 0, ...over
});

test.beforeEach(() => {
  db = h.reset(); nextId = 900; rpcLog = []; plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 }; unicodeOn = false;
  db.flow_nodes = []; db.flow_edges = []; db.catalogs = []; db.catalog_collections = []; db.catalog_events = [];
  db.businesses = [{ id: B1, name: 'Shambhu Menswear', display_name: 'Shambhu', whatsapp_number: '919800000001' }];
  installRpc();
});

const put = (patch, opts) => catalog.updateSettings(B1, patch, opts);
const catalogNodes = () => db.flow_nodes.filter(n => n.content_type === 'catalog');

test('GET before any save: nothing exists, defaults are returned, no node is created', async () => {
  const view = await catalog.loadCatalogView(B1);
  assert.equal(view.exists, false);
  assert.equal(view.node, null);
  assert.deepEqual([view.settings.enabled, view.settings.keywords], [false, ['catalogue']]);
  assert.equal(view.defaults.viewButtonLabel, 'View designs');
  assert.equal(catalogNodes().length, 0);
  assert.equal(db.catalogs.length, 0);
});

test('first PUT creates the catalogs row and ONE catalogue node that mirrors keywords / aliases / text', async () => {
  const res = await put({ enabled: true, keywords: ['catalogue', 'products'], aliases: ['collection'], text: 'Our sarees', textTranslations: { hi: 'namaste' } });
  assert.equal(res.error, undefined);
  assert.equal(db.catalogs.length, 1);
  assert.equal(db.catalogs[0].settings.enabled, true);
  const [node] = catalogNodes();
  assert.deepEqual([node.keyword, node.hindi_aliases, node.label, node.label_translations, node.is_active, node.match_type],
    ['catalogue', ['products', 'collection'], 'Our sarees', { hi: 'namaste' }, true, 'contains']);
  assert.equal(res.view.node.id, node.id);
  assert.deepEqual(h.state.invalidated, [B1, B1].slice(0, h.state.invalidated.length));
  assert.ok(h.state.invalidated.length >= 1, 'rules cache invalidated');

  await put({ photosPerPage: 4 });
  assert.equal(catalogNodes().length, 1, 'a second save re-uses the node');
  assert.equal(db.catalogs[0].settings.photosPerPage, 4);
  assert.equal(db.catalogs[0].settings.enabled, true, 'a partial PUT keeps the other settings');
});

test('validation errors come back as 400 and nothing is written', async () => {
  const res = await put({ keywords: ['menu'] });
  assert.equal(res.error.status, 400);
  assert.match(res.error.message, /already used/);
  assert.equal(db.catalogs.length, 0);
  assert.equal(catalogNodes().length, 0);
  assert.equal((await put({ photosPerPage: 99 })).error.status, 400);
});

test('a keyword used by another active reply is a 409 KEYWORD_EXISTS naming the node(s); nothing is written', async () => {
  db.flow_nodes.push(replyNode(OLD, 'catalogue', { content_type: 'carousel', label: 'Our old catalogue carousel' }));
  db.flow_nodes.push(replyNode(FAQ, 'faq', { hindi_aliases: ['products'] }));
  const res = await put({ enabled: true, keywords: ['catalogue', 'products'] });
  assert.equal(res.error.status, 409);
  assert.equal(res.error.errors.code, 'KEYWORD_EXISTS');
  assert.deepEqual(res.error.errors.keywords.sort(), ['catalogue', 'products']);
  assert.deepEqual(res.error.errors.nodes.map(n => [n.id, n.keyword, n.label, n.contentType, n.matchedWords]).sort(),
    [[FAQ, 'faq', 'Reply for faq', 'text', ['products']], [OLD, 'catalogue', 'Our old catalogue carousel', 'carousel', ['catalogue']]].sort());
  assert.equal(db.catalogs.length, 0);
  assert.equal(catalogNodes().length, 0);
  assert.equal(rpcLog.length, 0);
});

test('an inactive reply with the keyword, or another business\'s, is no clash', async () => {
  db.flow_nodes.push(replyNode(OLD, 'catalogue', { is_active: false }));
  db.flow_nodes.push(replyNode(FAQ, 'catalogue', { business_id: B2 }));
  const res = await put({ enabled: true });
  assert.equal(res.error, undefined);
});

test('replaceKeywordNodes: clashing nodes are deactivated (not deleted), their incoming buttons now open the catalogue', async () => {
  db.flow_nodes.push(replyNode(HI, 'hi', { content_type: 'list' }));
  db.flow_nodes.push(replyNode(OLD, 'catalogue', { content_type: 'carousel' }));
  db.flow_edges.push(
    { id: uuid(50), business_id: B1, from_node_id: HI, to_node_id: OLD, label: 'Catalogue', display_order: 0 },
    { id: uuid(51), business_id: B1, from_node_id: OLD, to_node_id: HI, label: 'Back', display_order: 0 }
  );
  const res = await put({ enabled: true }, { replaceKeywordNodes: true });
  assert.equal(res.error, undefined);
  const [node] = catalogNodes();
  const old = db.flow_nodes.find(n => n.id === OLD);
  assert.equal(old.is_active, false, 'deactivated, not deleted');
  assert.equal(db.flow_edges.find(e => e.id === uuid(50)).to_node_id, node.id, 'incoming button retargeted');
  assert.equal(db.flow_edges.find(e => e.id === uuid(51)).to_node_id, HI, 'its own outgoing edge untouched');
  assert.deepEqual(res.view.replaced, [{ id: OLD, keyword: 'catalogue', label: 'Reply for catalogue', retargetedEdges: 1 }]);
  assert.equal(node.is_active, true);
});

test('replace is only applied to the clashing nodes, and replaceKeywordNodes without a clash replaces nothing', async () => {
  db.flow_nodes.push(replyNode(OLD, 'something-else'));
  const res = await put({ enabled: true }, { replaceKeywordNodes: true });
  assert.deepEqual(res.view.replaced, []);
  assert.equal(db.flow_nodes.find(n => n.id === OLD).is_active, true);
});

test('main menu: the row is added to the hi LIST node when it has room, and removed when switched off or disabled', async () => {
  db.flow_nodes.push(replyNode(HI, 'hi', { content_type: 'list' }));
  db.flow_edges.push({ id: uuid(60), business_id: B1, from_node_id: HI, to_node_id: BOOK, label: 'Book', display_order: 0 });
  const on = await put({ enabled: true, addToMainMenu: true });
  assert.equal(on.view.menu.status, 'ADDED');
  const [node] = catalogNodes();
  const row = db.flow_edges.find(e => e.to_node_id === node.id);
  assert.deepEqual([row.from_node_id, row.display_order], [HI, 1]);
  assert.match(row.label, /Catalogue/);
  assert.ok(row.label_translations && row.label_translations.hi, 'built-in Hindi / Marathi labels');

  assert.equal((await put({ menuLabel: 'Shop' })).view.menu.status, 'IN_MENU');
  assert.equal(db.flow_edges.find(e => e.to_node_id === node.id).label, 'Shop');
  assert.equal(db.flow_edges.filter(e => e.to_node_id === node.id).length, 1, 'never a second row');

  assert.equal((await put({ enabled: false })).view.menu.status, 'REMOVED');
  assert.equal(db.flow_edges.some(e => e.to_node_id === node.id), false);
  assert.equal((await put({ enabled: true })).view.menu.status, 'ADDED', 'back in the menu when enabled again');
  assert.equal((await put({ addToMainMenu: false })).view.menu.status, 'REMOVED');
});

test('main menu: MENU_FULL for 3 buttons / 10 rows (nothing converted), NO_MENU_NODE without a hi node', async () => {
  db.flow_nodes.push(replyNode(HI, 'hi', { content_type: 'buttons' }));
  for (let i = 0; i < 3; i++) db.flow_edges.push({ id: uuid(70 + i), business_id: B1, from_node_id: HI, to_node_id: BOOK, label: `B${i}`, display_order: i });
  const full = await put({ enabled: true, addToMainMenu: true });
  assert.equal(full.error, undefined, 'the settings are still saved');
  assert.equal(full.view.menu.status, 'MENU_FULL');
  assert.equal(db.flow_edges.length, 3);
  assert.equal(db.flow_nodes.find(n => n.id === HI).content_type, 'buttons');

  db.flow_nodes = db.flow_nodes.filter(n => n.id !== HI);
  assert.equal((await put({ photosPerPage: 5 })).view.menu.status, 'NO_MENU_NODE');

  db.flow_nodes.push(replyNode(HI, 'hi', { content_type: 'list' }));
  db.flow_edges = [];
  for (let i = 0; i < 10; i++) db.flow_edges.push({ id: uuid(80 + i), business_id: B1, from_node_id: HI, to_node_id: BOOK, label: `R${i}`, display_order: i });
  assert.equal((await put({ photosPerPage: 6 })).view.menu.status, 'MENU_FULL');
});

test('order action: a booking_trigger / web_form_trigger must be a reply node of this business with that reply kind', async () => {
  db.flow_nodes.push(replyNode(BOOK, 'book', { reply_kind: 'booking_trigger' }));
  db.flow_nodes.push(replyNode(FAQ, 'form', { reply_kind: 'web_form_trigger', business_id: B2 }));
  assert.equal((await put({ enabled: true, orderAction: { type: 'booking_trigger', nodeId: BOOK } })).error, undefined);
  assert.match((await put({ orderAction: { type: 'web_form_trigger', nodeId: BOOK } })).error.message, /web_form_trigger reply node/);
  assert.equal((await put({ orderAction: { type: 'web_form_trigger', nodeId: FAQ } })).error.status, 400, 'another business\'s node');
  assert.equal((await put({ orderAction: { type: 'message', text: 'Thanks' } })).error, undefined);
});

test('GET re-creates a catalogue node that a snapshot restore / template import removed, and re-adds the menu row', async () => {
  db.flow_nodes.push(replyNode(HI, 'hi', { content_type: 'list' }));
  await put({ enabled: true, addToMainMenu: true });
  db.flow_nodes = db.flow_nodes.filter(n => n.content_type !== 'catalog');
  db.flow_edges = [];
  const view = await catalog.loadCatalogView(B1);
  assert.equal(catalogNodes().length, 1);
  assert.equal(view.node.keyword, 'catalogue');
  assert.equal(view.menu.status, 'ADDED');
});

test('GET re-projects a node whose keyword drifted from the settings', async () => {
  await put({ enabled: true, keywords: ['catalogue'] });
  catalogNodes()[0].keyword = 'stale';
  await catalog.loadCatalogView(B1);
  assert.equal(catalogNodes()[0].keyword, 'catalogue');
});

test('healAfterGraphReplace restores the node, but never takes over a word the restored flow now uses', async () => {
  await put({ enabled: true });
  db.flow_nodes = [];
  await catalog.healAfterGraphReplace(B1);
  assert.equal(catalogNodes().length, 1);

  db.flow_nodes = [replyNode(OLD, 'catalogue')];
  await catalog.healAfterGraphReplace(B1);
  assert.equal(catalogNodes().length, 0, 'left alone: the owner is asked on the Catalogue page');
  assert.equal(db.flow_nodes[0].is_active, true);
  await catalog.healAfterGraphReplace(uuid(999)); // a business with no catalogue: nothing happens, no throw
});

test('plan info: carousel cap, active / shown / hidden collection counts', async () => {
  plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 3 };
  for (let i = 0; i < 5; i++) db.catalog_collections.push({ id: uuid(100 + i), business_id: B1, title: `C${i}`, is_active: i !== 4, sort_order: i });
  const view = await catalog.loadCatalogView(B1);
  assert.deepEqual(view.plan, { name: 'Basic', carouselMaxCards: 3, planKnown: true });
  assert.deepEqual(view.counts, { total: 5, active: 4, shownInCarousel: 3, hiddenByPlan: 1 });
  assert.equal(view.limits.maxItemsPerCollection, 100);
});

test('a native-script keyword warns while Unicode matching is off for the business', async () => {
  const hindi = 'कैटलॉग';
  const off = await put({ enabled: true, aliases: [hindi] });
  assert.deepEqual(off.view.warnings.map(w => w.code), ['NATIVE_KEYWORD_NEEDS_UNICODE_MATCHING']);
  unicodeOn = true;
  assert.deepEqual((await catalog.loadCatalogView(B1)).warnings, []);
});

test('share info: wa.me link with the first keyword prefilled; no number -> reason', async () => {
  await put({ enabled: true, keywords: ['shop', 'catalogue'] });
  const share = await catalog.getShareInfo(B1);
  assert.equal(share.keyword, 'shop');
  assert.equal(share.waLink, 'https://wa.me/919800000001?text=shop');
  assert.equal(share.whatsappNumber, '919800000001');
  assert.equal(share.catalogueEnabled, true);
  db.businesses[0].whatsapp_number = null;
  const none = await catalog.getShareInfo(B1);
  assert.deepEqual([none.waLink, none.reason, none.whatsappNumber], [null, 'WHATSAPP_NOT_CONNECTED', null]);
});

test('insights: totals and per-collection counts for 7 or 30 days, orders = collection + item orders', async () => {
  const C1 = uuid(201); const C2 = uuid(202);
  db.catalog_collections.push({ id: C1, business_id: B1, title: 'Silk' }, { id: C2, business_id: B1, title: 'Cotton' });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 20 * 86400000).toISOString();
  const ev = (event, collection_id, created_at = now, business_id = B1) => db.catalog_events.push({ business_id, event, collection_id, created_at });
  ev('catalogue_open', null); ev('collection_view', C1); ev('collection_view', C2); ev('designs_view', C1); ev('designs_more', C1);
  ev('order_collection', C1); ev('order_item', C1); ev('order_item', C2); ev('designs_view', C2, old); ev('designs_view', C2, now, B2);
  const week = (await catalog.getInsights(B1, 7)).insights;
  assert.deepEqual(week.totals, { catalogueOpens: 1, collectionViews: 2, designsViews: 1, designsMore: 1, collectionOrders: 1, itemOrders: 2, orders: 3 });
  assert.deepEqual(week.collections.map(c => [c.title, c.orders, c.designsViews]), [['Silk', 2, 1], ['Cotton', 1, 0]]);
  const month = (await catalog.getInsights(B1, 30)).insights;
  assert.equal(month.totals.designsViews, 2, 'the 20-day-old event is in the 30-day window only');
  assert.equal((await catalog.getInsights(B1, 14)).error.status, 400);
});
