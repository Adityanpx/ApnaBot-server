// Run: node --test src/controllers/webhook.carousel.test.js
// A reply node with content_type 'carousel': the customer gets a native Meta carousel (2+ cards with
// media), or - cards without media (e.g. cloned from a category template), fewer than 2 with media, uneven
// buttons - the body plus one message per card with its quick-reply buttons. Either way ONE outbound row and
// ONE queue job (the worker owns the 4xx fallback), cards over the plan's limit are skipped, and a tap on a
// card button routes to the edge's target. In-memory Supabase, everything else stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const E = ['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000003'];

let db; let events; let node; let edges; let plan; let usage; let logs; let carouselTapIds; let target;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(row); return [row]; }
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, payload)); return m; }
    return matching();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    order: () => q,
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test' });
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
  warn: () => {}, error: (...a) => logs.push(`ERROR ${a.join(' ')}`), debug: () => {}
});
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
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan,
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Sunrise Hotel', businessName: 'Sunrise Hotel'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => { usage.push('outbound'); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en', 'hi'], name: 'Sunrise Hotel' }) });
stub('../services/booking.service', {
  getBookingSession: async () => null, deleteBookingSession: async () => {}, saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => (text === 'rooms' ? { node, edges } : null),
  // A tap on an edge id of the carousel resolves to the edge's target node, like the real resolver.
  resolveTappedEdge: async (businessId, id) => {
    const edge = edges.find(e => e.id === id);
    return edge ? { edge, targetNode: target } : null;
  },
  resolveCarouselTap: async (businessId, payload) => (carouselTapIds.includes(payload) ? payload : null),
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
const tapInteractive = (id) => deliver({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Book' } } });
const tapAsButton = (payload) => deliver({ type: 'button', button: { payload, text: 'Book' } });

const BUSINESS = { msg_limit: -1, images_per_reply: 10, video_per_reply: true, carousel_max_cards: 10 };
const edge = (id, cardIndex, label, labelTranslations = null) => ({ id, nextKeyword: id, cardIndex, label, labelTranslations, displayOrder: 0, toNodeId: 'n2' });
const card = (mediaId, body, translations = null) => ({ media_id: mediaId, media_type: 'image', body, body_translations: translations });

test.beforeEach(() => {
  events = []; usage = []; logs = []; plan = BUSINESS; carouselTapIds = [];
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: [],
    business_media: [
      { id: 'm1', business_id: BIZ, url: 'https://r2.test/m1.jpeg', media_type: 'image' },
      { id: 'm2', business_id: BIZ, url: 'https://r2.test/m2.jpeg', media_type: 'image' },
      { id: 'm3', business_id: BIZ, url: 'https://r2.test/m3.jpeg', media_type: 'image' }
    ]
  };
  node = {
    id: 'n1', contentType: 'carousel', replyKind: 'text', isActive: true, label: 'Welcome to {{businessName}}',
    labelTranslations: { hi: 'स्वागत है' }, imageUrl: null,
    carouselCards: [card('m1', 'Deluxe room'), card('m2', 'Suite', { hi: 'सुइट' })]
  };
  edges = [edge(E[0], 0, 'Book', { hi: 'बुक करें' }), edge(E[1], 1, 'Book', { hi: 'बुक करें' })];
  target = { id: 'n2', nodeType: 'reply', contentType: 'text', replyKind: 'text', isActive: true, label: 'Booking details', imageUrl: null };
});

const job = () => events.find(e => e.kind === 'queue').job;
const outboundRows = () => db.messages.filter(m => m.direction === 'outbound');

test('cards with media: one job for a native carousel, body templated, one outbound row, counted once', async () => {
  await say('rooms');
  assert.equal(events.length, 1);
  const j = job();
  assert.deepEqual([j.type, j.carouselNative, j.message, j.imageUrl], ['carousel', true, 'Welcome to Sunrise Hotel', null]);
  assert.deepEqual(j.carouselCards.map(c => [c.mediaUrl, c.text, c.buttons.map(b => b.nextKeyword)]), [
    ['https://r2.test/m1.jpeg', 'Deluxe room', [E[0]]],
    ['https://r2.test/m2.jpeg', 'Suite', [E[1]]]
  ]);
  const [row] = outboundRows();
  assert.equal(outboundRows().length, 1);
  assert.equal(row.type, 'text');
  assert.equal(row.content, 'Welcome to Sunrise Hotel');
  assert.deepEqual(row.interactive_payload, {
    kind: 'carousel', body: 'Welcome to Sunrise Hotel',
    cards: [
      { mediaType: 'image', mediaUrl: 'https://r2.test/m1.jpeg', text: 'Deluxe room', buttons: [{ id: E[0], title: 'Book' }] },
      { mediaType: 'image', mediaUrl: 'https://r2.test/m2.jpeg', text: 'Suite', buttons: [{ id: E[1], title: 'Book' }] }
    ]
  });
  assert.equal(job().messageId, row.id);
  assert.deepEqual(usage, [], 'counted by the queue worker when Meta accepts the job, not by the webhook');
});

test('cards whose media is null (category template clone): text fallback job with ALL card buttons, not a bare body', async () => {
  node.carouselCards = [card(null, 'Deluxe room'), card(null, 'Suite')];
  await say('rooms');

  const j = job();
  assert.deepEqual([j.type, j.carouselNative], ['carousel', false]);
  assert.deepEqual(j.carouselCards.map(c => [c.mediaUrl, c.text, c.buttons]), [
    [null, 'Deluxe room', [{ nextKeyword: E[0], title: 'Book' }]],
    [null, 'Suite', [{ nextKeyword: E[1], title: 'Book' }]]
  ]);
  assert.equal(outboundRows().length, 1, 'still ONE inbox row');
  assert.equal(outboundRows()[0].interactive_payload.cards[1].buttons[0].id, E[1]);
  assert.ok(logs.some(l => l.includes('sending separate messages')));
  assert.equal(logs.some(l => l.startsWith('ERROR')), false, 'never an error');
});

test('only one card with media: fallback, keeping that card image and the other card buttons', async () => {
  node.carouselCards = [card('m1', 'Deluxe room'), card(null, 'Suite')];
  await say('rooms');
  const j = job();
  assert.equal(j.carouselNative, false);
  assert.deepEqual(j.carouselCards.map(c => [c.mediaUrl, c.buttons.length]), [['https://r2.test/m1.jpeg', 1], [null, 1]]);
});

test('a card whose media was deleted from the library is dropped from a native carousel, the rest still go', async () => {
  node.carouselCards = [card('m1', 'A'), card('gone', 'B'), card('m3', 'C')];
  edges = [edge(E[0], 0, 'Book'), edge(E[1], 1, 'Book'), edge(E[2], 2, 'Book')];
  await say('rooms');
  const j = job();
  assert.equal(j.carouselNative, true);
  assert.deepEqual(j.carouselCards.map(c => c.text), ['A', 'C']);
});

test('cards beyond the current plan carousel_max_cards are skipped', async () => {
  plan = { ...BUSINESS, carousel_max_cards: 2 };
  node.carouselCards = [card('m1', 'A'), card('m2', 'B'), card('m3', 'C')];
  edges = [edge(E[0], 0, 'Book'), edge(E[1], 1, 'Book'), edge(E[2], 2, 'Book')];
  await say('rooms');
  assert.deepEqual(job().carouselCards.map(c => c.text), ['A', 'B']);
  assert.ok(logs.some(l => l.includes('"skippedOverPlan":1')));
});

test('uneven buttons per card are not sent natively (Meta would reject it)', async () => {
  edges = [edge(E[0], 0, 'Book'), edge(E[2], 0, 'More'), edge(E[1], 1, 'Book')];
  await say('rooms');
  const j = job();
  assert.equal(j.carouselNative, false);
  assert.deepEqual(j.carouselCards.map(c => c.buttons.length), [2, 1]);
});

test('the customer language picks body, card text and button labels', async () => {
  db.customers[0].preferred_language = 'hi';
  await say('rooms');
  const j = job();
  assert.equal(j.message, 'स्वागत है');
  assert.deepEqual(j.carouselCards.map(c => [c.text, c.buttons[0].title]), [['Deluxe room', 'बुक करें'], ['सुइट', 'बुक करें']]);
});

test('a tap on a card button (interactive button_reply, id = edge id) routes to the edge target', async () => {
  node.carouselCards = [card(null, 'Deluxe room'), card(null, 'Suite')];
  await tapInteractive(E[1]);
  const j = job();
  assert.equal(j.message, 'Booking details');
  assert.equal(j.type, 'text');
  assert.equal(outboundRows().length, 1);
  // The first carousel tap this process sees records its raw shape once (the other tap tests do not repeat it).
  assert.equal(logs.filter(l => l.includes('First carousel button tap seen, raw shape')).length, 1);
  assert.match(logs.find(l => l.includes('First carousel button tap seen')), /"messageType":"interactive".*"hasButtonReplyId":true/);
});

test('the same tap delivered as a message of type "button" (payload = edge id of a carousel) routes the same way', async () => {
  carouselTapIds = [E[0]];
  await tapAsButton(E[0]);
  assert.equal(job().message, 'Booking details');
});

test('a "button" message whose payload is NOT a carousel edge is left to the template-button handling', async () => {
  await tapAsButton('some-template-payload');
  // Not routed to the carousel target: the template handler treats the label as typed text, which
  // matches no rule here, so the generic fallback reply goes out.
  assert.notEqual(job().message, 'Booking details');
});

test('a carousel node with no cards at all is sent as a plain reply, not an error', async () => {
  node.carouselCards = null;
  await say('rooms');
  const j = job();
  assert.equal(j.type, 'text');
  assert.equal(j.message, 'Welcome to Sunrise Hotel');
  assert.equal(logs.some(l => l.startsWith('ERROR')), false);
});

test('buttons left on a carousel node without a card are ignored (info log), the cards still send natively', async () => {
  edges = [...edges, { id: E[2], nextKeyword: E[2], cardIndex: null, label: 'Old button', displayOrder: 5, toNodeId: 'n2' }];
  await say('rooms');
  const j = job();
  assert.equal(j.carouselNative, true);
  assert.deepEqual(j.carouselCards.map(c => c.buttons.map(b => b.nextKeyword)), [[E[0]], [E[1]]]);
  assert.ok(logs.some(l => l.includes('"ignoredButtonsWithoutCard":1')));
  assert.equal(logs.some(l => l.startsWith('ERROR')), false);
});
