// Run: node --test src/services/pauseNotice.test.js
// "Tell customers when the bot pauses" (pauseNotice.service.js): the send rules, the texts, the cooldown, and that a
// failure never throws. In-memory Supabase; the WhatsApp queue and the inbox socket are captured.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../test-support/stubRedis');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const fake = createFakeSupabase();
let queued; let pushed; let logs; let queueError = null;
stub('../config/supabase', fake);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...a) => logs.push(a) });
stub('./socket.service', { emitToBusiness: (id, event, data) => { pushed.push({ id, event, data }); } });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { if (queueError) throw queueError; queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});

const { maybeSendPauseNotice, pauseNoticeText, PAUSE_NOTICE_COOLDOWN_MS } = require('./pauseNotice.service');
const { SYSTEM_MESSAGES, getSystemMessage } = require('../utils/systemMessages');

const HOUR = 60 * 60 * 1000;
const BIZ = 'biz-1';
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();

const bizRow = (over = {}) => ({
  id: BIZ, notify_pause_enabled: true, notify_pause_text: null, notify_pause_text_translations: null,
  phone_number_id: 'pn1', access_token: 'enc-token', is_whatsapp_connected: true, ...over
});
const custRow = (over = {}) => ({
  id: 'c1', business_id: BIZ, whatsapp_number: '919800000001', preferred_language: 'en',
  last_message_at: hoursAgo(1), bot_paused_until: null, pause_notice_sent_at: null, ...over
});
const camel = (row) => ({
  id: row.id, businessId: row.business_id, whatsappNumber: row.whatsapp_number, preferredLanguage: row.preferred_language,
  lastMessageAt: row.last_message_at, botPausedUntil: row.bot_paused_until, pauseNoticeSentAt: row.pause_notice_sent_at
});
const cust = () => fake.db.customers.find((c) => c.id === 'c1');
const send = (over = {}) => maybeSendPauseNotice({ businessId: BIZ, customer: camel(cust()), ...over });

test.beforeEach(() => {
  for (const k of Object.keys(fake.db)) delete fake.db[k];
  fake.db.businesses = [bizRow()];
  fake.db.customers = [custRow()];
  fake.db.messages = [];
  queued = []; pushed = []; logs = []; queueError = null;
});

// ---- sends -----------------------------------------------------------------

test('sends once: saved as an outbound bot message, queued to the customer, pushed to the inbox', async () => {
  const r = await send();
  assert.deepEqual(r, { sent: true, reason: 'timed' });
  assert.equal(fake.db.messages.length, 1);
  const m = fake.db.messages[0];
  assert.equal(m.direction, 'outbound'); assert.equal(m.sender_type, 'bot'); assert.equal(m.type, 'text');
  assert.equal(m.content, SYSTEM_MESSAGES.pauseNoticeTimed.en);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].to, '919800000001');
  assert.equal(queued[0].message, m.content);
  assert.equal(queued[0].messageId, m.id);
  assert.equal(queued[0].phoneNumberId, 'pn1');
  assert.equal(queued[0].encryptedAccessToken, 'enc-token');
  assert.equal(pushed.length, 1); assert.equal(pushed[0].event, 'new_message');
  assert.ok(cust().pause_notice_sent_at, 'cooldown stamped');
});

test('the inbox push carries the NEW pause, not the pre-pause read', async () => {
  const until = new Date(Date.now() + 24 * HOUR).toISOString();
  await send({ pausedUntil: until });
  assert.equal(pushed[0].data.customer.botPausedUntil, until);
});

test('setting off (the default for existing businesses): nothing sent, nothing saved, cooldown untouched', async () => {
  fake.db.businesses = [bizRow({ notify_pause_enabled: false })];
  assert.deepEqual(await send(), { sent: false, reason: 'setting off' });
  // a row from before the migration has no such column at all
  fake.db.businesses = [(() => { const r = bizRow(); delete r.notify_pause_enabled; return r; })()];
  assert.equal((await send()).sent, false);
  assert.equal(queued.length, 0); assert.equal(fake.db.messages.length, 0);
  assert.equal(cust().pause_notice_sent_at, null);
});

test('a business that is not connected to WhatsApp sends nothing', async () => {
  fake.db.businesses = [bizRow({ is_whatsapp_connected: false })];
  assert.equal((await send()).sent, false);
  assert.equal(queued.length, 0);
});

// ---- the 24h window ----------------------------------------------------------

test('outside the 24h window: skipped, no template, no error, cooldown not used up', async () => {
  cust().last_message_at = hoursAgo(25);
  assert.deepEqual(await send(), { sent: false, reason: 'outside the 24h window' });
  assert.equal(queued.length, 0); assert.equal(fake.db.messages.length, 0);
  assert.equal(cust().pause_notice_sent_at, null);
  assert.deepEqual(logs, []);
});

test('a customer who has never written to us: skipped', async () => {
  cust().last_message_at = null;
  assert.equal((await send()).sent, false);
  assert.equal(queued.length, 0);
});

// ---- cooldown -----------------------------------------------------------------

test('cooldown: a second notice inside 24h is not sent; after 24h it is', async () => {
  assert.equal((await send()).sent, true);
  assert.deepEqual(await send(), { sent: false, reason: 'cooldown' });
  assert.equal(queued.length, 1);
  cust().pause_notice_sent_at = new Date(Date.now() - PAUSE_NOTICE_COOLDOWN_MS - 1000).toISOString();
  assert.equal((await send()).sent, true);
  assert.equal(queued.length, 2);
});

