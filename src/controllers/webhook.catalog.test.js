// Run: node --test src/controllers/webhook.catalog.test.js
// The Catalogue as a customer sees it, through the real webhook + catalogReply.service: the carousel of
// collections (plan cap, translations, native / fallback), View designs paging with "Show more", the
// order_button photo style, Order (message / booking_trigger with prefill / web_form_trigger with prefill),
// empty / disabled / switched-off, stale taps, mid-booking taps, one usage unit per reply, insight events,
// and that an ordinary reply is untouched. In-memory Supabase, everything else stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NODE = id(1); const C1 = id(11); const C2 = id(12); const C3 = id(13); const BOOK = id(30); const FORM = id(31);

let fake; let db; let events; let usage; let plan; let matchNode; let startArgs; let activeSession; let lastTime;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test' });
stub('../config/supabase', { from: (t) => fake.from(t), rpc: (n, a) => fake.rpc(n, a) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { events.push({ kind: 'queue', job }); },
  addToWhatsappQueueAndWait: async (job) => { events.push({ kind: 'wait', job }); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan, businessCategory: 'menswear',
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Shambhu', businessName: 'Shambhu'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => { usage.push('outbound'); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en', 'hi'], name: 'Shambhu' }) });
stub('../services/booking.service', {
  getBookingSession: async () => activeSession, deleteBookingSession: async () => {}, saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  startGraphSession: async (...args) => {
    startArgs = args;
    return { session: { currentNodeId: 'q1' }, result: { nodeId: 'q1', fieldType: 'text', label: 'Your name?', options: [] } };
  },
  getCurrentNodeField: async () => ({ nodeId: 'q1', fieldType: 'text', label: 'Your name?', options: [] })
});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => (matchNode && text === matchNode.keyword ? { node: matchNode, edges: [] } : null),
  resolveTappedEdge: async () => null,
  resolveCarouselTap: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');

const deliver = async (message) => {
  const body = {
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, ...message }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, { status() { return this; }, json() {} });
};
const say = (text) => deliver({ type: 'text', text: { body: text } });
const tap = (tapId) => deliver({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: tapId, title: 'x' } } });
const tapAsButton = (payload) => deliver({ type: 'button', button: { payload, text: 'x' } });

const PRO = { msg_limit: -1, carousel_max_cards: 10 };
const BASIC = { msg_limit: -1, carousel_max_cards: 3 };
const settings = (over = {}) => ({ enabled: true, keywords: ['catalogue'], photosPerPage: 10, photoStyle: 'plain', orderAction: { type: 'message', text: null, textTranslations: null }, ...over });
const collection = (n, over = {}) => ({
  id: id(10 + n), business_id: BIZ, title: `Collection ${n}`, title_translations: null, body: `Body ${n}`, body_translations: null,
  price_label: 'From 499', price_label_translations: null, cover_media_id: id(100 + n), sort_order: n, is_active: true, created_at: `2026-01-01T00:00:0${n}Z`, ...over
});
const addItems = (collectionId, count, startIndex = 0) => {
  for (let i = 0; i < count; i++) {
    const n = startIndex + i;
    db.business_media.push({ id: id(500 + n), business_id: BIZ, url: `https://r2.test/photo${n}.jpg`, media_type: 'image' });
    db.catalog_items.push({
      id: id(600 + n), collection_id: collectionId, business_id: BIZ, media_id: id(500 + n), design_no: `D-${n}`, price_text: `${n}00`,
      caption: i === 0 ? 'Soft cotton' : null, caption_translations: null, sort_order: n, created_at: `2026-01-02T00:00:${String(n).padStart(2, '0')}Z`
    });
  }
};

