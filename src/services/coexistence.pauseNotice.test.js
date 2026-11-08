// Run: node --test src/services/coexistence.pauseNotice.test.js
// The pause notice from the owner replying in the WhatsApp Business app (echo): only behind ECHO_AUTO_PAUSE, only when the
// bot goes active -> paused, only with the business setting on and the 24h window open. In-memory Supabase, mock timers.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../test-support/stubRedis');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const fake = createFakeSupabase();
const envConfig = { ECHO_AUTO_PAUSE: false };
let queued; let logs;
stub('../config/env', envConfig);
stub('../config/supabase', fake);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...a) => logs.push(a) });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./tenant.service', { resolveBusinessByPhoneNumberId: async () => null, invalidateTenantCache: async () => {} });
stub('./whatsapp.service', {});
stub('./r2.service', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => { queued.push(job); }, addToWhatsappQueueAndWait: async (job) => { queued.push(job); } });

const svc = require('./coexistence.service');
const { SYSTEM_MESSAGES } = require('../utils/systemMessages');
const { INDEFINITE_PAUSE_SENTINEL } = require('../utils/botPause');

const HOUR = 60 * 60 * 1000;
const BIZ = 'b1';
const BIZ_NUMBER = '919607024225';
const NUMBER = '919800000001';
const meta = { display_phone_number: '+91 96070 24225', phone_number_id: 'pn1' };
const tenant = { businessId: BIZ, isActive: true, whatsappOnboardingType: 'coexistence' };
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();
const nowSec = () => String(Math.floor(Date.now() / 1000));
const echo = (id) => ({ from: BIZ_NUMBER, to: NUMBER, id, timestamp: nowSec(), type: 'text', text: { body: 'hi' } });
const send = (...echoes) => svc.handleEchoes(tenant, { metadata: meta, message_echoes: echoes });
const cust = () => fake.db.customers.find((c) => c.whatsapp_number === NUMBER);
const notices = () => queued.filter((j) => Object.values(SYSTEM_MESSAGES.pauseNoticeTimed).concat(Object.values(SYSTEM_MESSAGES.pauseNoticeIndefinite)).includes(j.message));
const flush = () => new Promise((r) => setImmediate(r));
const fire = async () => { test.mock.timers.tick(svc.ECHO_PAUSE_DELAY_MS); for (let i = 0; i < 20; i++) await flush(); };

test.beforeEach(() => {
  for (const k of Object.keys(fake.db)) delete fake.db[k];
  fake.db.businesses = [{
    id: BIZ, notify_pause_enabled: true, notify_pause_text: null, notify_pause_text_translations: null,
    phone_number_id: 'pn1', access_token: 'tok', is_whatsapp_connected: true
  }];
  fake.db.customers = [{
    id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', preferred_language: 'mr', last_message_at: hoursAgo(1),
    last_activity_at: hoursAgo(1), total_messages: 3, bot_paused_until: null, pause_notice_sent_at: null, pipeline_stage: 'new'
  }];
  fake.db.messages = [];
  queued = []; logs = [];
  envConfig.ECHO_AUTO_PAUSE = true;
  test.mock.timers.enable({ apis: ['setTimeout'] });
});
test.afterEach(() => { test.mock.timers.reset(); });

test('owner replies from the phone while the bot is active: paused 24h, then one timed notice in the customer\'s language', async () => {
  await send(echo('wamid.E1')); await fire();
  assert.ok(new Date(cust().bot_paused_until).getTime() > Date.now() + 23 * HOUR);
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].message, SYSTEM_MESSAGES.pauseNoticeTimed.mr);
  assert.equal(notices()[0].to, NUMBER);
});

test('a second echo (owner types again) inside the cooldown: still paused, no second notice', async () => {
  await send(echo('wamid.E1')); await fire();
  await send(echo('wamid.E2')); await fire();
  assert.equal(notices().length, 1);
});

test('already paused (timed, e.g. a handoff pause): the pause is extended as before, no notice', async () => {
  cust().bot_paused_until = new Date(Date.now() + 2 * HOUR).toISOString();
  await send(echo('wamid.E1')); await fire();
  assert.equal(notices().length, 0);
  assert.ok(new Date(cust().bot_paused_until).getTime() > Date.now() + 23 * HOUR);
});

test('indefinite pause: kept, no notice', async () => {
  cust().bot_paused_until = INDEFINITE_PAUSE_SENTINEL;
  await send(echo('wamid.E1')); await fire();
  assert.equal(cust().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
  assert.equal(notices().length, 0);
});

test('ECHO_AUTO_PAUSE off: no pause and therefore no notice', async () => {
  envConfig.ECHO_AUTO_PAUSE = false;
  await send(echo('wamid.E1')); await fire();
  assert.equal(cust().bot_paused_until, null);
  assert.equal(queued.length, 0);
});

test('setting off: paused as before, no notice', async () => {
  fake.db.businesses[0].notify_pause_enabled = false;
  await send(echo('wamid.E1')); await fire();
  assert.ok(cust().bot_paused_until);
  assert.equal(queued.length, 0);
});

test('outside the 24h window, or a customer who never wrote: paused, no notice and no error', async () => {
  cust().last_message_at = hoursAgo(30);
  await send(echo('wamid.E1')); await fire();
  assert.ok(cust().bot_paused_until);
  assert.equal(notices().length, 0);

  fake.db.customers = [];
  await send(echo('wamid.E2')); await fire();
  assert.equal(cust().last_message_at, null);
  assert.ok(cust().bot_paused_until);
  assert.equal(notices().length, 0);
  assert.deepEqual(logs, []);
});

test('an echo of a message ApnaBot sent itself (wamid matches a bot row): no pause, no notice - so the notice cannot loop', async () => {
  fake.db.messages.push({ id: 'api', business_id: BIZ, customer_id: 'c1', meta_message_id: 'wamid.N', direction: 'outbound', sender_type: 'bot' });
  await send(echo('wamid.N')); await fire();
  assert.equal(cust().bot_paused_until, null);
  assert.equal(queued.length, 0);
});

test('a failing notice leaves the pause in place and does not throw out of the echo handler', async () => {
  stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => { throw new Error('queue down'); }, addToWhatsappQueueAndWait: async () => {} });
  await send(echo('wamid.E1')); await fire();
  assert.ok(new Date(cust().bot_paused_until).getTime() > Date.now() + 23 * HOUR);
  assert.equal(cust().pipeline_stage, 'contacted');
});
