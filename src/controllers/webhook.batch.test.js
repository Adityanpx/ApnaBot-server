// Run: node --test src/controllers/webhook.batch.test.js
// receiveWebhook with batched payloads: several entries, several changes per
// entry, several messages per change - each handled on its own, and one failing
// never drops the rest. In-memory Supabase, every service / queue stubbed.
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
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve({ data: run(), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { META_APP_SECRET: SECRET, FRONTEND_URL: 'https://app.test' });
// apply_message_statuses (the status webhook's RPC), reduced to what this file needs: read.
const rpc = async (name, args) => {
  const changed = [];
  for (const ev of args.p_events) {
    const r = (db.messages || []).find((x) => x.meta_message_id === ev.wamid);
    if (r && ev.status === 'read' && ['sent', 'delivered'].includes(r.status)) { r.status = 'read'; changed.push({ ...r }); }
  }
  return { data: { changed, unmatched: [] }, error: null };
};
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



const sendBody = async (body) => {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  const res = { status() { return this; }, json() {} };
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, res);
};

const msg = (id, from, body) => ({ id, from, type: 'text', text: { body } });
const change = (messages, contacts, phoneNumberId = 'pn1') => ({
  field: 'messages',
  value: { metadata: { phone_number_id: phoneNumberId }, contacts, messages }
});
const contact = (waId, name) => ({ wa_id: waId, profile: { name } });
const inbound = () => db.messages.filter(m => m.direction === 'inbound');
const botRuns = () => calls.filter(c => c[0] === 'findMatchingRule').length;

test.beforeEach(() => {
  db = { customers: [], messages: [], message_templates: [], flow_nodes: [] };
  usageAllowed = true; queued = []; calls = []; session = null; enabledLanguages = ['en']; tenantOverrides = {}; nodeLabel = 'x';
});

test('several messages in one change: every one is saved and handled, each with its own sender name', async () => {
  await sendBody({ entry: [{ id: 'waba', changes: [change(
    [msg('wamid.1', '919800000001', 'price'), msg('wamid.2', '919800000002', 'price'), msg('wamid.3', '919800000001', 'price')],
    [contact('919800000001', 'Ravi'), contact('919800000002', 'Sita')]
  )] }] });
  assert.deepEqual(inbound().map(m => m.meta_message_id), ['wamid.1', 'wamid.2', 'wamid.3']);
  assert.equal(botRuns(), 3);
  const names = Object.fromEntries(db.customers.map(c => [c.whatsapp_number, c.name]));
  assert.deepEqual(names, { 919800000001: 'Ravi', 919800000002: 'Sita' });
});

test('several changes in one entry, and several entries: all processed in order', async () => {
  await sendBody({ entry: [
    { id: 'waba1', changes: [change([msg('wamid.a', '919800000001', 'price')], [contact('919800000001', 'A')]), change([msg('wamid.b', '919800000001', 'price')], [contact('919800000001', 'A')])] },
    { id: 'waba2', changes: [change([msg('wamid.c', '919800000002', 'price')], [contact('919800000002', 'C')])] }
  ] });
  assert.deepEqual(inbound().map(m => m.meta_message_id), ['wamid.a', 'wamid.b', 'wamid.c']);
});

test('one failing change never drops the others', async () => {
  const realFrom = require('../config/supabase').from;
  require('../config/supabase').from = (table) => {
    if (table === 'messages') {
      const q = realFrom(table);
      const insert = q.insert;
      q.insert = (p) => { if (p.meta_message_id === 'wamid.boom') throw new Error('db down'); return insert(p); };
      return q;
    }
    return realFrom(table);
  };
  try {
    await sendBody({ entry: [{ id: 'waba', changes: [change(
      [msg('wamid.ok1', '919800000001', 'price'), msg('wamid.boom', '919800000002', 'price'), msg('wamid.ok2', '919800000003', 'price')],
      []
    )] }] });
  } finally {
    require('../config/supabase').from = realFrom;
  }
  assert.deepEqual(inbound().map(m => m.meta_message_id), ['wamid.ok1', 'wamid.ok2']);
});

test('a single message payload behaves exactly as before', async () => {
  await sendBody({ entry: [{ id: 'waba', changes: [change([msg('wamid.solo', '919800000001', 'price')], [contact('919800000001', 'Ravi')])] }] });
  assert.equal(inbound().length, 1);
  assert.equal(botRuns(), 1);
  assert.equal(db.customers[0].name, 'Ravi');
});

test('odd payloads are tolerated: no entry, no changes, empty arrays, a change with no value', async () => {
  for (const body of [{}, { entry: [] }, { entry: [{ id: 'w' }] }, { entry: [{ id: 'w', changes: [] }] }, { entry: [{ id: 'w', changes: [{ field: 'messages' }] }] }, { entry: 'nope' }]) {
    await sendBody(body);
  }
  assert.equal(inbound().length, 0);
});

test('a status update and a message in the same entry: both handled', async () => {
  db.messages.push({ id: 'out1', business_id: BIZ, direction: 'outbound', meta_message_id: 'wamid.out', status: 'sent' });
  await sendBody({ entry: [{ id: 'waba', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'pn1' }, statuses: [{ id: 'wamid.out', status: 'read' }] } },
    change([msg('wamid.in', '919800000001', 'price')], [contact('919800000001', 'Ravi')])
  ] }] });
  assert.equal(db.messages.find(m => m.id === 'out1').status, 'read');
  assert.equal(inbound().length, 1);
});
