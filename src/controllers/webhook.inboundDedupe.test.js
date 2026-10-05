// Run: node --test src/controllers/webhook.inboundDedupe.test.js
// receiveWebhook's duplicate-delivery gate: one WhatsApp id delivered twice
// (an 'unsupported' placeholder and the real message, either order, or a plain
// retry). In-memory Supabase, every service / queue stubbed.
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

let usageAllowed; let db; let queued; let calls; let session; let enabledLanguages; let tenantOverrides; let nodeLabel;

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
stub('../queues/whatsapp.queue', {
  addToWhatsappQueue: async (job) => { queued.push(job); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(job); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
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


const W = 'wamid.SAME';
const text = (body, id = W) => send({ id, type: 'text', text: { body } });
const unsupported = (id = W) => send({ id, type: 'unsupported', errors: [{ code: 131051, title: 'Unsupported message type' }] });
const customer = () => db.customers.find(c => c.whatsapp_number === NUMBER);
const inbound = () => db.messages.filter(m => m.direction === 'inbound');
const botRuns = () => calls.filter(c => c[0] === 'findMatchingRule').length;
const inboundUsage = () => calls.filter(c => c[0] === 'incrementUsage' && c[1] === 'inbound').length;

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: [], message_templates: [], flow_nodes: []
  };
  usageAllowed = true; queued = []; calls = []; session = null; enabledLanguages = ['en']; tenantOverrides = {}; nodeLabel = 'x';
});

test('lone unsupported: stored with a readable label and the raw payload; counted once; no bot', async () => {
  await unsupported();
  assert.equal(inbound().length, 1);
  assert.equal(inbound()[0].type, 'unsupported');
  assert.match(inbound()[0].content, /couldn't be displayed.*error 131051/);
  assert.equal(inbound()[0].raw_payload.errors[0].code, 131051);
  assert.equal(customer().total_messages, 4);
  assert.equal(inboundUsage(), 1);
  assert.equal(botRuns(), 0);
});

test('real after unsupported: the row is replaced, processed once, nothing counted twice', async () => {
  await unsupported();
  await text('price');
  assert.equal(inbound().length, 1);
  assert.equal(inbound()[0].type, 'text');
  assert.equal(inbound()[0].content, 'price');
  assert.equal(inbound()[0].raw_payload, null);
  assert.equal(customer().total_messages, 4); // only the first delivery counted
  assert.equal(inboundUsage(), 1);
  assert.equal(botRuns(), 1);
  await text('price'); // and a later retry is a no-op
  assert.equal(inbound().length, 1);
  assert.equal(botRuns(), 1);
});

test('unsupported after real: ignored entirely', async () => {
  await text('price');
  const total = customer().total_messages;
  await unsupported();
  assert.equal(inbound().length, 1);
  assert.equal(inbound()[0].type, 'text');
  assert.equal(customer().total_messages, total);
  assert.equal(inboundUsage(), 1);
  assert.equal(botRuns(), 1);
});

test('unsupported after unsupported, and a plain retry of a real message: ignored', async () => {
  await unsupported();
  await unsupported();
  assert.equal(inbound().length, 1);
  assert.equal(customer().total_messages, 4);
  assert.equal(inboundUsage(), 1);

  await text('hello', 'wamid.OTHER');
  await text('hello', 'wamid.OTHER');
  assert.equal(inbound().length, 2);
  assert.equal(inboundUsage(), 2);
});

test('a different id is never a duplicate', async () => {
  await text('price', 'wamid.A');
  await text('price', 'wamid.B');
  assert.equal(inbound().length, 2);
  assert.equal(botRuns(), 2);
});
