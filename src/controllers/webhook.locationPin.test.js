// Run: node --test src/controllers/webhook.locationPin.test.js
// A reply node of content type 'location' sends a map pin. The chat row used to be saved
// with empty text; it now holds the pin's label ("📍 name · address"), or the fallback
// text when no coordinates are configured. The queue job is unchanged, and no
// coordinates are stored on the row. In-memory Supabase, everything else stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BIZ = 'b1';
const NUMBER = '919800000001';
const SECRET = 'test-secret';

let db; let queued; let business; let node; let businessError;

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
  addToWhatsappQueue: async (job) => { queued.push(JSON.stringify(job)); },
  addToWhatsappQueueAndWait: async (job) => { queued.push(JSON.stringify(job)); }
});
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/tenant.service', {
  resolveBusinessByPhoneNumberId: async () => ({
    businessId: BIZ, isActive: true, subscription: { status: 'active' }, plan: { msg_limit: 500 },
    phoneNumberId: 'pn1', accessToken: 'tok', displayName: 'Biz', businessName: 'Biz'
  })
});
stub('../services/usage.service', { checkUsageLimit: async () => ({ allowed: true, current: 0, limit: 500 }), incrementUsage: async () => {} });
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', {
  getBusinessById: async () => { if (businessError) throw businessError; return business; }
});
stub('../services/booking.service', {
  getBookingSession: async () => null, deleteBookingSession: async () => {}, saveBookingSession: async () => {},
  recordBookingLead: async () => {}, finalizeGraphBooking: async () => ({ text: 'done' }), normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {});
stub('../services/chatbot.service', {
  findMatchingRule: async (businessId, text) => (text === 'where' ? { node, edges: [] } : null),
  resolveTappedEdge: async () => null,
  getOutgoingEdges: async () => []
});
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});

const { receiveWebhook } = require('./webhook.controller');
const { getSystemMessage } = require('../utils/systemMessages');

const say = async (text) => {
  const body = {
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'pn1' }, contacts: [{ profile: { name: 'Ravi' } }],
      messages: [{ id: `wamid.${Math.random()}`, from: NUMBER, type: 'text', text: { body: text } }]
    } }] }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
  await receiveWebhook({ body, rawBody, headers: { 'x-hub-signature-256': signature } }, { status() { return this; }, json() {} });
};
const botRow = () => db.messages.find(m => m.direction === 'outbound');

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', total_messages: 3, preferred_language: 'en', is_blocked: false, bot_paused_until: null, opted_out_at: null }],
    messages: []
  };
  queued = []; businessError = null;
  business = { id: BIZ, enabledLanguages: ['en'], name: 'SG Travels', displayName: null, address: 'MG Road, Pune', businessLatitude: 18.52, businessLongitude: 73.85 };
  node = { id: 'n1', contentType: 'location', replyKind: 'text', isActive: true, label: '', latitude: null, longitude: null, locationName: null, address: null };
});

const PIN = (location) => JSON.stringify({ businessId: BIZ, phoneNumberId: 'pn1', encryptedAccessToken: 'tok', to: NUMBER, messageId: 'messages-2', location });

test("a node's own pin: the row says '📍 name · address', the job carries the coordinates", async () => {
  Object.assign(node, { latitude: 19.07, longitude: 72.87, locationName: 'Mumbai office', address: 'Fort, Mumbai' });
  await say('where');
  assert.equal(botRow().content, '📍 Mumbai office · Fort, Mumbai');
  assert.equal(botRow().type, 'text');
  assert.deepEqual(queued, [PIN({ latitude: 19.07, longitude: 72.87, name: 'Mumbai office', address: 'Fort, Mumbai' })]);
});

test('a node pin with no name or address: "📍 Location"', async () => {
  Object.assign(node, { latitude: 19.07, longitude: 72.87 });
  await say('where');
  assert.equal(botRow().content, '📍 Location');
  assert.deepEqual(queued, [PIN({ latitude: 19.07, longitude: 72.87 })]);
});

test("no node pin: the business's saved location, labelled with its name and address", async () => {
  await say('where');
  assert.equal(botRow().content, '📍 SG Travels · MG Road, Pune');
  assert.deepEqual(queued, [PIN({ latitude: 18.52, longitude: 73.85, name: 'SG Travels', address: 'MG Road, Pune' })]);
});

test('only one of latitude / longitude on the node: falls back to the business location', async () => {
  Object.assign(node, { latitude: 19.07 });
  await say('where');
  assert.equal(botRow().content, '📍 SG Travels · MG Road, Pune');
});

test('no coordinates anywhere: the row holds the fallback text that was sent', async () => {
  business = { ...business, businessLatitude: null, businessLongitude: null };
  await say('where');
  const fallback = getSystemMessage('locationNotConfigured', 'en');
  assert.ok(fallback);
  assert.equal(botRow().content, fallback);
  assert.deepEqual(queued, [JSON.stringify({ businessId: BIZ, phoneNumberId: 'pn1', encryptedAccessToken: 'tok', to: NUMBER, message: fallback, type: 'text', messageId: 'messages-2' })]);
});

test('no coordinates are stored on the row, and it has no payload', async () => {
  Object.assign(node, { latitude: 19.07, longitude: 72.87, locationName: 'Mumbai office' });
  await say('where');
  const stored = JSON.stringify(botRow());
  assert.equal(stored.includes('19.07'), false);
  assert.equal(stored.includes('72.87'), false);
  assert.equal(botRow().interactive_payload ?? null, null);
});

test('the business lookup throwing: the row is still saved, the customer still gets a reply, nothing escapes', async () => {
  businessError = new Error('db down');
  await say('where');
  const fallback = getSystemMessage('locationNotConfigured', 'en');
  assert.equal(db.messages.filter(m => m.direction === 'outbound').length, 1);
  assert.equal(botRow().content, fallback);
  assert.equal(botRow().status, 'sent');
  assert.deepEqual(queued, [JSON.stringify({ businessId: BIZ, phoneNumberId: 'pn1', encryptedAccessToken: 'tok', to: NUMBER, message: fallback, type: 'text', messageId: 'messages-2' })]);
});

test("the node's own pin never reads the business, so a failing lookup cannot affect it", async () => {
  businessError = new Error('db down');
  Object.assign(node, { latitude: 19.07, longitude: 72.87, locationName: 'Mumbai office' });
  await say('where');
  assert.equal(botRow().content, '📍 Mumbai office');
  assert.equal(queued.length, 1);
});
