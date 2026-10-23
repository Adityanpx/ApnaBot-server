// Run: node --test src/controllers/webhook.handoff.test.js
// The human-needed alert in the inbound-message webhook:
//   keyword    a short message asking for a person goes ahead of rule matching
//   tap        a reply node with reply_kind 'handoff'
//   unmatched  the Nth unmatched message in a row
// and the safety nets: no settings row = the legacy human_needed behaviour exactly; never during a booking
// session, while the bot is paused, or for an acknowledgement.
// In-memory Supabase and Redis, every queue / external service stubbed; notification.service is a recorder.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

let db; let queued; let tenantFound; let pushCalls; let activeSession; let matchResult; let findCalls; let redisStore; let reminders;

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
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    not: (c, _op, v) => { filters.push(r => (r[c] ?? null) !== v); return q; },
    or: (expr) => {
      const parts = expr.split(',').map(p => p.split('.'));
      filters.push(r => parts.some(([col, opName, ...rest]) => {
        if (opName === 'is') return r[col] === null || r[col] === undefined;
        if (opName === 'lt') return r[col] != null && new Date(r[col]).getTime() < new Date(rest.join('.')).getTime();
        return false;
      }));
      return q;
    },
    lt: (c, v) => { filters.push(r => r[c] != null && new Date(r[c]).getTime() < new Date(v).getTime()); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    order: () => q,
    limit: () => q,
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test', STATUS_RETRY_DELAY_MS: 30 });
stub('../config/supabase', { from, rpc: async () => ({ data: { changed: [], changed_recipients: [], unmatched: [] }, error: null }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {
  get: async (k) => redisStore.get(k) ?? null,
  set: async (k, v) => { redisStore.set(k, v); return 'OK'; },
  del: async (k) => (redisStore.delete(k) ? 1 : 0),
  incr: async (k) => { const n = (redisStore.get(k) || 0) + 1; redisStore.set(k, n); return n; },
  expire: async () => 1
});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/handoffReminder.queue', {
  scheduleHandoffReminder: async (data, delay) => { reminders.push({ data, delay }); },
  cancelHandoffReminder: async () => {}
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/tenant.service', {
  invalidateTenantCache: async () => {},
  resolveBusinessByPhoneNumberId: async () => (tenantFound ? {
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz', enabledLanguages: ['en', 'hi']
  } : null)
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  recordOutbound: async () => {}
});
const realNotification = (() => { const real = require('../services/notification.service'); return { isAcknowledgement: real.isAcknowledgement, asksForHuman: real.asksForHuman }; })();
stub('../services/notification.service', {
  ...realNotification,
  notify: (...args) => { pushCalls.push(['notify', ...args]); },
  notifyOnce: async (...args) => { pushCalls.push(['notifyOnce', ...args]); },
  notifyNewMessage: async (...args) => { pushCalls.push(['notifyNewMessage', ...args]); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en', 'hi'], welcomeMessage: null }) });
stub('../services/booking.service', {
  getBookingSession: async () => activeSession,
  deleteBookingSession: async () => {},
  saveBookingSession: async () => {},
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => ({ text: 'done' }),
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => null,
  advanceGraphSession: async () => ({ session: null, result: 'x' }),
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async () => { throw new Error('unexpected'); }
});
stub('../services/chatbot.service', {
  findMatchingRule: async (_biz, text) => { findCalls.push(text); return typeof matchResult === 'function' ? matchResult(text) : matchResult; },
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');

const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const text = (body, from = NUMBER) => sendBody({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
    messages: [{ id: `wamid.${Math.random()}`, from, type: 'text', text: { body } }]
  } }] }]
});
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();
const calls = (kind) => pushCalls.filter((c) => c[0] === kind);
const humanPushes = () => calls('notify').filter((c) => c[2] === 'human_needed');
const customer = () => db.customers.find((c) => c.id === 'c1');
const lastReply = () => queued[queued.length - 1]?.message;
const settingsRow = (over = {}) => ({ business_id: BIZ, enabled: true, keywords: null, unmatched_threshold: 3, reply_text: '', reply_text_translations: {},
  closed_text: '', closed_text_translations: {}, pause_bot_minutes: 0, reminder_minutes: 15, auto_resume_bot: false, hours: null, ...over });
const HANDOFF_BUILTIN = /Our team has been told/;
const FALLBACK = 'Thank you for your message. We will get back to you soon.';

test.beforeEach(() => {
  queued = []; tenantFound = true; pushCalls = []; activeSession = null; matchResult = null; findCalls = []; redisStore = new Map(); reminders = [];
  db = {
    customers: [
      { id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null, marketing_blocked_at: null, last_message_at: hoursAgo(1), needs_human_at: null }
    ],
    messages: [], message_templates: [], flow_nodes: [], businesses: [],
    business_handoff_settings: [settingsRow()]
  };
});

// ── off: no settings row = today's behaviour ────────────────────────────────
test('no settings row: nothing about handoff happens - the legacy human_needed push for a request, rule matching as before', async () => {
  db.business_handoff_settings = [];
  await text('talk to owner');
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  const once = calls('notifyOnce').filter((c) => c[2] === 'human_needed');
  assert.equal(once.length, 2); // the explicit request, then the no-rule fallback: same key, throttled by notifyOnce itself
  assert.deepEqual(findCalls, ['talk to owner', 'hi']); // the message, then the greeting-menu probe of the fallback
  assert.equal(lastReply(), FALLBACK);
});

test('a settings row with enabled false is the same as no row', async () => {
  db.business_handoff_settings = [settingsRow({ enabled: false })];
  await text('something with no rule');
  assert.equal(customer().needs_human_at, null);
  assert.equal(calls('notifyOnce').filter((c) => c[2] === 'human_needed').length, 1);
  assert.equal(lastReply(), FALLBACK);
});

// ── keyword ─────────────────────────────────────────────────────────────────
test('keyword: a short request alerts the owner once, tells the customer, and skips rule matching', async () => {
  await text('I want to talk to someone');
  assert.equal(customer().needs_human_reason, 'keyword');
  assert.ok(customer().needs_human_at);
  assert.equal(humanPushes().length, 1);
  assert.deepEqual(humanPushes()[0].slice(1), [BIZ, 'human_needed', { customerId: 'c1', customerName: 'Ravi', customerNumber: NUMBER }]);
  assert.equal(calls('notifyOnce').filter((c) => c[2] === 'human_needed').length, 0); // the legacy path is bypassed
  assert.match(lastReply(), HANDOFF_BUILTIN);
  assert.equal(findCalls.length, 0);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].delay, 15 * MIN);
  const saved = db.messages.filter((m) => m.direction === 'outbound');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sender_type, 'bot');
});

