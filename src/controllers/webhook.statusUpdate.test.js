// Run: node --test src/controllers/webhook.statusUpdate.test.js
// Meta's message status webhooks (sent / delivered / read / failed) against outbound
// rows that now carry their wamid: matched by meta_message_id, applied forward
// only, announced to the dashboard. In-memory Supabase, services stubbed.
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




const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};
const status = (id, s) => sendBody({ entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, statuses: [{ id, status: s, recipient_id: '919800000001' }] } }] }] });
const row = () => db.messages[0];

let socketEvents;
const realEmit = require('../services/socket.service').emitToBusiness;
test.before(() => { require('../services/socket.service').emitToBusiness = (id, ev, data) => { socketEvents.push([ev, data]); }; });
test.after(() => { require('../services/socket.service').emitToBusiness = realEmit; });

test.beforeEach(() => {
  db = { customers: [], messages: [{ id: 'row1', business_id: BIZ, direction: 'outbound', sender_type: 'bot', status: 'sent', meta_message_id: 'wamid.OUT1' }], message_templates: [], flow_nodes: [] };
  usageAllowed = true; queued = []; calls = []; session = null; enabledLanguages = ['en']; tenantOverrides = {}; nodeLabel = 'x';
  socketEvents = [];
});

test('a bot message with its wamid saved now gets delivered, then read, and the dashboard is told', async () => {
  await status('wamid.OUT1', 'delivered');
  assert.equal(row().status, 'delivered');
  await status('wamid.OUT1', 'read');
  assert.equal(row().status, 'read');
  assert.deepEqual(socketEvents.map(e => [e[0], e[1].status]), [['message_status', 'delivered'], ['message_status', 'read']]);
  assert.equal(socketEvents[0][1].messageId, 'row1');
});

test('read can arrive without a delivered event first', async () => {
  await status('wamid.OUT1', 'read');
  assert.equal(row().status, 'read');
});

test('never backwards: a late delivered or sent after read changes nothing and says nothing', async () => {
  row().status = 'read';
  await status('wamid.OUT1', 'delivered');
  await status('wamid.OUT1', 'sent');
  assert.equal(row().status, 'read');
  assert.equal(socketEvents.length, 0);
});

test('a repeated delivered is a no-op', async () => {
  await status('wamid.OUT1', 'delivered');
  await status('wamid.OUT1', 'delivered');
  assert.equal(socketEvents.length, 1);
});

test('failed applies to a message that never got delivered, not to one that did', async () => {
  await status('wamid.OUT1', 'failed');
  assert.equal(row().status, 'failed');
  row().status = 'delivered';
  await status('wamid.OUT1', 'failed');
  assert.equal(row().status, 'delivered');
});

test('a status that is not stored (deleted, warning) is ignored, not an error', async () => {
  await status('wamid.OUT1', 'deleted');
  await status('wamid.OUT1', 'warning');
  assert.equal(row().status, 'sent');
  assert.equal(socketEvents.length, 0);
});

test('an unknown wamid (a message sent before ids were saved) matches nothing and is harmless', async () => {
  await status('wamid.NOPE', 'delivered');
  assert.equal(row().status, 'sent');
  assert.equal(socketEvents.length, 0);
});