test.beforeEach(() => {
  fake = createFakeSupabase();
  db = fake.db; events = []; usage = []; plan = PRO; startArgs = null; activeSession = null; lastTime = 0;
  db.customers = [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }];
  db.messages = [];
  db.catalogs = [{ id: 'cat1', business_id: BIZ, settings: settings() }];
  db.catalog_collections = [collection(1), collection(2), collection(3)];
  db.catalog_items = [];
  db.catalog_events = [];
  db.business_media = [1, 2, 3, 4].map(n => ({ id: id(100 + n), business_id: BIZ, url: `https://r2.test/cover${n}.jpg`, media_type: 'image' }));
  db.flow_nodes = [
    { id: NODE, business_id: BIZ, node_type: 'reply', content_type: 'catalog', keyword: 'catalogue' },
    { id: BOOK, business_id: BIZ, node_type: 'reply', content_type: 'text', reply_kind: 'booking_trigger', keyword: 'order', label: 'Let me take your order' },
    { id: FORM, business_id: BIZ, node_type: 'reply', content_type: 'text', reply_kind: 'web_form_trigger', keyword: 'form', label: 'Fill the order form', button_text: 'Open form' }
  ];
  db.category_features = []; db.business_features = []; db.booking_form_tokens = [];
  matchNode = { id: NODE, nodeType: 'reply', contentType: 'catalog', replyKind: 'text', keyword: 'catalogue', isActive: true, label: 'x' };
  void lastTime;
});

const jobs = () => events.map(e => e.job);
const outbound = () => db.messages.filter(m => m.direction === 'outbound');
const buttonsOf = (job) => (job.buttons || []).map(b => [b.nextKeyword, b.title]);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('typing the keyword sends ONE native carousel of the active collections, buttons View designs + Order', async () => {
  await say('catalogue');
  assert.equal(events.length, 1);
  const job = jobs()[0];
  assert.deepEqual([job.type, job.carouselNative, job.imageUrl, job.message], ['carousel', true, null, 'Here is our catalogue 👇']);
  assert.deepEqual(job.carouselCards.map(c => [c.mediaUrl, c.text]), [
    ['https://r2.test/cover1.jpg', '*Collection 1*\nBody 1\nFrom 499'],
    ['https://r2.test/cover2.jpg', '*Collection 2*\nBody 2\nFrom 499'],
    ['https://r2.test/cover3.jpg', '*Collection 3*\nBody 3\nFrom 499']
  ]);
  assert.deepEqual(job.carouselCards.map(c => c.buttons.map(b => b.title)), [['View designs', 'Order'], ['View designs', 'Order'], ['View designs', 'Order']]);
  assert.deepEqual(job.carouselCards[1].buttons.map(b => b.nextKeyword), [`cat:${C2}:p:0`, `cat:${C2}:order`]);
  assert.equal(outbound().length, 1);
  assert.equal(outbound()[0].interactive_payload.kind, 'carousel');
  assert.equal(outbound()[0].triggered_rule_id, NODE);
  assert.deepEqual(usage, []);
  await flush();
  assert.deepEqual(db.catalog_events.map(e => [e.event, e.collection_id]),
    [['catalogue_open', null], ['collection_view', C1], ['collection_view', C2], ['collection_view', C3]]);
});

test('the carousel shows only the plan\'s carousel_max_cards collections, in sort order, skipping inactive ones', async () => {
  plan = BASIC;
  db.catalog_collections = [collection(1), collection(2, { is_active: false }), collection(3), collection(4)];
  db.catalog_collections.push(collection(5, { id: id(15), cover_media_id: id(101), sort_order: 5 }));
  await say('catalogue');
  assert.deepEqual(jobs()[0].carouselCards.map(c => c.text.split('\n')[0]), ['*Collection 1*', '*Collection 3*', '*Collection 4*']);
});

test('with no order action every card has just View designs', async () => {
  db.catalogs[0].settings = settings({ orderAction: null });
  await say('catalogue');
  assert.deepEqual(jobs()[0].carouselCards.map(c => c.buttons.length), [1, 1, 1]);
});

test('one collection, or no cover photos: the worker\'s one-message-per-card fallback is requested (carouselNative false)', async () => {
  db.catalog_collections = [collection(1)];
  await say('catalogue');
  assert.equal(jobs()[0].carouselNative, false);
  assert.equal(jobs()[0].carouselCards.length, 1);
});

test('a collection without a cover uses its first photo', async () => {
  db.catalog_collections = [collection(1, { cover_media_id: null }), collection(2)];
  addItems(C1, 2);
  await say('catalogue');
  assert.equal(jobs()[0].carouselCards[0].mediaUrl, 'https://r2.test/photo0.jpg');
  assert.equal(jobs()[0].carouselNative, true);
});

