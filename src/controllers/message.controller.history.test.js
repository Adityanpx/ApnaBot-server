// Run: node --test src/controllers/message.controller.history.test.js
// GET /api/messages/:customerId: each message carries delivery fields and a
// `failure` (null unless it failed) with the plain-words reason. Read-side only.
const test = require('node:test');
const assert = require('node:assert/strict');

const MESSAGES = [ // newest first, as the query returns them
  { id: 'm3', status: 'failed', error_code: 131026, error_title: 'Message undeliverable', error_details: 'd', failed_at: '2026-01-01T10:00:00Z' },
  { id: 'm2', status: 'read', delivered_at: '2026-01-01T09:00:00Z', read_at: '2026-01-01T09:05:00Z' },
  { id: 'm1', status: 'failed' } // failed before error columns existed
];
const supabase = {
  from: (table) => {
    const q = {
      select: () => q, eq: () => q, order: () => q,
      range: async () => ({ data: MESSAGES, error: null, count: MESSAGES.length }),
      maybeSingle: async () => ({ data: { id: 'c1', whatsapp_number: '919800000001' }, error: null })
    };
    return q;
  }
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', supabase);
stub('../services/business.service', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', {});
stub('../services/payment.service', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { getChatHistory } = require('./message.controller');

const call = async () => {
  let body;
  const res = { status() { return this; }, json(b) { body = b; return this; } };
  await getChatHistory({ params: { customerId: 'c1' }, query: {}, user: { businessId: 'b1' } }, res, (e) => { throw e; });
  return body;
};

test('messages come back oldest first with delivery times and a failure reason where one failed', async () => {
  const body = await call();
  const msgs = body.data.messages;
  assert.deepEqual(msgs.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.equal(msgs[1].failure, null);
  assert.equal(msgs[1].deliveredAt, '2026-01-01T09:00:00Z');
  assert.equal(msgs[1].readAt, '2026-01-01T09:05:00Z');
  assert.equal(msgs[2].failure.code, 131026);
  assert.match(msgs[2].failure.reason, /not be on WhatsApp/);
  assert.equal(msgs[2].failure.kind, 'recipient');
});

test('a message that failed before error codes were stored still says it failed', async () => {
  const old = (await call()).data.messages[0];
  assert.equal(old.failure.code, null);
  assert.match(old.failure.reason, /couldn't deliver/);
});
