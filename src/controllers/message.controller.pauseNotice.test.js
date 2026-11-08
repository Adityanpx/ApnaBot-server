// Run: node --test src/controllers/message.controller.pauseNotice.test.js
// The pause notice from the dashboard: a staff send (POST /messages/send, /send-payment-qr) and the owner's pause toggle
// (PATCH /messages/customer/:id/pause). Notice only on a real active -> paused transition, after the staff message,
// never blocking it. In-memory Supabase; the queue and the inbox socket are captured.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../test-support/stubRedis');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const fake = createFakeSupabase();
let queued; let logs; let noticeGate = null; let queueFailsForNotice = false;
stub('../config/supabase', fake);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...a) => logs.push(a) });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', { advancePipelineStage: async () => {} });
stub('../services/payment.service', { buildPaymentQrCaption: () => 'Pay by QR' });
const NOTICE_TEXTS = new Set();
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => {
    if (NOTICE_TEXTS.has(job.message)) {
      if (queueFailsForNotice) throw new Error('queue down');
      if (noticeGate) await noticeGate;
    }
    queued.push(job);
  },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});

const { SYSTEM_MESSAGES } = require('../utils/systemMessages');
const { INDEFINITE_PAUSE_SENTINEL } = require('../utils/botPause');
const { sendMessage, sendPaymentQr, setBotPause } = require('./message.controller');
for (const k of ['pauseNoticeTimed', 'pauseNoticeIndefinite']) for (const t of Object.values(SYSTEM_MESSAGES[k])) NOTICE_TEXTS.add(t);

const HOUR = 60 * 60 * 1000;
const BIZ = 'biz-1';
const NUMBER = '919800000001';
const user = { userId: 'u1', businessId: BIZ, role: 'owner', name: 'Owner' };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const cust = () => fake.db.customers.find((c) => c.id === 'c1');
const notices = () => queued.filter((j) => NOTICE_TEXTS.has(j.message));
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();

const run = async (handler, req) => {
  let status; let body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { throw e; });
  return { status, body };
};
const send = (over = {}) => run(sendMessage, { body: { customerNumber: NUMBER, message: 'Hello from the team' }, user, ...over });
const pause = (body) => run(setBotPause, { params: { customerId: 'c1' }, body, user });

test.beforeEach(() => {
  for (const k of Object.keys(fake.db)) delete fake.db[k];
  fake.db.businesses = [{
    id: BIZ, name: 'Biz', business_category: 'general', is_whatsapp_connected: true, phone_number_id: 'pn1', access_token: 'tok',
    notify_pause_enabled: true, notify_pause_text: null, notify_pause_text_translations: null, payment_qr_url: 'https://qr/x.png'
  }];
  fake.db.customers = [{
    id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', preferred_language: 'en',
    last_message_at: hoursAgo(1), bot_paused_until: null, pause_notice_sent_at: null, needs_human_at: null
  }];
  fake.db.messages = [];
  queued = []; logs = []; noticeGate = null; queueFailsForNotice = false;
});

// ---- staff send ------------------------------------------------------------------

test('staff reply while the bot is active: pauses 24h, then sends ONE timed notice AFTER the staff message', async () => {
  const { status } = await send();
  await settle();
  assert.equal(status, 201);
  assert.ok(new Date(cust().bot_paused_until).getTime() > Date.now() + 23 * HOUR);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].message, 'Hello from the team', 'the staff message is queued first');
  assert.equal(queued[1].message, SYSTEM_MESSAGES.pauseNoticeTimed.en);
  assert.equal(fake.db.messages.length, 2);
  assert.equal(fake.db.messages[1].sender_type, 'bot');
});

test('staff reply to a customer whose preferred language is Hindi: Hindi notice', async () => {
  cust().preferred_language = 'hi';
  await send(); await settle();
  assert.equal(notices()[0].message, SYSTEM_MESSAGES.pauseNoticeTimed.hi);
});