test('customer language: titles, card text, labels and the message come in Hindi where translated, English otherwise', async () => {
  db.customers[0].preferred_language = 'hi';
  db.catalog_collections = [
    collection(1, { title_translations: { hi: 'HI-1' }, price_label_translations: { hi: 'HI-price' } }),
    collection(2)
  ];
  db.catalogs[0].settings = settings({ text: 'Our catalogue', textTranslations: { hi: 'HI-text' }, viewButtonLabel: 'View', viewButtonLabelTranslations: { hi: 'HI-view' } });
  await say('catalogue');
  const job = jobs()[0];
  assert.equal(job.message, 'HI-text');
  assert.equal(job.carouselCards[0].text, '*HI-1*\nBody 1\nHI-price');
  assert.equal(job.carouselCards[1].text, '*Collection 2*\nBody 2\nFrom 499');
  assert.equal(job.carouselCards[0].buttons[0].title, 'HI-view');
  assert.equal(job.carouselCards[0].buttons[1].title, 'ऑर्डर करें', 'built-in Hindi default for the Order label');
});

test('View designs: the first page is photosPerPage photos in order (caption "design no · price · caption"), then Show more / Order / Catalogue, ONE usage unit', async () => {
  addItems(C1, 25);
  db.catalogs[0].settings = settings({ photosPerPage: 10 });
  await tap(`cat:${C1}:p:0`);
  const sent = jobs();
  assert.equal(sent.length, 11);
  assert.ok(events.every(e => e.kind === 'wait'), 'awaited one by one, so they arrive in order');
  assert.deepEqual(sent.slice(0, 10).map(j => j.imageUrl), Array.from({ length: 10 }, (_, i) => `https://r2.test/photo${i}.jpg`));
  assert.equal(sent[0].message, 'D-0 · 000 · Soft cotton'.replace('000', '000'));
  assert.equal(sent[1].message, 'D-1 · 100');
  const controls = sent[10];
  assert.equal(controls.message, 'Showing 1–10 of 25 designs in Collection 1');
  assert.deepEqual(buttonsOf(controls), [[`cat:${C1}:p:1`, 'Show more designs'], [`cat:${C1}:order`, 'Order'], ['cat:menu', '🛍️ Catalogue']]);
  assert.deepEqual(usage, [], 'counted by the queue worker, not by the webhook');
  // What the worker will record for this page: each job counts its countAs (default 1) - 10 photos + the buttons message = 1
  assert.equal(sent.reduce((total, j) => total + (j.countAs === undefined ? 1 : j.countAs), 0), 1, 'a 10-photo page records exactly 1 unit');
  assert.deepEqual(sent.slice(0, 10).map(j => j.countAs), Array(10).fill(0));
  assert.equal(controls.countAs, undefined);
  assert.equal(outbound().length, 11);
  assert.equal(outbound()[0].type, 'image');
  assert.equal(outbound()[0].media_url, 'https://r2.test/photo0.jpg');
  await flush();
  assert.deepEqual(db.catalog_events.map(e => e.event), ['designs_view']);
});

test('Show more: the next page; the last page has no Show more button and ends on Order / Catalogue', async () => {
  addItems(C1, 25);
  await tap(`cat:${C1}:p:2`);
  const sent = jobs();
  assert.equal(sent.length, 6, '5 photos + the buttons');
  assert.equal(sent[0].imageUrl, 'https://r2.test/photo20.jpg');
  assert.equal(sent[5].message, 'Showing 21–25 of 25 designs in Collection 1');
  assert.deepEqual(buttonsOf(sent[5]).map(b => b[1]), ['Order', '🛍️ Catalogue']);
  assert.deepEqual(usage, []);
  await flush();
  assert.deepEqual(db.catalog_events.map(e => e.event), ['designs_more']);
});

test('a page number past the end shows the last page; photosPerPage is respected', async () => {
  addItems(C1, 7);
  db.catalogs[0].settings = settings({ photosPerPage: 3 });
  await tap(`cat:${C1}:p:99`);
  assert.equal(jobs().length, 2);
  assert.equal(jobs()[0].imageUrl, 'https://r2.test/photo6.jpg');
});

