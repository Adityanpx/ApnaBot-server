// Run: node --test src/services/payment.service.quote.test.js
// Marking a booking paid / pending (PUT /api/bookings/:id/payment) keeps its travel quote in step:
// paid -> quote 'paid' (+ paid_at), pending again -> back to 'accepted'. Only for a booking that has a
// quote_id, only the booking's own business's quote, only from the expected status; every other booking
// behaves exactly as before. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let notes;

const from = (table) => {
  const filters = []; let op = 'select'; let payload; let single = false;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'update') { const m = matching(); m.forEach((r) => Object.assign(r, payload)); return m; }
    return matching().map((r) => ({ ...r }));
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    single: () => { single = true; return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => { const data = run(); return Promise.resolve({ data: single ? data[0] : data, error: null }).then(resolve, reject); }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { FRONTEND_URL: 'https://app.test', RAZORPAY_WEBHOOK_SECRET: 'x', ECHO_AUTO_PAUSE: false });
stub('../config/supabase', { from });
stub('../config/redis', { get: async () => null, set: async () => 'OK', del: async () => {} });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('./notification.service', { notify: (...args) => { notes.push(args); }, notifyOnce: async () => {}, notifyNewMessage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./tenant.service', { invalidateTenantCache: async () => {} });
stub('./whatsapp.service', {});
stub('../utils/crypto', { encrypt: (v) => v, decrypt: (v) => v });
stub('./r2.service', {});
stub('./customerPipeline.service', { advancePipelineStage: async () => {} });
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', name: 'SG Travels', isWhatsappConnected: false }) });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./distanceMatrix.service', {});

const paymentService = require('./payment.service');

test.beforeEach(() => {
  notes = [];
  db = {
    customers: [{ id: 'c1', business_id: 'b1', name: 'Ravi' }],
    bookings: [
      { id: 'bk1', business_id: 'b1', customer_id: 'c1', customer_number: '9198', status: 'pending', payment_status: 'pending', payment_amount: 700, payment_details: { requestedVia: 'advance' }, quote_id: 'q1' },
      { id: 'bk2', business_id: 'b1', customer_id: 'c1', customer_number: '9198', status: 'pending', payment_status: 'pending', payment_amount: 500, payment_details: { requestedVia: 'advance' }, quote_id: null }
    ],
    travel_quotes: [
      { id: 'q1', business_id: 'b1', status: 'accepted', paid_at: null },
      { id: 'q2', business_id: 'b2', status: 'accepted', paid_at: null }
    ]
  };
});

const quote = (id) => db.travel_quotes.find((q) => q.id === id);

test('marking the booking paid marks its quote paid (with paid_at); the booking itself is confirmed as before', async () => {
  const updated = await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
  assert.equal(quote('q1').status, 'paid');
  assert.ok(quote('q1').paid_at);
  assert.equal(updated.status, 'confirmed');
  assert.equal(updated.paymentStatus, 'paid');
});

test('marking it paid twice leaves the quote paid with the same paid_at', async () => {
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
  const first = quote('q1').paid_at;
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
  assert.equal(quote('q1').status, 'paid');
  assert.equal(quote('q1').paid_at, first);
});

test('un-marking it (pending again) puts the quote back to accepted and clears paid_at', async () => {
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'pending', 'u1');
  assert.equal(quote('q1').status, 'accepted');
  assert.equal(quote('q1').paid_at, null);
});

test('marking pending a booking whose quote is not paid changes nothing', async () => {
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'pending', 'u1');
  assert.equal(quote('q1').status, 'accepted');
});

test('a booking with no quote touches no quote at all', async () => {
  await paymentService.setBookingPaymentStatus('b1', 'bk2', 'paid', 'u1');
  assert.deepEqual(db.travel_quotes.map((q) => q.status), ['accepted', 'accepted']);
});

test('a quote of another business is never touched, even if a booking pointed at it', async () => {
  db.bookings[0].quote_id = 'q2'; // inconsistent data: b1's booking, b2's quote
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
  assert.equal(quote('q2').status, 'accepted');
});

test('a quote that cannot be updated never fails the payment', async () => {
  const supabase = require('../config/supabase');
  const original = supabase.from;
  supabase.from = (table) => {
    if (table !== 'travel_quotes') return original(table);
    const q = { update: () => q, eq: () => q, then: (resolve) => resolve({ data: null, error: { message: 'down' } }) };
    return q;
  };
  try {
    const updated = await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u1');
    assert.equal(updated.paymentStatus, 'paid');
  } finally { supabase.from = original; }
});
