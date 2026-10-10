// Run: node --test src/controllers/webhook.marketingBlock.test.js
// A customer who stopped MARKETING messages (customers.marketing_blocked_at):
//   - Meta's 131050 on a status webhook (chat message or broadcast recipient)
//     stamps that message's own customer, once;
//   - the user_preferences webhook stamps (stop) / clears (resume) it;
//   - the customer's START message clears it; nothing else here does.
// In-memory Supabase, every service / queue stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const OTHER_BIZ = 'b2';
const NUMBER = '919800000001';
const SECRET = 'test-secret';
const HOUR = 3600 * 1000;

let db; let queued; let rpcCalls; let tenantFound;

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
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: BIZ, enabledLanguages: ['en'], welcomeMessage: null }) });
stub('../services/booking.service', {
  getBookingSession: async () => null,
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

const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const failedStatus = (id, code, extra = {}) => sendBody({
  entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' },
    statuses: [{ id, status: 'failed', recipient_id: NUMBER, timestamp: '1767261600', errors: [{ code, title: 't' }], ...extra }] } }] }]
});
const preferences = (prefs, value = {}) => sendBody({
  entry: [{ id: 'waba1', changes: [{ field: 'user_preferences', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'pn1' }, user_preferences: prefs, ...value } }] }]
});
const pref = (extra = {}) => ({ wa_id: NUMBER, detail: 'User requested to stop marketing messages', category: 'marketing_messages', value: 'stop', timestamp: 1767261600, ...extra });
const text = (body) => sendBody({
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
    messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, type: 'text', text: { body } }]
  } }] }]
});

const STAMP = '2026-01-01T10:00:00.000Z'; // 1767261600
const cust = (id = 'c1') => db.customers.find((c) => c.id === id);

test.beforeEach(() => {
  queued = []; rpcCalls = []; tenantFound = true;
  db = {
    customers: [
      { id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null, marketing_blocked_at: null },
      { id: 'c2', business_id: BIZ, whatsapp_number: '919800000002', name: 'Asha', is_blocked: false, marketing_blocked_at: null },
      { id: 'x1', business_id: OTHER_BIZ, whatsapp_number: NUMBER, name: 'Elsewhere', is_blocked: false, marketing_blocked_at: null }
    ],
    messages: [{ id: 'm1', business_id: BIZ, customer_id: 'c1', customer_number: NUMBER, direction: 'outbound', status: 'sent', meta_message_id: 'wamid.OUT1' }],
    broadcast_recipients: [{ id: 'r1', broadcast_id: 'bc1', business_id: BIZ, customer_id: 'c2', whatsapp_number: '919800000002', status: 'sent', meta_message_id: 'wamid.BC1', sent_at: '2026-01-01T09:00:00.000Z' }],
    message_templates: [], flow_nodes: [], businesses: []
  };
});

// ── 131050 on a status webhook ──

test('131050 on a chat message stamps that message\'s customer, at Meta\'s time', async () => {
  await failedStatus('wamid.OUT1', 131050);
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
  assert.equal(cust('c2').marketing_blocked_at, null);
});

test('131050 on a broadcast recipient stamps that recipient\'s customer only', async () => {
  await failedStatus('wamid.BC1', 131050);
  assert.equal(cust('c2').marketing_blocked_at, STAMP);
  assert.equal(cust('c1').marketing_blocked_at, null);
});

test('only this business\'s customer is stamped, even if another business has the same number', async () => {
  await failedStatus('wamid.OUT1', 131050);
  assert.equal(cust('x1').marketing_blocked_at, null);
});

test('a repeated 131050 keeps the first time and writes nothing more', async () => {
  await failedStatus('wamid.OUT1', 131050);
  db.messages[0].status = 'sent';
  await failedStatus('wamid.OUT1', 131050, { timestamp: '1767265200' });
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
});

test('131050 for a recipient whose customer is gone changes nothing and does not throw', async () => {
  db.broadcast_recipients[0].customer_id = null;
  db.broadcast_recipients[0].whatsapp_number = '919899999999';
  await failedStatus('wamid.BC1', 131050);
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
  assert.equal(db.customers.length, 3);
});

test('131049 (WhatsApp\'s own engagement limit) and other codes never stamp', async () => {
  await failedStatus('wamid.OUT1', 131049);
  db.messages[0].status = 'sent';
  await failedStatus('wamid.OUT1', 131026);
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
});

// ── user_preferences ──

test('a marketing stop stamps the customer; a later resume clears it', async () => {
  await preferences([pref()]);
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
  await preferences([pref({ value: 'resume', detail: 'User requested to resume marketing messages', timestamp: 1767265200 })]);
  assert.equal(cust('c1').marketing_blocked_at, null);
});

test('a resume older than the stamp cannot undo a newer stop', async () => {
  await preferences([pref({ timestamp: 1767265200 })]);
  await preferences([pref({ value: 'resume', timestamp: 1767261600 })]);
  assert.equal(cust('c1').marketing_blocked_at, '2026-01-01T11:00:00.000Z');
});

test('a repeated stop keeps the first time', async () => {
  await preferences([pref()]);
  await preferences([pref({ timestamp: 1767265200 })]);
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
});

test('an unknown wa_id is ignored: no customer is created or changed', async () => {
  await preferences([pref({ wa_id: '919877777777' })]);
  assert.equal(db.customers.length, 3);
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
});

test('only this business\'s customer is touched', async () => {
  await preferences([pref()]);
  assert.equal(cust('x1').marketing_blocked_at, null);
});

test('other preference categories, other values and malformed entries are skipped', async () => {
  await preferences([pref({ category: 'something_else' }), pref({ value: 'maybe' }), pref({ wa_id: 12345 }), null, 'junk']);
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
});

test('several preferences in one webhook are each applied', async () => {
  await preferences([pref(), pref({ wa_id: '919800000002' })]);
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
  assert.equal(cust('c2').marketing_blocked_at, STAMP);
});

test('no business for the phone number, no phone_number_id, or no preferences: ignored, nothing thrown', async () => {
  tenantFound = false;
  await preferences([pref()]);
  tenantFound = true;
  await preferences([pref()], { metadata: {} });
  await preferences([]);
  await sendBody({ entry: [{ id: 'waba1', changes: [{ field: 'user_preferences', value: {} }] }] });
  await sendBody({ entry: [{ id: 'waba1', changes: [{ field: 'user_preferences' }] }] });
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
});

// ── START ──

test('the customer\'s START clears a stopped-marketing flag (no pause to clear)', async () => {
  cust('c1').marketing_blocked_at = STAMP;
  await text('START');
  assert.equal(cust('c1').marketing_blocked_at, null);
});

test('START also clears it while a timed pause is running, and leaves other customers alone', async () => {
  cust('c1').marketing_blocked_at = STAMP;
  cust('c1').bot_paused_until = new Date(Date.now() + HOUR).toISOString();
  cust('c2').marketing_blocked_at = STAMP;
  await text('start');
  assert.equal(cust('c1').marketing_blocked_at, null);
  assert.equal(cust('c1').bot_paused_until, null);
  assert.equal(cust('c2').marketing_blocked_at, STAMP);
});

test('an ordinary message does not clear it', async () => {
  cust('c1').marketing_blocked_at = STAMP;
  await text('hello there');
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
});

test('STOP does not touch a stopped-marketing flag', async () => {
  cust('c1').marketing_blocked_at = STAMP;
  await text('STOP');
  assert.equal(cust('c1').marketing_blocked_at, STAMP);
  assert.ok(cust('c1').opted_out_at);
});