test('photoStyle order_button: every photo is a button message with Order this (cat:item id) and a body', async () => {
  addItems(C1, 3);
  db.catalogs[0].settings = settings({ photoStyle: 'order_button' });
  await tap(`cat:${C1}:p:0`);
  const sent = jobs();
  assert.deepEqual(sent.slice(0, 3).map(j => [j.imageUrl, j.message, buttonsOf(j)]), [
    ['https://r2.test/photo0.jpg', 'D-0 · 000 · Soft cotton', [[`cat:${id(600)}:order`.replace(`cat:${id(600)}`, `cat:item:${id(600)}`), 'Order this']]],
    ['https://r2.test/photo1.jpg', 'D-1 · 100', [[`cat:item:${id(601)}:order`, 'Order this']]],
    ['https://r2.test/photo2.jpg', 'D-2 · 200', [[`cat:item:${id(602)}:order`, 'Order this']]]
  ]);
  assert.equal(outbound()[0].interactive_payload.kind, 'buttons');
  assert.deepEqual(usage, []);
});

test('order_button style falls back to the collection title as the body of a photo with no text', async () => {
  addItems(C1, 1);
  db.catalog_items[0].design_no = null; db.catalog_items[0].price_text = null; db.catalog_items[0].caption = null;
  db.catalogs[0].settings = settings({ photoStyle: 'order_button' });
  await tap(`cat:${C1}:p:0`);
  assert.equal(jobs()[0].message, 'Collection 1');
});

test('order_button style with no order action sends plain photos', async () => {
  addItems(C1, 2);
  db.catalogs[0].settings = settings({ photoStyle: 'order_button', orderAction: null });
  await tap(`cat:${C1}:p:0`);
  assert.equal(jobs()[0].buttons, undefined);
  assert.deepEqual(buttonsOf(jobs()[2]).map(b => b[1]), ['🛍️ Catalogue']);
});

test('an empty collection says so and offers the Catalogue button', async () => {
  await tap(`cat:${C1}:p:0`);
  assert.equal(jobs().length, 1);
  assert.match(jobs()[0].message, /no designs in Collection 1 yet/);
  assert.deepEqual(buttonsOf(jobs()[0]).map(b => b[0]), ['cat:menu']);
});

test('the Catalogue button sends the carousel again', async () => {
  await tap('cat:menu');
  assert.equal(jobs()[0].type, 'carousel');
});

test('Order on a collection with a message action: the order text (templated, localized), one usage unit, an order_collection event', async () => {
  db.catalogs[0].settings = settings({ orderAction: { type: 'message', text: 'Thanks {{customerName}}, we will call you', textTranslations: { hi: 'HI-thanks' } } });
  await tap(`cat:${C2}:order`);
  assert.equal(jobs()[0].message, 'Thanks Ravi, we will call you');
  assert.deepEqual(usage, []);
  await flush();
  assert.deepEqual(db.catalog_events.map(e => [e.event, e.collection_id, e.item_id]), [['order_collection', C2, null]]);
  events = []; db.customers[0].preferred_language = 'hi';
  await tap(`cat:${C2}:order`);
  assert.equal(jobs()[0].message, 'HI-thanks');
});

test('Order with a booking_trigger: the booking starts at that node with the collection / design / price as prefill (base-language values)', async () => {
  addItems(C1, 2);
  db.catalogs[0].settings = settings({ orderAction: { type: 'booking_trigger', nodeId: BOOK } });
  db.catalog_collections[0].title_translations = { hi: 'HI-title' };
  await tap(`cat:item:${id(601)}:order`);
  assert.deepEqual(startArgs.slice(0, 3), [BIZ, BOOK, 'en']);
  assert.deepEqual(startArgs[3], { prefill: [
    { key: 'catalogCollection', value: 'Collection 1' }, { key: 'catalogDesignNo', value: 'D-1' }, { key: 'catalogPrice', value: '100' }
  ] });
  assert.equal(jobs()[0].message, 'Your name?', 'the first booking question goes out through the normal path');
  await flush();
  assert.deepEqual(db.catalog_events.map(e => [e.event, e.item_id]), [['order_item', id(601)]]);

  events = []; startArgs = null;
  await tap(`cat:${C1}:order`);
  assert.deepEqual(startArgs[3], { prefill: [{ key: 'catalogCollection', value: 'Collection 1' }, { key: 'catalogPrice', value: 'From 499' }] });
});