test('cooldown: two replies racing send exactly one notice', async () => {
  const results = await Promise.all([send(), send(), send()]);
  assert.equal(results.filter((r) => r.sent).length, 1);
  assert.equal(queued.length, 1); assert.equal(fake.db.messages.length, 1);
});

// ---- texts ---------------------------------------------------------------------

test('timed text: the built-in, in en / hi / mr, tells the customer to reply START', () => {
  for (const lang of ['en', 'hi', 'mr']) {
    const text = pauseNoticeText({}, lang, false);
    assert.equal(text, SYSTEM_MESSAGES.pauseNoticeTimed[lang]);
    assert.ok(text.includes('START'), `${lang} must mention START`);
  }
  assert.match(SYSTEM_MESSAGES.pauseNoticeTimed.en, /paused for 24 hours/);
});

test('indefinite text: the built-in, in en / hi / mr, never mentions START', () => {
  for (const lang of ['en', 'hi', 'mr']) {
    const text = pauseNoticeText({}, lang, true);
    assert.equal(text, SYSTEM_MESSAGES.pauseNoticeIndefinite[lang]);
    assert.ok(!/start/i.test(text), `${lang} must not mention START`);
  }
  // a language with no translation falls back to English, which is also START-free
  assert.ok(!/start/i.test(getSystemMessage('pauseNoticeIndefinite', 'ta')));
});

test('the owner\'s wording is used for the timed pause (per language, base text as the fallback)', () => {
  const biz = { notifyPauseText: 'Our team replied. Send START to bring the bot back.', notifyPauseTextTranslations: { hi: 'टीम ने जवाब दिया। बॉट वापस लाने के लिए START भेजें।' } };
  assert.equal(pauseNoticeText(biz, 'en', false), biz.notifyPauseText);
  assert.equal(pauseNoticeText(biz, 'hi', false), biz.notifyPauseTextTranslations.hi);
  assert.equal(pauseNoticeText(biz, 'mr', false), biz.notifyPauseText);
  assert.equal(pauseNoticeText({ notifyPauseText: '   ' }, 'en', false), SYSTEM_MESSAGES.pauseNoticeTimed.en, 'blank = built-in');
});

test('the owner\'s wording is NEVER used for the indefinite pause (START does not lift it)', () => {
  const biz = { notifyPauseText: 'Reply START to turn the bot back on.', notifyPauseTextTranslations: { hi: 'START भेजें' } };
  for (const lang of ['en', 'hi', 'mr']) assert.ok(!/start/i.test(pauseNoticeText(biz, lang, true)));
});

test('end to end: indefinite pause sends the START-free text in the customer\'s language', async () => {
  cust().preferred_language = 'hi';
  const r = await send({ indefinite: true });
  assert.deepEqual(r, { sent: true, reason: 'indefinite' });
  assert.equal(queued[0].message, SYSTEM_MESSAGES.pauseNoticeIndefinite.hi);
  assert.ok(!queued[0].message.includes('START'));
});

// ---- failures never throw ---------------------------------------------------------

test('queue failure: nothing thrown, the failure is logged, and the cooldown slot is given back', async () => {
  queueError = new Error('redis down');
  const r = await send();
  assert.equal(r.sent, false); assert.match(r.reason, /redis down/);
  assert.ok(logs.length > 0);
  assert.equal(cust().pause_notice_sent_at, null, 'a later reply may still notify');
  queueError = null;
  assert.equal((await send()).sent, true);
});

test('database failure: nothing thrown', async () => {
  const realFrom = fake.from;
  fake.from = () => { throw new Error('db down'); };
  try {
    const r = await maybeSendPauseNotice({ businessId: BIZ, customer: camel(custRow()) });
    assert.equal(r.sent, false); assert.match(r.reason, /db down/);
  } finally { fake.from = realFrom; }
});

// ---- defaults / migration -------------------------------------------------------------

test('migration is additive: the switch defaults to false, no backfill, no row changes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../supabase/migrations/20261030120000_pause_notice.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').toLowerCase();
  assert.match(sql, /add column notify_pause_enabled boolean not null default false/);
  assert.match(sql, /add column notify_pause_text text/);
  assert.match(sql, /add column notify_pause_text_translations jsonb/);
  assert.match(sql, /alter table customers add column pause_notice_sent_at timestamptz/);
  assert.doesNotMatch(sql, /\b(update|delete|insert|drop|truncate)\b/);
});

test('createBusiness switches the notice on for a NEW business; updateBusiness can change it', async () => {
  const businessService = require('../services/business.service');
  fake.db.businesses = []; fake.db.users = [{ id: 'u1', business_id: null }]; fake.db.business_travel_settings = []; fake.db.business_handoff_settings = [];
  const created = await businessService.createBusiness('u1', { name: 'New Biz', businessCategory: 'general', address: 'x', city: 'y' });
  assert.equal(created.notifyPauseEnabled, true);
  const updated = await businessService.updateBusiness(created.id, { notifyPauseEnabled: false, notifyPauseText: 'hello', notifyPauseTextTranslations: { hi: 'नमस्ते' } });
  assert.equal(updated.notifyPauseEnabled, false);
  assert.equal(updated.notifyPauseText, 'hello');
  assert.deepEqual(updated.notifyPauseTextTranslations, { hi: 'नमस्ते' });
});
