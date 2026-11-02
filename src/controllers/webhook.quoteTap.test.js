// Run: node --test src/controllers/webhook.quoteTap.test.js
// The travel quote in the inbound-message webhook:
//   - taps on a quote's buttons ("quote:{id}:confirm|change|talk|paid") are handled ahead of the bot-pause
//     return, never as a booking answer, with or without a booking session, and not at all for a blocked
//     customer, over the usage limit, or on a repeated delivery of the same message
//   - a malformed quote id is "no longer available"; "Change" restarts the quote flow
//   - Step 12: the engine's {quote:{action}} result goes to the quote service (and never to the booking
//     finalizer); a failure there gives the generic message
// quoteFlow.service is a recorder here (its own rules - another customer's / business's quote, expiry,
// idempotency - are tested in services/quoteFlow.service.test.js). In-memory Supabase and Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;
const QID = '0b9c2f3e-1a4d-4e8b-9c7a-5d6e7f8a9b0c';

let db; let queued; let tenantFound; let activeSession; let matchResult; let findCalls; let redisStore; let usageAllowed;
let expiredCalls; let expiredAnswer; let quoteCalls; let quoteImpl; let advanceCalls; let advanceImpl; let finalized; let savedSessions; let startedAt;

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
    or: () => q,
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
stub('../queues/handoffReminder.queue', { scheduleHandoffReminder: async () => {}, cancelHandoffReminder: async () => {} });
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
  checkUsageLimit: async () => ({ allowed: usageAllowed, current: 0, limit: 500 }),
  recordOutbound: async () => {}
});
const realNotification = (() => { const real = require('../services/notification.service'); return { isAcknowledgement: real.isAcknowledgement, asksForHuman: real.asksForHuman }; })();
stub('../services/notification.service', {
  ...realNotification, notify: () => {}, notifyOnce: async () => {}, notifyNewMessage: async () => {}
});
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en', 'hi'], welcomeMessage: null }) });
stub('../services/booking.service', {
  getBookingSession: async () => activeSession,
  deleteBookingSession: async () => {},
  saveBookingSession: async (...args) => { savedSessions.push(args); },
  recordBookingLead: async () => {},
  finalizeGraphBooking: async () => { finalized += 1; return { text: 'done' }; },
  normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => null,
  advanceGraphSession: async (args) => { advanceCalls.push(args); return advanceImpl(args); },
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async (...args) => { startedAt.push(args); return { session: { currentNodeId: args[1], ruleId: args[2] }, field: { nodeId: args[1], fieldKey: 'tripType', fieldType: 'text', label: 'Which trip?', options: [] } }; }
});
stub('../services/quoteFlow.service', {
  handleTap: async (ctx, tap) => { quoteCalls.push(['tap', ctx, tap]); return quoteImpl(ctx, tap); },
  handleStaleTap: async (ctx) => { quoteCalls.push(['stale', ctx]); },
  handleExpiredChat: async (ctx, tappedId) => { expiredCalls.push([ctx, tappedId]); return expiredAnswer; },
  handleStart: async (ctx, entryNodeId) => { quoteCalls.push(['start', ctx, entryNodeId]); return { restart: { entryNodeId } }; },
  handleResult: async (ctx, session, quote) => { quoteCalls.push(['result', ctx, session, quote]); return quoteImpl(ctx, quote); }
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
const envelope = (message) => sendBody({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }], messages: [message]
  } }] }]
});
let seq = 0;
const tapButton = (id, wamid = `wamid.tap${++seq}`) => envelope({ id: wamid, from: NUMBER, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Confirm' } } });
const text = (body) => envelope({ id: `wamid.text${++seq}`, from: NUMBER, type: 'text', text: { body } });
const customer = () => db.customers.find((c) => c.id === 'c1');
const lastReply = () => queued[queued.length - 1]?.message;
const confirmId = `quote:${QID}:confirm`;

test.beforeEach(() => {
  queued = []; tenantFound = true; activeSession = null; matchResult = null; findCalls = []; redisStore = new Map(); usageAllowed = true;
  expiredCalls = []; expiredAnswer = false; quoteCalls = []; quoteImpl = async () => ({}); advanceCalls = []; advanceImpl = async () => ({ session: {}, result: 'x' });
  finalized = 0; savedSessions = []; startedAt = [];
  db = {
    customers: [
      { id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null, marketing_blocked_at: null, last_message_at: new Date(Date.now() - HOUR).toISOString(), needs_human_at: null }
    ],
    messages: [], message_templates: [], flow_nodes: [], businesses: [], business_handoff_settings: []
  };
});

// ── routing ─────────────────────────────────────────────────────────────────────────────────────

test('a quote tap goes to the quote service with this business and customer, and nothing else runs', async () => {
  await tapButton(confirmId);
  assert.equal(quoteCalls.length, 1);
  const [kind, ctx, tap] = quoteCalls[0];
  assert.equal(kind, 'tap');
  assert.deepEqual([ctx.tenant.businessId, ctx.customer.id, ctx.customerNumber], [BIZ, 'c1', NUMBER]);
  assert.deepEqual(tap, { quoteId: QID, action: 'confirm' });
  assert.equal(findCalls.length, 0, 'no rule matching');
  assert.equal(advanceCalls.length, 0, 'not a booking answer');
  assert.equal(queued.length, 0, 'the webhook itself sends nothing');
});

test('every action is routed: confirm, change, talk, paid', async () => {
  for (const action of ['confirm', 'change', 'talk', 'paid']) await tapButton(`quote:${QID}:${action}`);
  assert.deepEqual(quoteCalls.map(c => c[2].action), ['confirm', 'change', 'talk', 'paid']);
});

test('a quote tap works while the bot is paused (handoff pause); an ordinary message in the same pause is still ignored', async () => {
  db.customers[0].bot_paused_until = new Date(Date.now() + 5 * HOUR).toISOString();
  db.customers[0].needs_human_at = new Date().toISOString();
  await tapButton(`quote:${QID}:talk`);
  await tapButton(`quote:${QID}:paid`);
  assert.equal(quoteCalls.length, 2);
  await text('hello?');
  assert.equal(quoteCalls.length, 2);
  assert.equal(findCalls.length, 0);
  assert.equal(queued.length, 0);
});

test('with no booking session (expired after 5 minutes) the tap is still handled; with one running it is left alone', async () => {
  activeSession = null;
  await tapButton(confirmId);
  activeSession = { ruleId: 'r', currentNodeId: 'n', collected: {} };
  await tapButton(confirmId);
  assert.equal(quoteCalls.length, 2);
  assert.equal(advanceCalls.length, 0);
  assert.equal(savedSessions.length, 0, 'the running session is untouched');
});

test('a malformed quote id is "no longer available" - never rule matching, never a booking answer', async () => {
  for (const bad of ['quote:garbage', `quote:${QID}:delete`, `quote:${QID}`, 'quote:']) await tapButton(bad);
  assert.deepEqual(quoteCalls.map(c => c[0]), ['stale', 'stale', 'stale', 'stale']);
  assert.equal(findCalls.length, 0);
});

test('the same delivery twice (Meta retry) is handled once', async () => {
  await tapButton(confirmId, 'wamid.same');
  await tapButton(confirmId, 'wamid.same');
  assert.equal(quoteCalls.length, 1);
});

test('two real taps with different message ids are two taps (the service makes them idempotent)', async () => {
  await tapButton(confirmId);
  await tapButton(confirmId);
  assert.equal(quoteCalls.length, 2);
});

test('a blocked customer, or a business over its usage limit, gets nothing', async () => {
  db.customers[0].is_blocked = true;
  await tapButton(confirmId);
  db.customers[0].is_blocked = false; usageAllowed = false;
  await tapButton(confirmId);
  assert.equal(quoteCalls.length, 0);
  assert.equal(queued.length, 0);
});

test('an unknown business (no tenant) does nothing', async () => {
  tenantFound = false;
  await tapButton(confirmId);
  assert.equal(quoteCalls.length, 0);
});

// ── Change / failures ───────────────────────────────────────────────────────────────────────────

test('Change restarts the quote flow at the entry question: a new session is saved and the first question sent', async () => {
  quoteImpl = async () => ({ restart: { entryNodeId: 'entry-node' } });
  await tapButton(`quote:${QID}:change`);
  assert.deepEqual(startedAt, [[BIZ, 'entry-node', 'entry-node', 'en']]);
  assert.equal(savedSessions.length, 1);
  assert.equal(savedSessions[0][0], BIZ);
  assert.equal(savedSessions[0][1], NUMBER);
  assert.equal(lastReply(), 'Which trip?');
});

test('a failure while handling the tap gives the customer the generic message and does not throw', async () => {
  quoteImpl = async () => { throw new Error('db down'); };
  await tapButton(confirmId);
  assert.match(lastReply(), /something went wrong/);
});

test('a failure restarting the flow gives the same generic message', async () => {
  quoteImpl = async () => ({ restart: { entryNodeId: 'gone' } });
  const bookingGraph = require('../services/bookingGraph.service');
  const original = bookingGraph.startGraphSessionAtNode;
  bookingGraph.startGraphSessionAtNode = async () => { throw new Error('node missing'); };
  try {
    await tapButton(`quote:${QID}:change`);
  } finally { bookingGraph.startGraphSessionAtNode = original; }
  assert.match(lastReply(), /something went wrong/);
});

// ── Step 12: the engine's quote result ─────────────────────────────────────────────────────────

test('the engine\'s quote result goes to the quote service with the advanced session - never to the booking finalizer', async () => {
  activeSession = { ruleId: 'rule1', currentNodeId: 'n', collected: {}, answeredFields: [] };
  const advanced = { ruleId: 'rule1', currentNodeId: 'quote-node', collected: { vehicleFare: 3500 } };
  advanceImpl = async () => ({ session: advanced, result: { quote: { action: 'send', reason: null, nodeId: 'quote-node' } } });
  await text('10:00 PM');
  assert.equal(quoteCalls.length, 1);
  const [kind, ctx, session, quote] = quoteCalls[0];
  assert.equal(kind, 'result');
  assert.equal(ctx.customer.id, 'c1');
  assert.equal(session, advanced);
  assert.deepEqual(quote, { action: 'send', reason: null, nodeId: 'quote-node' });
  assert.equal(finalized, 0);
  assert.equal(savedSessions.length, 0, 'the quote service drops the session; nothing re-saves it');
  assert.equal(findCalls.length, 0);
});

test('a failure in the quote step gives the generic message and ends the turn', async () => {
  activeSession = { ruleId: 'rule1', currentNodeId: 'n', collected: {}, answeredFields: [] };
  advanceImpl = async () => ({ session: {}, result: { quote: { action: 'handoff', reason: 'other_route' } } });
  quoteImpl = async () => { throw new Error('boom'); };
  await text('x');
  assert.match(lastReply(), /something went wrong/);
  assert.equal(findCalls.length, 0);
});

test('the existing result shapes are unchanged: done finalizes the booking, a string re-prompts, a field is sent', async () => {
  activeSession = { ruleId: 'rule1', currentNodeId: 'n', collected: {}, answeredFields: [] };
  advanceImpl = async () => ({ session: {}, result: { done: true, collected: {} } });
  await text('x');
  assert.equal(finalized, 1);
  assert.equal(lastReply(), 'done');

  advanceImpl = async () => ({ session: {}, result: 'Please choose one of: A, B' });
  await text('y');
  assert.equal(lastReply(), 'Please choose one of: A, B');

  advanceImpl = async () => ({ session: {}, result: { nodeId: 'n2', fieldKey: 'f', fieldType: 'text', label: 'Next question?', options: [] } });
  await text('z');
  assert.equal(lastReply(), 'Next question?');
  assert.equal(quoteCalls.length, 0);
});

// ── an expired quote chat ─────────────────────────────────────────────────────

const STALE_TAP = '0b9c2f3e-1a4d-4e8b-9c7a-5d6e7f8a9b0c:1';
const ENTRY = '1c9d3a4f-2b5e-4f9c-8d8b-6e7f8a9b0c1d';

test('no rule matched and no session: a stale question tap and a typed answer are offered to the expired-chat check; when it replies nothing else does', async () => {
  expiredAnswer = true;
  await tapButton(STALE_TAP);
  await text('1-4');
  assert.deepEqual(expiredCalls.map(([, id]) => id), [STALE_TAP, null]);
  assert.deepEqual([expiredCalls[0][0].tenant.businessId, expiredCalls[0][0].customer.id, expiredCalls[0][0].customerNumber], [BIZ, 'c1', NUMBER]);
  assert.equal(queued.length, 0, 'no generic fallback, no menu');
});

test('when the check says it is not a quote answer, the generic fallback goes out exactly as before', async () => {
  expiredAnswer = false;
  await text('what is the weather');
  assert.equal(expiredCalls.length, 1);
  assert.equal(queued.length, 1);
  assert.ok(lastReply().includes('Thank you for your message'));
});

test('the check is never made for a message a rule answers, or while a booking session is running', async () => {
  matchResult = { node: { id: 'n1', label: 'Hello there', contentType: 'text', replyKind: 'text' }, edges: [] };
  await text('hi there');
  matchResult = null;
  activeSession = { ruleId: 'r', currentNodeId: 'n', collected: {} };
  await text('1-4');
  assert.equal(expiredCalls.length, 0);
});

test('the "Get a quote" button (quote:start:{entry}) restarts the quote flow at that entry question; a bad id is "no longer available"', async () => {
  await tapButton(`quote:start:${ENTRY}`);
  assert.deepEqual(quoteCalls.map((c) => c[0]), ['start']);
  assert.equal(quoteCalls[0][2], ENTRY);
  assert.equal(startedAt.length, 1);
  assert.equal(startedAt[0][1], ENTRY);
  assert.equal(savedSessions.length, 1);
  await tapButton('quote:start:not-a-uuid');
  assert.equal(quoteCalls.at(-1)[0], 'stale');
});