test('Order with a web_form_trigger: the form token carries the prefill and the link goes out as a CTA button', async () => {
  addItems(C1, 1);
  db.catalogs[0].settings = settings({ orderAction: { type: 'web_form_trigger', nodeId: FORM } });
  await tap(`cat:item:${id(600)}:order`);
  assert.equal(db.booking_form_tokens.length, 1);
  const token = db.booking_form_tokens[0];
  assert.equal(token.flow_node_id, FORM);
  assert.deepEqual(token.prefill, [
    { key: 'catalogCollection', value: 'Collection 1' }, { key: 'catalogDesignNo', value: 'D-0' }, { key: 'catalogPrice', value: '000' }
  ]);
  assert.equal(jobs()[0].ctaButton.buttonText, 'Open form');
});

test('an ordinary web_form_trigger reply (no catalogue involved) mints a token with NO prefill key', async () => {
  matchNode = { id: FORM, nodeType: 'reply', contentType: 'text', replyKind: 'web_form_trigger', keyword: 'form', isActive: true, label: 'Fill the order form', buttonText: 'Open form' };
  await say('form');
  assert.equal(db.booking_form_tokens.length, 1);
  assert.equal('prefill' in db.booking_form_tokens[0], false);
});

test('an order action pointing at a missing / wrong node falls back to the default order message', async () => {
  db.catalogs[0].settings = settings({ orderAction: { type: 'booking_trigger', nodeId: id(999) } });
  await tap(`cat:${C1}:order`);
  assert.match(jobs()[0].message, /noted your order request/);
  assert.equal(startArgs, null);
});

test('disabled catalogue, no active collection, or the feature switched off: the empty text', async () => {
  db.catalogs[0].settings = settings({ enabled: false, emptyText: 'Back soon!' });
  await say('catalogue');
  assert.equal(jobs()[0].message, 'Back soon!');
  assert.equal(jobs()[0].type, 'text');
  assert.deepEqual(usage, []);

  events = []; db.catalogs[0].settings = settings({ emptyTextTranslations: { hi: 'HI-empty' } });
  db.catalog_collections.forEach(c => { c.is_active = false; });
  db.customers[0].preferred_language = 'hi';
  await say('catalogue');
  assert.equal(jobs()[0].message, 'HI-empty');

  events = []; db.catalog_collections.forEach(c => { c.is_active = true; });
  db.customers[0].preferred_language = 'en';
  db.category_features.push({ category: 'menswear', feature: 'catalogue', is_enabled: false });
  await say('catalogue');
  assert.match(jobs()[0].message, /being updated/);
  events = [];
  await tap(`cat:${C1}:p:0`);
  assert.match(jobs()[0].message, /being updated/, 'taps on old buttons get the empty text too');
});

test('a business with no catalogs row at all gets the built-in empty text', async () => {
  db.catalogs = [];
  await say('catalogue');
  assert.match(jobs()[0].message, /being updated/);
});

test('stale taps (a deleted / switched-off collection or photo): "no longer available" and the catalogue again', async () => {
  db.catalog_collections[1].is_active = false;
  await tap(`cat:${C2}:p:0`);
  assert.equal(jobs().length, 2);
  assert.match(jobs()[0].message, /no longer available/);
  assert.equal(jobs()[1].type, 'carousel');
  events = [];
  await tap(`cat:item:${id(777)}:order`);
  assert.match(jobs()[0].message, /no longer available/);
  events = [];
  await tap(`cat:${id(888)}:p:0`);
  assert.match(jobs()[0].message, /no longer available/);
});

test('a malformed cat: id is not a catalogue tap and is never treated as a booking answer or keyword', async () => {
  await tap('cat:garbage');
  assert.equal(db.catalog_events.length, 0);
  assert.ok(jobs().every(j => j.type !== 'carousel' && !(j.buttons || []).some(b => b.nextKeyword.startsWith('cat:'))), 'the generic fallback, nothing from the catalogue');
  assert.equal(startArgs, null);
});