test('keyword: Hindi and Marathi phrases, and Roman-script ones, work for a business on the legacy matcher', async () => {
  for (const phrase of ['मुझे बात करनी है', 'मालक', 'baat karna hai']) {
    db.customers[0].needs_human_at = null; pushCalls = []; queued = [];
    await text(phrase);
    assert.equal(humanPushes().length, 1, phrase);
    assert.equal(findCalls.length, 0, phrase);
  }
});

test('keyword: asked again while open - the customer is answered again, the owner is not alerted again', async () => {
  await text('agent');
  await text('agent please');
  assert.equal(humanPushes().length, 1);
  assert.equal(reminders.length, 1);
  assert.equal(queued.length, 2);
  assert.match(queued[1].message, HANDOFF_BUILTIN);
});

test('keyword: a message of more than 6 words carries on to normal rule matching', async () => {
  await text('can I talk to the owner about prices');
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  assert.equal(findCalls[0], 'can I talk to the owner about prices');
});

test('keyword: not during a booking, not while the bot is paused', async () => {
  activeSession = { ruleId: 'r', currentNodeId: 'n' };
  await text('agent');
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);

  activeSession = null; queued = [];
  db.customers[0].bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  await text('agent');
  assert.equal(customer().needs_human_at, null);
  assert.equal(queued.length, 0);
});

test('keyword: the business\'s own phrases replace the defaults; its own reply text (translated) is sent', async () => {
  db.business_handoff_settings = [settingsRow({ keywords: ['manager'], reply_text: 'We will call you back', reply_text_translations: { hi: 'हम कॉल करेंगे' } })];
  await text('talk to owner'); // a default phrase, no longer in the list
  assert.equal(customer().needs_human_at, null);
  await text('manager');
  assert.equal(customer().needs_human_reason, 'keyword');
  assert.equal(lastReply(), 'We will call you back');
  db.customers[0].needs_human_at = null; db.customers[0].preferred_language = 'hi';
  await text('manager');
  assert.equal(lastReply(), 'हम कॉल करेंगे');
});

test('keyword: pauseBotMinutes pauses the bot; closed hours send the closed text with the next opening', async () => {
  // Open for one minute a day, three hours from now (India time): closed at this moment, every day of the week.
  const { istMinuteOfDay } = require('../utils/ist');
  const openMinute = (istMinuteOfDay(new Date()) + 180) % 1380;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const day = [{ open: hhmm(openMinute), close: hhmm(openMinute + 1) }];
  const hours = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, day]));
  db.business_handoff_settings = [settingsRow({ pause_bot_minutes: 120, hours })];
  await text('agent');
  assert.ok(customer().bot_paused_until);
  assert.equal(customer().handoff_pause_set_to, customer().bot_paused_until);
  const minutes = (new Date(customer().bot_paused_until).getTime() - Date.now()) / MIN;
  assert.ok(minutes > 119 && minutes <= 120, String(minutes));
  assert.match(lastReply(), /^Thank you! 🙏 We are closed right now\. Our team will reply to you here (today|tomorrow) at \d{1,2}:\d{2} (am|pm)\.$/);
});

// ── tap (a handoff reply node) ──────────────────────────────────────────────
const handoffNode = (over = {}) => ({ id: 'n-talk', nodeType: 'reply', replyKind: 'handoff', contentType: 'text', label: '', imageUrl: null, ...over });

