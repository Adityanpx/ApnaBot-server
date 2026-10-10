// Run: node --test src/controllers/message.controller.sentBy.test.js
// POST /api/messages/send and /send-payment-qr stamp who sent the message:
// sent_by_user_id always, sent_by_name = the sender's name, or 'ApnaBot Support'
// for a superadmin. The history endpoint returns them as sentByName / sentByUserId.
const test = require('node:test');
const assert = require('node:assert/strict');

const inserts = [];
const queued = [];
let historyRows = [];

const supabase = {
  from: (table) => {
    const q = {
      insert: (row) => { inserts.push({ table, row }); q._row = row; return q; },
      update: () => q,
      select: () => q, eq: () => q, order: () => q,
      single: async () => ({ data: { id: 'm1', ...q._row }, error: null }),
      range: async () => ({ data: historyRows, error: null, count: historyRows.length }),
      maybeSingle: async () => ({
        data: { id: 'c1', whatsapp_number: '919800000001', last_message_at: new Date().toISOString(), bot_paused_until: null },
        error: null
      }),
      then: (resolve) => resolve({ data: null, error: null })
    };
    return q;
  }
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', supabase);
stub('../services/business.service', {
  getBusinessById: async () => ({ id: 'b1', isWhatsappConnected: true, phoneNumberId: 'p1', accessToken: 'tok', paymentQrUrl: 'https://qr/x.png' })
});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => { queued.push(job); } });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', { advancePipelineStage: async () => {} });
stub('../services/payment.service', { buildPaymentQrCaption: () => 'Pay by QR' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { sendMessage, sendPaymentQr, getChatHistory, SUPPORT_SENDER_NAME } = require('./message.controller');

const run = async (handler, req) => {
  let body;
  const res = { status() { return this; }, json(b) { body = b; return this; } };
  await handler(req, res, (e) => { throw e; });
  return body;
};
const userOf = (role, name) => ({ userId: 'u1', businessId: 'b1', role, name });
const lastInsert = () => inserts[inserts.length - 1].row;

test('an owner send is stamped with the owner id and name', async () => {
  const body = await run(sendMessage, { body: { customerNumber: '919800000001', message: ' hi ' }, user: userOf('owner', 'Suresh') });
  assert.equal(lastInsert().sender_type, 'human');
  assert.equal(lastInsert().sent_by_user_id, 'u1');
  assert.equal(lastInsert().sent_by_name, 'Suresh');
  assert.equal(body.data.sentByName, 'Suresh');
  assert.equal(body.data.sentByUserId, 'u1');
});

test('a superadmin send shows as ApnaBot Support but keeps the user id', async () => {
  await run(sendMessage, { body: { customerNumber: '919800000001', message: 'hello' }, user: userOf('superadmin', 'Platform Person') });
  assert.equal(SUPPORT_SENDER_NAME, 'ApnaBot Support');
  assert.equal(lastInsert().sent_by_name, 'ApnaBot Support');
  assert.equal(lastInsert().sent_by_user_id, 'u1');
});

test('a user with no name is stored with a NULL name, not "undefined"', async () => {
  await run(sendMessage, { body: { customerNumber: '919800000001', message: 'hello' }, user: userOf('owner', undefined) });
  assert.equal(lastInsert().sent_by_name, null);
});

test('the payment QR send is stamped the same way', async () => {
  await run(sendPaymentQr, { body: { customerNumber: '919800000001' }, user: userOf('owner', 'Suresh') });
  assert.equal(lastInsert().type, 'image');
  assert.equal(lastInsert().sent_by_user_id, 'u1');
  assert.equal(lastInsert().sent_by_name, 'Suresh');
  await run(sendPaymentQr, { body: { customerNumber: '919800000001' }, user: userOf('superadmin', 'Platform Person') });
  assert.equal(lastInsert().sent_by_name, 'ApnaBot Support');
});

test('the stamp is not part of the job queued for WhatsApp', async () => {
  queued.length = 0;
  await run(sendMessage, { body: { customerNumber: '919800000001', message: 'hello' }, user: userOf('owner', 'Suresh') });
  assert.equal(queued.length, 1);
  assert.equal(JSON.stringify(queued[0]).includes('Suresh'), false);
});

test('history returns the sender on new rows and null on old ones', async () => {
  historyRows = [
    { id: 'm2', sender_type: 'human', sent_by_user_id: 'u1', sent_by_name: 'Suresh' },
    { id: 'm1', sender_type: 'bot', sent_by_user_id: null, sent_by_name: null }
  ];
  const body = await run(getChatHistory, { params: { customerId: 'c1' }, query: {}, user: { businessId: 'b1' } });
  const [oldRow, newRow] = body.data.messages;
  assert.equal(oldRow.sentByName, null);
  assert.equal(oldRow.sentByUserId, null);
  assert.equal(newRow.sentByName, 'Suresh');
  assert.equal(newRow.sentByUserId, 'u1');
});
