// Run: node --test src/controllers/webhook.pushNotifications.test.js
// Push-notification hooks in the inbound-message webhook:
//   enquiry_new   the customer row was just created, or their last inbound message was over 24h ago
//   new_message   any other inbound message while the bot is paused for that customer
//   human_needed  no rule matched (the fallback reply)
// In-memory Supabase, every service / queue stubbed; notification.service is a recorder.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;

let db; let queued; let rpcCalls; let tenantFound; let pushCalls; let activeSession;

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

// apply_message_statuses, mirrored in JS (the SQL is checked by supabase/verification).
const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : 'now');
const rpc = async (name, args) => {
  rpcCalls.push([name, args]);
  const changed = []; const unmatched = []; const changedRecipients = [];
  for (const ev of args.p_events) {
    let r = (db.messages || []).find((x) => x.meta_message_id === ev.wamid);
    const isRecipient = !r;
    if (isRecipient) r = (db.broadcast_recipients || []).find((x) => x.meta_message_id === ev.wamid);
    if (!r) { if (!unmatched.includes(ev.wamid)) unmatched.push(ev.wamid); continue; }
    if (ev.status === 'failed' && r.status === 'sent') Object.assign(r, { status: 'failed', failed_at: r.failed_at || iso(ev.ts), error_code: ev.error_code, error_title: ev.error_title, error_details: ev.error_details });
    else continue;
    (isRecipient ? changedRecipients : changed).push({ ...r });
  }
  return { data: { changed, changed_recipients: changedRecipients, unmatched }, error: null };
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test', STATUS_RETRY_DELAY_MS: 30 });
stub('../config/supabase', { from, rpc });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/tenant.service', {
  invalidateTenantCache: async () => {},
  resolveBusinessByPhoneNumberId: async () => (tenantFound ? {
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz'
  } : null)
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }),
  incrementUsage: async () => {}
});
const realNotification = (() => { const real = require('../services/notification.service'); return { isAcknowledgement: real.isAcknowledgement, asksForHuman: real.asksForHuman }; })();
stub('../services/notification.service', {
  ...realNotification,
  notify: (...args) => { pushCalls.push(['notify', ...args]); },
  notifyOnce: async (...args) => { pushCalls.push(['notifyOnce', ...args]); },
  notifyNewMessage: async (...args) => { pushCalls.push(['notifyNewMessage', ...args]); }
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en'], welcomeMessage: null }) });
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
  findMatchingRule: async () => null,
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});


const { receiveWebhook } = require('./webhook.controller');

const NUMBER_NEW = '919800000099';
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

test.beforeEach(() => {
  queued = []; rpcCalls = []; tenantFound = true; pushCalls = []; activeSession = null;
  db = {
    customers: [
      { id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null, marketing_blocked_at: null, last_message_at: hoursAgo(1) }
    ],
    messages: [], message_templates: [], flow_nodes: [], businesses: []
  };
});

test('enquiry_new: a brand-new customer first message', async () => {
  await text('hello', NUMBER_NEW);
  const created = db.customers.find((c) => c.whatsapp_number === NUMBER_NEW);
  assert.ok(created);
  assert.equal(calls('notify').length, 1);
  const [, businessId, type, payload] = calls('notify')[0];
  assert.deepEqual([businessId, type], [BIZ, 'enquiry_new']);
  assert.deepEqual(payload, { customerId: created.id, customerName: 'Ravi', customerNumber: NUMBER_NEW, preview: 'hello' });
  assert.equal(calls('notifyNewMessage').length, 0);
});

test('enquiry_new: a returning customer whose last message was over 24h ago; also one who never messaged (imported contact)', async () => {
  db.customers[0].last_message_at = hoursAgo(25);
  await text('hi again');
  assert.equal(calls('notify').length, 1);
  assert.equal(calls('notify')[0][2], 'enquiry_new');
  pushCalls = [];
  db.customers[0].last_message_at = null;
  await text('first time');
  assert.equal(calls('notify')[0][2], 'enquiry_new');
});

test('no push for a returning customer who wrote within 24h while the bot is on', async () => {
  db.customers[0].last_message_at = hoursAgo(23);
  await text('hello');
  assert.equal(calls('notify').length, 0);
  assert.equal(calls('notifyNewMessage').length, 0);
});

test('new_message: an inbound message while the bot is paused for that customer', async () => {
  db.customers[0].bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  await text('are you there?');
  assert.equal(calls('notifyNewMessage').length, 1);
  const [, businessId, payload] = calls('notifyNewMessage')[0];
  assert.equal(businessId, BIZ);
  assert.deepEqual(payload, { customerId: 'c1', customerName: 'Ravi', customerNumber: NUMBER, preview: 'are you there?' });
  assert.equal(calls('notify').length, 0);
});

test('a paused customer first message after 24h is an enquiry_new, not also a new_message', async () => {
  db.customers[0].bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  db.customers[0].last_message_at = hoursAgo(30);
  await text('hello?');
  assert.equal(calls('notify').length, 1);
  assert.equal(calls('notifyNewMessage').length, 0);
});

test('human_needed: no rule matched (the fallback reply), with the once-per-customer key', async () => {
  await text('something the bot has no rule for');
  const once = calls('notifyOnce').filter((c) => c[2] === 'human_needed');
  assert.equal(once.length, 1);
  assert.deepEqual(once[0].slice(1), [BIZ, 'human_needed', { customerId: 'c1', customerName: 'Ravi', customerNumber: NUMBER }, `${BIZ}:c1`, 300]);
});

test('human_needed: a short acknowledgement that matches no rule does not notify', async () => {
  for (const ack of ['ok', 'Thanks!', '👍', 'ठीक आहे', 'ok sir']) {
    pushCalls = [];
    await text(ack);
    assert.equal(calls('notifyOnce').length, 0, ack);
  }
});

test('human_needed: an explicit request for a person notifies with the same throttle key, and the bot still replies as before', async () => {
  for (const ask of ['I want to talk to owner', 'please CALL ME', 'मला मालकांशी बोलायचे आहे']) {
    pushCalls = []; queued = [];
    await text(ask);
    const once = calls('notifyOnce').filter((c) => c[2] === 'human_needed');
    assert.ok(once.length >= 1, ask);
    assert.equal(once[0][4], `${BIZ}:c1`);
    assert.equal(once[0][5], 300);
    assert.ok(queued.length >= 1, 'the bot reply is unchanged');
  }
});

const buttonTap = (id) => sendBody({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
    messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Talk to a human' } } }]
  } }] }]
});
const humanNeeded = () => calls('notifyOnce').filter((c) => c[2] === 'human_needed');

test('human request: a button tap whose text contains "human" is not read as a request for a person', async () => {
  // With no rule behind the tap, the fallback may still notify (once); the explicit check must add nothing on top.
  await buttonTap('hello');
  const baseline = humanNeeded().length;
  pushCalls = [];
  await buttonTap('talk to a human');
  assert.equal(humanNeeded().length, baseline);
  assert.ok(baseline <= 1);
});

test('human request: typed "talk to owner" during an active booking session does not notify', async () => {
  activeSession = { collected: {}, answeredFields: [] };
  await text('talk to owner');
  assert.equal(humanNeeded().length, 0);
});

test('human request: typed "talk to owner" with no booking session notifies', async () => {
  await text('talk to owner');
  assert.equal(humanNeeded().length >= 1, true);
  assert.equal(humanNeeded()[0][4], `${BIZ}:c1`);
});