test('tap: a handoff node alerts the owner and replies with the built-in text when the node has none', async () => {
  matchResult = { node: handoffNode(), edges: [] };
  await text('talk'); // the node's own keyword (a 1-word message not in the default list)
  assert.equal(customer().needs_human_reason, 'tap');
  assert.equal(humanPushes().length, 1);
  assert.match(lastReply(), HANDOFF_BUILTIN);
});

test('tap: the node\'s own text wins over the settings text; the settings text is used when the node has none', async () => {
  db.business_handoff_settings = [settingsRow({ reply_text: 'Settings text' })];
  matchResult = { node: handoffNode({ label: 'Node text' }), edges: [] };
  await text('talk');
  assert.equal(lastReply(), 'Node text');
  assert.equal(humanPushes().length, 1);
  db.customers[0].needs_human_at = null;
  matchResult = { node: handoffNode(), edges: [] };
  await text('talk');
  assert.equal(lastReply(), 'Settings text');
});

test('tap: tapped again while open - answered again, no second alert', async () => {
  matchResult = { node: handoffNode(), edges: [] };
  await text('talk');
  await text('talk');
  assert.equal(humanPushes().length, 1);
  assert.equal(queued.length, 2);
});

test('tap: with handoff off for the business a handoff node is just a text reply (no alert)', async () => {
  db.business_handoff_settings = [];
  matchResult = { node: handoffNode({ label: 'Our team will reply' }), edges: [] };
  await text('talk');
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  assert.equal(lastReply(), 'Our team will reply');
  matchResult = { node: handoffNode(), edges: [] };
  await text('talk');
  assert.match(lastReply(), HANDOFF_BUILTIN); // an empty node text is never sent as an empty message
});

// ── unmatched ───────────────────────────────────────────────────────────────
test('unmatched: the 3rd in a row is answered with the handoff reply and alerts once; the first two get the normal fallback and no alert', async () => {
  await text('blah one');
  await text('blah two');
  assert.equal(lastReply(), FALLBACK);
  assert.equal(humanPushes().length, 0);
  assert.equal(calls('notifyOnce').length, 0); // the legacy "every unmatched" push is off
  await text('blah three');
  assert.equal(customer().needs_human_reason, 'unmatched');
  assert.equal(humanPushes().length, 1);
  assert.match(lastReply(), HANDOFF_BUILTIN);
  await text('blah four');
  assert.equal(humanPushes().length, 1);
  assert.equal(lastReply(), FALLBACK); // already open: the normal fallback stands
});

test('unmatched: acknowledgements do not count; a matched rule starts the run over; the threshold is the business\'s', async () => {
  await text('blah one');
  await text('ok');
  await text('thanks');
  await text('blah two');
  assert.equal(humanPushes().length, 0);
  matchResult = { node: { id: 'n1', nodeType: 'reply', replyKind: 'text', contentType: 'text', label: 'A rule' }, edges: [] };
  await text('a question with a rule');
  matchResult = null;
  await text('blah three');
  await text('blah four');
  assert.equal(humanPushes().length, 0);
  await text('blah five');
  assert.equal(humanPushes().length, 1);

  db.customers[0].needs_human_at = null; db.customers[0].handoff_cleared_at = null; redisStore.clear(); pushCalls = [];
  db.business_handoff_settings = [settingsRow({ unmatched_threshold: 1 })];
  await text('blah once');
  assert.equal(humanPushes().length, 1);
});

test('unmatched: threshold 0 turns the trigger off (and the legacy every-unmatched push stays off)', async () => {
  db.business_handoff_settings = [settingsRow({ unmatched_threshold: 0 })];
  for (let i = 0; i < 5; i += 1) await text(`blah ${i}`);
  assert.equal(customer().needs_human_at, null);
  assert.equal(pushCalls.length, 0);
});

test('unmatched: within 30 minutes of a clear it does not reopen; after that it does', async () => {
  db.customers[0].handoff_cleared_at = new Date(Date.now() - 10 * MIN).toISOString();
  for (let i = 0; i < 4; i += 1) await text(`blah ${i}`);
  assert.equal(customer().needs_human_at, null);
  assert.equal(humanPushes().length, 0);
  assert.equal(lastReply(), FALLBACK);

  db.customers[0].handoff_cleared_at = new Date(Date.now() - 31 * MIN).toISOString();
  await text('blah again');
  assert.equal(humanPushes().length, 1);
  assert.match(lastReply(), HANDOFF_BUILTIN);
});

test('unmatched: a tapped (stale) button is not counted as an unmatched message', async () => {
  const tap = (id) => sendBody({
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Old' } } }]
    } }] }]
  });
  for (let i = 0; i < 4; i += 1) await tap(`stale-${i}`);
  assert.equal(customer().needs_human_at, null);
});

// ── interplay ───────────────────────────────────────────────────────────────
test('while a handoff is open, a customer message during a pause pushes new_message but plans no customer_waiting check', async () => {
  db.customers[0].bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  await text('hello?');
  assert.equal(calls('notifyNewMessage')[0][3].skipWaitingCheck, false);
  pushCalls = [];
  db.customers[0].needs_human_at = new Date().toISOString();
  await text('anyone there?');
  assert.deepEqual(calls('notifyNewMessage')[0][3], { skipWaitingCheck: true });
});