test('already paused (timed): no notice. Already paused by a handoff: no notice. Indefinite: no notice and the pause is not shortened', async () => {
  const later = new Date(Date.now() + 5 * HOUR).toISOString();
  cust().bot_paused_until = later;                        // e.g. a handoff pause, or an earlier owner reply
  await send(); await settle();
  assert.equal(notices().length, 0);
  cust().bot_paused_until = INDEFINITE_PAUSE_SENTINEL;
  await send(); await settle();
  assert.equal(notices().length, 0);
  assert.equal(cust().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
});

test('a pause that has already expired counts as active: the notice is sent', async () => {
  cust().bot_paused_until = hoursAgo(2);
  await send(); await settle();
  assert.equal(notices().length, 1);
});

test('setting off: pauses exactly as before, no notice', async () => {
  fake.db.businesses[0].notify_pause_enabled = false;
  await send(); await settle();
  assert.ok(cust().bot_paused_until);
  assert.equal(notices().length, 0);
  assert.equal(queued.length, 1);
});

test('a second staff reply later (pause expired) inside the 24h cooldown: no second notice', async () => {
  await send(); await settle();
  cust().bot_paused_until = null; // START, or the pause ran out
  await send(); await settle();
  assert.equal(notices().length, 1);
});

test('the payment-QR send notifies too (it is a staff send)', async () => {
  await run(sendPaymentQr, { body: { customerNumber: NUMBER }, user }); await settle();
  assert.equal(notices().length, 1);
});

test('the staff send never waits for the notice, and a notice that fails does not break it', async () => {
  let release; noticeGate = new Promise((r) => { release = r; });
  const { status, body } = await send();   // would hang here if it awaited the gated notice
  assert.equal(status, 201); assert.ok(body.data.botPausedUntil);
  release(); await settle();
  assert.equal(notices().length, 1);

  // failing notice: the response is still a 201
  fake.db.customers[0].pause_notice_sent_at = null; cust().bot_paused_until = null; noticeGate = null; queueFailsForNotice = true;
  const failed = await send(); await settle();
  assert.equal(failed.status, 201);
  assert.ok(logs.length > 0, 'the failure is logged');
});

// ---- the owner's pause toggle ---------------------------------------------------------

test('pause toggle 24h from active: timed notice', async () => {
  const { status } = await pause({ paused: true, duration: '24h' }); await settle();
  assert.equal(status, 200);
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].message, SYSTEM_MESSAGES.pauseNoticeTimed.en);
});

test('pause toggle forever from active: the indefinite text, with no START in it', async () => {
  await pause({ paused: true, duration: 'forever' }); await settle();
  assert.equal(cust().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].message, SYSTEM_MESSAGES.pauseNoticeIndefinite.en);
  assert.ok(!/start/i.test(notices()[0].message));
});

test('pause toggle when already paused: no notice (a 24h pause made indefinite is silent)', async () => {
  cust().bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  await pause({ paused: true, duration: 'forever' }); await settle();
  assert.equal(notices().length, 0);
  assert.equal(cust().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
});

test('resuming the bot sends nothing', async () => {
  cust().bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  await pause({ paused: false }); await settle();
  assert.equal(cust().bot_paused_until, null);
  assert.equal(queued.length, 0);
});

test('pause toggle outside the 24h window, or with the setting off: paused, no notice', async () => {
  cust().last_message_at = hoursAgo(30);
  await pause({ paused: true }); await settle();
  assert.ok(cust().bot_paused_until);
  assert.equal(notices().length, 0);
  cust().bot_paused_until = null; cust().last_message_at = hoursAgo(1); fake.db.businesses[0].notify_pause_enabled = false;
  await pause({ paused: true }); await settle();
  assert.equal(notices().length, 0);
});

test('pause toggle for an unknown customer: 404, nothing sent', async () => {
  const { status } = await run(setBotPause, { params: { customerId: 'nope' }, body: { paused: true }, user }); await settle();
  assert.equal(status, 404);
  assert.equal(queued.length, 0);
});