test('mid-booking, a catalogue tap only re-shows the pending question and never starts anything', async () => {
  activeSession = { currentNodeId: 'q1', ruleId: BOOK, collected: {} };
  await tap(`cat:${C1}:order`);
  assert.equal(events.length, 1);
  assert.equal(jobs()[0].message, 'Your name?');
  assert.equal(startArgs, null);
  assert.equal(db.catalog_events.length, 0);
});

test('a card button that arrives as a message of type "button" is routed like an interactive tap', async () => {
  await tapAsButton(`cat:${C1}:p:0`);
  assert.match(jobs()[0].message, /no designs in Collection 1/);
  events = [];
  await tapAsButton(`cat:${id(888)}:p:0`);   // unknown collection: not claimed, falls through to template-button handling
  assert.equal(db.catalog_events.length, 0);
  assert.ok(jobs().every(j => j.type !== 'carousel' && !(j.message || '').includes('Collection')));
});

test('an ordinary keyword reply is untouched (no catalogue code on the path)', async () => {
  matchNode = { id: id(40), nodeType: 'reply', contentType: 'text', replyKind: 'text', keyword: 'hours', isActive: true, label: 'We open at 9', imageUrl: null };
  await say('hours');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'queue');
  assert.equal(jobs()[0].message, 'We open at 9');
  assert.equal(db.catalog_events.length, 0);
});

// ---- taps on the card buttons of a "Send catalogue" broadcast (payload ends ":b:<broadcastId>") ----
const BC = id(900);

test('a View designs tap from a catalogue broadcast is logged with source "broadcast" and its broadcast id', async () => {
  db.broadcasts = [{ id: BC, business_id: BIZ, kind: 'catalog' }];
  addItems(C1, 3);
  await tapAsButton(`cat:${C1}:p:0:b:${BC}`);   // how a template quick-reply tap arrives
  await flush();
  assert.equal(jobs().at(-1).type, 'text');
  assert.match(jobs().at(-1).message, /Showing 1.3 of 3 designs in Collection 1/);
  assert.deepEqual(db.catalog_events.map(e => [e.event, e.collection_id, e.source, e.broadcast_id]), [['designs_view', C1, 'broadcast', BC]]);
  assert.deepEqual(jobs().at(-1).buttons.map(b => b.nextKeyword), [`cat:${C1}:order`, 'cat:menu'], 'the next buttons the bot sends carry no suffix');
});

test('an Order tap from a catalogue broadcast is logged the same way (interactive reply too)', async () => {
  db.broadcasts = [{ id: BC, business_id: BIZ, kind: 'catalog' }];
  await tap(`cat:${C2}:order:b:${BC}`);
  await flush();
  assert.deepEqual(db.catalog_events.map(e => [e.event, e.collection_id, e.source, e.broadcast_id]), [['order_collection', C2, 'broadcast', BC]]);
});

test('a tap without the suffix is a normal bot tap: no source / broadcast_id in the row', async () => {
  db.broadcasts = [{ id: BC, business_id: BIZ, kind: 'catalog' }];
  addItems(C1, 2);
  await tap(`cat:${C1}:p:0`);
  await flush();
  assert.equal(db.catalog_events.length, 1);
  assert.equal('source' in db.catalog_events[0], false);
  assert.equal('broadcast_id' in db.catalog_events[0], false);
});

test('a suffix naming another business\'s, a template, or an unknown broadcast is just a normal tap', async () => {
  db.broadcasts = [
    { id: BC, business_id: 'other-business', kind: 'catalog' },
    { id: id(901), business_id: BIZ, kind: 'template' }
  ];
  addItems(C1, 2);
  for (const broadcastId of [BC, id(901), id(902)]) {
    db.catalog_events = [];
    await tap(`cat:${C1}:p:0:b:${broadcastId}`);
    await flush();
    assert.equal(db.catalog_events.length, 1, broadcastId);
    assert.equal('broadcast_id' in db.catalog_events[0], false, broadcastId);
  }
});

test('a broadcast-suffixed tap on a collection that no longer exists gets the "no longer available" answer', async () => {
  db.broadcasts = [{ id: BC, business_id: BIZ, kind: 'catalog' }];
  db.catalog_collections[1].is_active = false;
  await tapAsButton(`cat:${C2}:p:0:b:${BC}`);
  assert.match(jobs()[0].message, /no longer available/);
  assert.equal(jobs()[1].type, 'carousel');
});
