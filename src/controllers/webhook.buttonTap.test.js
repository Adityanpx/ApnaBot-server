// Run: node --test src/controllers/webhook.buttonTap.test.js
// receiveWebhook for an inbound template quick-reply tap (message type
// 'button'): in-memory Supabase, every service / queue stubbed, so nothing
// connects to a real database, Redis or WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const OTHER_BIZ = 'b2';
const TPL = '0b3f6c1e-1111-4222-8333-944455556666';
const NODE = '33333333-3333-4333-8333-333333333333';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;

let db; let queued; let calls; let session; let enabledLanguages; let tenantOverrides; let nodeLabel;

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
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz', ...tenantOverrides
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  incrementUsage: async () => {}
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', {
  getBusinessById: async () => ({ id: BIZ, enabledLanguages, welcomeMessage: null })
});
stub('../services/booking.service', {
  getBookingSession: async () => session,
  deleteBookingSession: async () => { calls.push('deleteBookingSession'); },
  saveBookingSession: async () => { calls.push('saveBookingSession'); },
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => ({ text: 'done' }),
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => ({ fieldType: 'text', label: 'What is your name?', nodeId: 'q1' }),
  advanceGraphSession: async () => { calls.push('advanceGraphSession'); return { session, result: 'x' }; },
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async (...args) => {
    calls.push(['startGraphSessionAtNode', args[1], args[2], args[4]]);
    return { session: { nodeId: args[1] }, field: { fieldType: 'text', label: 'Where to?', nodeId: args[1] } };
  }
});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => {
    calls.push(['findMatchingRule', text]);
    return text === 'price' ? { node: { id: 'n-price', contentType: 'text', replyKind: 'text', label: nodeLabel, isActive: true }, edges: [] } : null;
  },
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');

const send = async (message) => {
  const body = {
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, ...message }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};

const tap = (payload, text) => send({ type: 'button', button: { payload, text } });
const customer = () => db.customers.find(c => c.whatsapp_number === NUMBER);
const inbound = () => db.messages.filter(m => m.direction === 'inbound');
const sentTexts = () => queued.map(j => j.message);

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: [],
    message_templates: [{ id: TPL, business_id: BIZ, button_actions: [
      { index: 0, text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
      { index: 1, text: 'No more', action: { type: 'optout' } },
      { index: 2, text: 'Book', action: { type: 'node', nodeId: NODE } },
      { index: 3, text: 'Menu', action: { type: 'menu' } }
    ] }],
    flow_nodes: [{ id: NODE, business_id: BIZ, node_type: 'question', is_active: true }]
  };
  queued = []; calls = []; session = null; enabledLanguages = ['en']; tenantOverrides = {}; nodeLabel = 'Our prices: ...';
});

const pay = (i) => `tpl:${TPL}:${i}`;

test('the inbox shows the tapped label, not an empty bubble', async () => {
  await tap(pay(0), 'Prices');
  assert.equal(inbound()[0].type, 'button');
  assert.equal(inbound()[0].content, 'Prices');
});

test('keyword action routes like the typed keyword', async () => {
  await tap(pay(0), 'Prices');
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'price']);
  assert.ok(sentTexts().includes('Our prices: ...'));
});

test('menu action routes like "hi"', async () => {
  await tap(pay(3), 'Menu');
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'hi']);
});

test('node action on a question node starts the booking graph there', async () => {
  await tap(pay(2), 'Book');
  const started = calls.find(c => c[0] === 'startGraphSessionAtNode');
  assert.equal(started[1], NODE);
  assert.equal(started[3], null);
  assert.ok(calls.includes('saveBookingSession'));
  assert.ok(sentTexts().includes('Where to?'));
});

test('optout action: opted_out_at set, bot paused, STOP reply sent', async () => {
  await tap(pay(1), 'No more');
  assert.ok(customer().opted_out_at);
  assert.ok(new Date(customer().bot_paused_until).getTime() > Date.now());
  assert.equal(queued.length, 1);
  assert.ok(!calls.some(c => c[0] === 'findMatchingRule'));
});

test("Meta's own opt-out button (unknown payload) opts out", async () => {
  await tap('Stop promotions', 'Stop promotions');
  assert.ok(customer().opted_out_at);
  assert.equal(queued.length, 1);
});

test('opt-out works while the bot is paused', async () => {
  customer().bot_paused_until = new Date(Date.now() + HOUR).toISOString();
  await tap(pay(1), 'No more');
  assert.ok(customer().opted_out_at);
  assert.equal(queued.length, 1);
});

test('opt-out works mid-booking and leaves the session alone', async () => {
  session = { currentNodeId: 'q1', ruleId: 'r1' };
  await tap(pay(1), 'No more');
  assert.ok(customer().opted_out_at);
  assert.ok(!calls.includes('advanceGraphSession'));
  assert.ok(!calls.includes('deleteBookingSession'));
});

test('mid-booking, any other tap re-shows the pending question and is not an answer', async () => {
  session = { currentNodeId: 'q1', ruleId: 'r1' };
  await tap(pay(0), 'Prices');
  assert.ok(!calls.includes('advanceGraphSession'));
  assert.ok(!calls.some(c => c[0] === 'findMatchingRule'));
  assert.deepEqual(sentTexts(), ['What is your name?']);
});

test('paused bot: a non-opt-out tap is recorded, no reply', async () => {
  customer().bot_paused_until = new Date(Date.now() + HOUR).toISOString();
  await tap(pay(0), 'Prices');
  assert.equal(inbound().length, 1);
  assert.equal(queued.length, 0);
});

test('blocked customer: ignored', async () => {
  customer().is_blocked = true;
  await tap(pay(1), 'No more');
  assert.equal(inbound().length, 0);
  assert.equal(customer().opted_out_at, null);
  assert.equal(queued.length, 0);
});

test("another business's template payload is unknown: its text is typed, its action is not run", async () => {
  db.message_templates[0].business_id = OTHER_BIZ;
  await tap(pay(1), 'No more');
  assert.equal(customer().opted_out_at, null);
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'No more']);
});

test('unknown payload (Manager template): the button text is treated as typed text', async () => {
  await tap('Yes please', 'Yes please');
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'Yes please']);
});

test('no language yet: first enabled language is set, no picker, action still runs', async () => {
  customer().preferred_language = null;
  enabledLanguages = ['mr', 'en'];
  await tap(pay(0), 'Prices');
  assert.equal(customer().preferred_language, 'mr');
  assert.ok(!queued.some(j => (j.buttons || []).some(b => String(b.nextKeyword).startsWith('lang_'))));
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'price']);
});

test('no language and no enabled languages: falls back to en', async () => {
  customer().preferred_language = null;
  enabledLanguages = [];
  await tap(pay(0), 'Prices');
  assert.equal(customer().preferred_language, 'en');
});

test('a tap with no label and no payload is still skipped like any other non-text message', async () => {
  await send({ type: 'button', button: {} });
  assert.equal(queued.length, 0);
  assert.ok(!calls.some(c => c[0] === 'findMatchingRule'));
});

test('typed text and interactive taps are untouched: typed STOP still opts out, typed text still matches', async () => {
  await send({ type: 'text', text: { body: 'price' } });
  assert.deepEqual(calls.find(c => c[0] === 'findMatchingRule'), ['findMatchingRule', 'price']);
  queued = []; calls = [];
  await send({ type: 'text', text: { body: 'STOP' } });
  assert.ok(customer().opted_out_at);
  assert.equal(queued.length, 1);
});
