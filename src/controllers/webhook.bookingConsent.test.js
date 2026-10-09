// Run: node --test src/controllers/webhook.bookingConsent.test.js
// receiveWebhook for the one-time marketing-consent question after a booking
// confirmation (services/bookingConsent.service.js): in-memory Supabase,
// every service / queue stubbed, so nothing connects to a real database,
// Redis or WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';

let db; let sent; let calls; let session; let settingOn; let confirmation; let triggerNode;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(row); return [row]; }
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, payload)); return m.map(r => ({ ...r })); }
    return matching().map(r => ({ ...r }));
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
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
// 'plain' = addToWhatsappQueue, 'wait' = addToWhatsappQueueAndWait: the order
// of `sent` is the order WhatsApp would deliver them in.
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { sent.push({ via: 'plain', job }); },
  addToWhatsappQueueAndWait: async (job) => { sent.push({ via: 'wait', job }); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'SG Travels', businessName: 'SG Travels'
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  incrementUsage: async () => {}
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', {
  getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en'], welcomeMessage: null, askConsentAfterBooking: settingOn })
});
stub('../services/booking.service', {
  getBookingSession: async () => session,
  deleteBookingSession: async () => { calls.push('deleteBookingSession'); },
  saveBookingSession: async () => { calls.push('saveBookingSession'); },
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => confirmation,
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => ({ fieldType: 'text', label: 'What is your name?', nodeId: 'q1' }),
  advanceGraphSession: async () => ({ session, result: { done: true } }),
  startGraphSession: async () => ({ session: { nodeId: 'n-book' }, result: { done: true } }),
  startGraphSessionAtNode: async () => { throw new Error('unexpected'); }
});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => (text === 'book' ? { node: triggerNode, edges: [] } : null),
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

const say = (text) => send({ type: 'text', text: { body: text } });
const tapButton = (id, title) => send({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const customer = () => db.customers.find(c => c.whatsapp_number === NUMBER);
const texts = () => sent.map(s => s.job.message);

test.beforeEach(() => {
  db = {
    customers: [{
      id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en',
      is_blocked: false, bot_paused_until: null, opted_in: false, opted_out_at: null,
      consent_prompted_at: null, consent_prompt_result: null
    }],
    messages: []
  };
  sent = []; calls = []; session = { currentNodeId: 'q1', ruleId: 'r1' }; settingOn = true;
  confirmation = { text: 'Booking received BK1234', imageUrl: null };
  triggerNode = { id: 'n-book', contentType: 'text', replyKind: 'booking_trigger', label: 'Book', isActive: true };
});

// ── Setting OFF: exactly today's behaviour ──

test('setting off, finishing a booking: ONE message, the confirmation, via the plain queue call; customer untouched', async () => {
  settingOn = false;
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  assert.deepEqual(texts(), ['Booking received BK1234']);
  assert.equal(sent[0].job.buttons, undefined);
  assert.equal(sent[0].job.type, 'text');
  assert.equal(customer().consent_prompted_at, null);
});

test('setting off, immediate-confirm booking: ONE message via the plain queue call', async () => {
  settingOn = false; session = null;
  await say('book');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  assert.deepEqual(texts(), ['Booking received BK1234']);
  assert.equal(customer().consent_prompted_at, null);
});

// ── Setting ON ──

test('setting on, finishing a booking: confirmation (waited) THEN the Yes/No question; customer marked asked', async () => {
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['wait', 'plain']);
  assert.equal(texts()[0], 'Booking received BK1234');
  const question = sent[1].job;
  assert.ok(question.message.includes('SG Travels') && question.message.includes('STOP'));
  assert.deepEqual(question.buttons.map(b => b.nextKeyword), ['optin_yes:booking', 'optin_no:booking']);
  assert.ok(customer().consent_prompted_at);
  assert.equal(customer().opted_in, false); // not opted in until they tap Yes
});

test('setting on, immediate-confirm booking: confirmation (waited) then the question', async () => {
  session = null;
  await say('book');
  assert.deepEqual(sent.map(s => s.via), ['wait', 'plain']);
  assert.deepEqual(sent[1].job.buttons.map(b => b.nextKeyword), ['optin_yes:booking', 'optin_no:booking']);
});

test('asked once ever: a second booking sends only the confirmation', async () => {
  await say('Ravi');
  sent = [];
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  assert.deepEqual(texts(), ['Booking received BK1234']);
});

test('advance-payment confirmation (payment QR image): no question, customer not marked asked', async () => {
  confirmation = { text: 'Pay the advance', imageUrl: 'https://img/qr.png' };
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  assert.equal(customer().consent_prompted_at, null);
});

test('already opted in / sent STOP: no question', async () => {
  customer().opted_in = true;
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  customer().opted_in = false; customer().opted_out_at = '2026-10-01T00:00:00Z';
  sent = [];
  await say('Ravi');
  assert.deepEqual(sent.map(s => s.via), ['plain']);
  assert.equal(customer().consent_prompted_at, null);
});

// ── Taps ──

const asked = () => { customer().consent_prompted_at = '2026-10-10T00:00:00Z'; session = null; };

test('tap Yes: opted in as booking_prompt, thanks sent, NO greeting menu after', async () => {
  asked();
  await tapButton('optin_yes:booking', 'Yes, send offers');
  assert.equal(customer().opted_in, true);
  assert.equal(customer().opt_in_source, 'booking_prompt');
  assert.equal(customer().consent_prompt_result, 'yes');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].job.message.includes('STOP')); // optInConfirmed
  assert.equal(sent[0].job.buttons, undefined);
});

test('tap No: declined line sent once, not opted in, NO greeting menu after', async () => {
  asked();
  await tapButton('optin_no:booking', 'No thanks');
  assert.equal(customer().opted_in, false);
  assert.equal(customer().consent_prompt_result, 'no');
  assert.deepEqual(texts(), ["No problem 👍 You'll only get messages about your bookings."]);
});

test('tap Yes after sending STOP: not opted in, opted_out_at kept, nothing sent', async () => {
  asked();
  customer().opted_out_at = '2026-10-10T01:00:00Z';
  await tapButton('optin_yes:booking', 'Yes, send offers');
  assert.equal(customer().opted_in, false);
  assert.equal(customer().opted_out_at, '2026-10-10T01:00:00Z');
  assert.equal(sent.length, 0);
});

test('tapping the same button again sends nothing more', async () => {
  asked();
  await tapButton('optin_no:booking', 'No thanks');
  sent = [];
  await tapButton('optin_no:booking', 'No thanks');
  assert.equal(sent.length, 0);
});

test('tap with a new booking already in progress: answer handled, then its pending question is shown again', async () => {
  asked();
  session = { currentNodeId: 'q1', ruleId: 'r1' };
  await tapButton('optin_no:booking', 'No thanks');
  assert.ok(!calls.includes('advanceGraphSession'));
  assert.deepEqual(texts(), ["No problem 👍 You'll only get messages about your bookings.", 'What is your name?']);
});

test('tap is honoured even if the setting was switched off since', async () => {
  asked(); settingOn = false;
  await tapButton('optin_yes:booking', 'Yes, send offers');
  assert.equal(customer().opted_in, true);
});
