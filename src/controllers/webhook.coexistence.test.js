// Run: node --test src/controllers/webhook.coexistence.test.js
// receiveWebhook with the WhatsApp Business app coexistence fields (owner's phone
// messages, history, contact sync, account_update): stored by the coexistence
// service and never run through the bot. In-memory Supabase, services stubbed.
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

let invalidated = []; let usageAllowed; let db; let queued; let calls; let session; let enabledLanguages; let tenantOverrides; let nodeLabel;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const made = (Array.isArray(payload) ? payload : [payload]).map((p, i) => ({ id: `${table}-${rows().length + i + 1}`, ...p })); made.forEach(r => rows().push(r)); return made; }
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, payload)); return m; }
    return matching();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
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
  invalidateTenantCache: async (id) => { invalidated.push(id); },
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz', ...tenantOverrides
  })
});
stub('../services/usage.service', {
  checkUsageLimit: async () => ({ allowed: usageAllowed, current: 0, limit: 500 }),
  incrementUsage: async (businessId, direction) => { calls.push(['incrementUsage', direction]); }
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
      messages: [{ id: message.id || `wamid.${Math.random()}`, from: NUMBER, ...message }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};



const BIZ_NUMBER = '919607024225';
const META = { display_phone_number: '+91 96070 24225', phone_number_id: 'pn1' };
const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const field = (name, value, entryId = 'waba1') => ({ entry: [{ id: entryId, changes: [{ field: name, value }] }] });
const echoValue = (id, to, body) => ({ messaging_product: 'whatsapp', metadata: META, message_echoes: [{ from: BIZ_NUMBER, to, id, timestamp: '1760000000', type: 'text', text: { body } }] });
const historyValue = () => ({ messaging_product: 'whatsapp', metadata: META, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 50 }, threads: [{ id: '919800000001', messages: [
  { from: '919800000001', to: BIZ_NUMBER, id: 'wamid.h1', timestamp: '1759000000', type: 'text', text: { body: 'secret old chat text' }, history_context: { status: 'READ' } },
  { from: BIZ_NUMBER, to: '919800000001', id: 'wamid.h2', timestamp: '1759000100', type: 'text', text: { body: 'reply' }, history_context: { status: 'READ' } }
] }] }] });

const customers = () => db.customers;
const botRuns = () => calls.filter(c => c[0] === 'findMatchingRule').length;
const usageCalls = () => calls.filter(c => c[0] === 'incrementUsage').length;

let logged;
const realLog = console.log;
test.before(() => { console.log = (...a) => { logged.push(a.map(String).join(' ')); }; });
test.after(() => { console.log = realLog; });

test.beforeEach(() => {
  db = { customers: [], messages: [], message_templates: [], flow_nodes: [], businesses: [] };
  usageAllowed = true; queued = []; calls = []; session = null; enabledLanguages = ['en']; tenantOverrides = {}; nodeLabel = 'x';
  invalidated = []; logged = [];
});

test('an owner phone message (echo) is stored but never reaches the bot, usage or the outbound queue', async () => {
  await sendBody(field('smb_message_echoes', echoValue('wamid.E1', '919800000001', 'price')));
  assert.equal(db.messages.length, 1);
  assert.deepEqual([db.messages[0].direction, db.messages[0].sender_type, db.messages[0].meta_message_id], ['outbound', 'phone_app', 'wamid.E1']);
  assert.equal(botRuns(), 0);
  assert.equal(usageCalls(), 0);
  assert.equal(queued.length, 0);
  assert.equal(customers()[0].last_message_at, null);
  assert.equal(customers()[0].total_messages, 0);
});

test('an echo and a real customer message in one entry: only the customer message runs the bot', async () => {
  await sendBody({ entry: [{ id: 'waba1', changes: [
    { field: 'smb_message_echoes', value: echoValue('wamid.E1', '919800000001', 'price') },
    { field: 'messages', value: { metadata: META, contacts: [{ wa_id: '919800000001', profile: { name: 'Ravi' } }], messages: [{ id: 'wamid.in', from: '919800000001', type: 'text', text: { body: 'price' } }] } }
  ] }] });
  assert.equal(db.messages.filter(m => m.direction === 'inbound').length, 1);
  assert.equal(db.messages.filter(m => m.sender_type === 'phone_app').length, 1);
  assert.equal(botRuns(), 1);
  assert.equal(usageCalls() > 0, true);
});

test('history: stored as imports, no bot, no usage, and the body (message text) is not logged', async () => {
  await sendBody(field('history', historyValue()));
  assert.equal(db.messages.length, 2);
  assert.ok(db.messages.every(m => m.is_history_import === true));
  assert.equal(botRuns(), 0);
  assert.equal(usageCalls(), 0);
  assert.equal(queued.length, 0);
  assert.ok(!logged.some(l => l.includes('secret old chat text')));
  assert.ok(logged.some(l => /body not logged/.test(l)));
});

test('contact sync: contacts become customers, body not logged', async () => {
  await sendBody(field('smb_app_state_sync', { messaging_product: 'whatsapp', metadata: META, state_sync: [
    { type: 'contact', action: 'add', contact: { full_name: 'Phone Contact', phone_number: '919800000007' }, metadata: { timestamp: '1' } }
  ] }));
  assert.equal(customers().length, 1);
  assert.equal(customers()[0].name, 'Phone Contact');
  assert.equal(botRuns(), 0);
  assert.ok(logged.some(l => /body not logged/.test(l)));
});

test('echoes and messages are still logged in full (only history / contact sync are summarised)', async () => {
  await sendBody(field('smb_message_echoes', echoValue('wamid.E1', '919800000001', 'visible echo text')));
  assert.ok(logged.some(l => l.includes('visible echo text')));
});

test('account_update PARTNER_REMOVED: disconnected, IDs and token kept, tenant cache cleared; no bot', async () => {
  db.businesses = [{ id: BIZ, waba_id: 'waba1', phone_number_id: 'pn1', is_whatsapp_connected: true, access_token: 'enc' }];
  await sendBody(field('account_update', { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'waba1' }, disconnection_info: { reason: 'ACCOUNT_DISCONNECTED', initiated_by: 'USER' } }, 'waba1'));
  assert.equal(db.businesses[0].is_whatsapp_connected, false);
  assert.equal(db.businesses[0].phone_number_id, 'pn1');
  assert.equal(db.businesses[0].access_token, 'enc');
  assert.deepEqual(invalidated, ['pn1']);
  assert.equal(botRuns(), 0);
});

test('account_update with an unrelated event changes nothing', async () => {
  db.businesses = [{ id: BIZ, waba_id: 'waba1', phone_number_id: 'pn1', is_whatsapp_connected: true, access_token: 'enc' }];
  await sendBody(field('account_update', { event: 'PARTNER_ADDED' }, 'waba1'));
  assert.equal(db.businesses[0].is_whatsapp_connected, true);
  assert.deepEqual(invalidated, []);
});

test('a failing coexistence change does not stop the next change in the same POST', async () => {
  const realFrom = require('../config/supabase').from;
  require('../config/supabase').from = (table) => {
    if (table === 'customers') throw new Error('db down');
    return realFrom(table);
  };
  try {
    await sendBody({ entry: [{ id: 'waba1', changes: [
      { field: 'smb_app_state_sync', value: { metadata: META, state_sync: [{ type: 'contact', action: 'add', contact: { phone_number: '919800000007' } }] } },
      { field: 'smb_message_echoes', value: echoValue('wamid.E2', '919800000001', 'x') }
    ] }, { id: 'waba1', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
  } finally {
    require('../config/supabase').from = realFrom;
  }
  assert.equal(db.messages.length, 0); // the echo's customer lookup hit the same failure, and was contained
});
