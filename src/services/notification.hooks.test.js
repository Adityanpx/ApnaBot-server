// Run: node --test src/services/notification.hooks.test.js
// One test per push-notification hook: the real service code runs against an
// in-memory Supabase and notification.service is a recorder, so each test checks
// that the right notify / notifyOnce call (type, ids, dedupe key) is made.
//   booking_new         booking.service#createBookingAndConfirmation
//   payment_received    payment.service#setBookingPaymentStatus
//   usage_90 / usage_100  usage.service#checkUsageLimit
//   payment_issue       accountHealth.service#recordPaymentIssue
//   whatsapp_disconnected  coexistence.service#handleAccountUpdate
//   plan_expired / plan_expiring  subscription.service#runExpiryCheck, subscriptionNotifications.service
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let calls; let hash;

const from = (table) => {
  const filters = []; let op = 'select'; let payload; let single = false;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(row); return [row]; }
    if (op === 'update') { const m = matching(); m.forEach((r) => Object.assign(r, payload)); return m; }
    return matching().map((r) => ({ ...r })); // copies, like PostgREST: a later update must not change an earlier read
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    neq: (c, v) => { filters.push((r) => r[c] !== v); return q; },
    is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
    gt: (c, v) => { filters.push((r) => r[c] > v); return q; },
    gte: (c, v) => { filters.push((r) => r[c] >= v); return q; },
    lt: (c, v) => { filters.push((r) => r[c] < v); return q; },
    lte: (c, v) => { filters.push((r) => r[c] <= v); return q; },
    order: () => q,
    limit: () => q,
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    single: () => { single = true; return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve, reject) => {
      const data = run();
      return Promise.resolve({ data: single ? data[0] : data, error: null }).then(resolve, reject);
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { FRONTEND_URL: 'https://app.test', RAZORPAY_WEBHOOK_SECRET: 'x', ECHO_AUTO_PAUSE: false });
stub('../config/supabase', { from });
stub('../config/redis', {
  hincrby: async () => {}, ttl: async () => 100, expire: async () => {},
  hget: async (key, field) => (hash.get(key) || {})[field] ?? null,
  get: async () => null, set: async () => 'OK', del: async () => {}
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('./notification.service', {
  notify: (...args) => { calls.push(['notify', ...args]); },
  notifyOnce: async (...args) => { calls.push(['notifyOnce', ...args]); },
  notifyNewMessage: async (...args) => { calls.push(['notifyNewMessage', ...args]); }
});
stub('./socket.service', { emitToBusiness: () => {} });
stub('./tenant.service', { invalidateTenantCache: async () => {} });
stub('./whatsapp.service', {});
stub('../utils/crypto', { encrypt: (v) => v, decrypt: (v) => v });
stub('./r2.service', {});
stub('./customerPipeline.service', { advancePipelineStage: async () => {} });
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', name: 'Search cab', businessCategory: 'travels', isWhatsappConnected: false, requireAdvancePayment: false }) });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./distanceMatrix.service', {});

const usageService = require('./usage.service');
const accountHealth = require('./accountHealth.service');
const coexistence = require('./coexistence.service');
const paymentService = require('./payment.service');
const bookingService = require('./booking.service');
const subscriptionService = require('./subscription.service');
const subscriptionNotifications = require('./subscriptionNotifications.service');

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const only = (kind) => calls.filter((c) => c[0] === kind);

test.beforeEach(() => { db = {}; calls = []; hash = new Map(); });

test('booking_new: after a booking row is created (chat or web form), with who / what / when', async () => {
  db.customers = [{ id: 'c1', business_id: 'b1', whatsapp_number: '9198', name: 'Ravi', preferred_language: 'en' }];
  db.bookings = [];
  await bookingService.createBookingAndConfirmation('b1', '9198', { vehicleName: 'Innova', travelDate: '20 Oct', tripType: 'One Way' }, [], false);
  assert.equal(db.bookings.length, 1);
  const [, businessId, type, payload] = only('notify')[0];
  assert.equal(businessId, 'b1');
  assert.equal(type, 'booking_new');
  assert.deepEqual(payload, { bookingId: db.bookings[0].id, customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', summary: 'Innova', date: '20 Oct' });
});

test('booking_new: not sent when the booking could not be created', async () => {
  db.customers = [];
  await assert.rejects(bookingService.createBookingAndConfirmation('b1', '9198', {}, [], false));
  assert.equal(only('notify').length, 0);
});

test('payment_received: when a booking payment is marked paid, with the amount and customer name, excluding the person who marked it; not again, not for "pending"', async () => {
  db.customers = [{ id: 'c1', business_id: 'b1', name: 'Ravi' }];
  db.bookings = [{ id: 'bk1', business_id: 'b1', customer_id: 'c1', customer_number: '9198', status: 'pending', payment_status: 'pending', payment_amount: 500, payment_details: { requestedVia: 'advance' } }];
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid', 'u-actor');
  const notes = only('notify');
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].slice(1), ['b1', 'payment_received', { bookingId: 'bk1', customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', amount: 500 }, { excludeUserId: 'u-actor' }]);
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'paid'); // already paid
  await paymentService.setBookingPaymentStatus('b1', 'bk1', 'pending');
  assert.equal(only('notify').length, 1);
});

test('usage_90 / usage_100: checkUsageLimit raises the highest level reached, keyed by business and usage period', async () => {
  const sub = { start_date: '2026-10-01T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z', end_date: '2099-01-01T00:00:00.000Z', is_autopay: false };
  const periodStart = '2026-10-01T00:00:00.000Z';
  const used = async (n, limit = 100) => {
    calls = []; hash.set(`usage:b1:${periodStart}`, { used: String(n) });
    await usageService.checkUsageLimit('b1', limit, sub);
    await new Promise((r) => setImmediate(r));
    return only('notifyOnce');
  };
  assert.equal((await used(89)).length, 0);
  const at90 = await used(90);
  assert.deepEqual(at90[0].slice(1, 5), ['b1', 'usage_90', {}, `b1:${periodStart}`]);
  const at100 = await used(100);
  assert.equal(at100.length, 1);
  assert.equal(at100[0][2], 'usage_100');
  assert.equal((await used(500, -1)).length, 0); // unlimited plan
});

test('payment_issue: recording a Meta 131042 failure raises it, deduped per business for 24h', async () => {
  db.businesses = [{ id: 'b1', payment_issue_at: null, payment_issue_code: null }];
  await accountHealth.recordPaymentIssue('b1');
  assert.deepEqual(only('notifyOnce')[0].slice(1), ['b1', 'payment_issue', {}, 'b1', 86400]);
  assert.ok(db.businesses[0].payment_issue_at);
});

test('whatsapp_disconnected: an account_update that disconnects raises it; one that changes nothing does not', async () => {
  db.businesses = [{ id: 'b1', waba_id: '111', phone_number_id: 'pn1', is_whatsapp_connected: true, access_token: 'enc' }];
  const first = await coexistence.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_REMOVED' });
  assert.equal(first.action, 'disconnected');
  assert.deepEqual(only('notifyOnce')[0].slice(1), ['b1', 'whatsapp_disconnected', {}, 'b1', 86400]);
  calls = [];
  const again = await coexistence.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_REMOVED' });
  assert.equal(again.action, 'unchanged');
  assert.equal(calls.length, 0);
});

test('plan_expired: the daily cron raises it only when the expiry leaves the business without cover', async () => {
  db.businesses = [{ id: 'b1', is_active: true }, { id: 'b2', is_active: true }];
  db.subscriptions = [
    { id: 's1', business_id: 'b1', status: 'active', end_date: iso(-DAY) },
    { id: 's2', business_id: 'b2', status: 'active', end_date: iso(-DAY) },
    { id: 's2b', business_id: 'b2', status: 'active', end_date: iso(30 * DAY) } // b2 is still covered
  ];
  await subscriptionService.runExpiryCheck();
  await new Promise((r) => setImmediate(r));
  const expired = only('notifyOnce').filter((c) => c[2] === 'plan_expired');
  assert.equal(expired.length, 1);
  assert.deepEqual(expired[0].slice(1), ['b1', 'plan_expired', {}, 's1', 7 * 86400]);
});

test('plan_expiring: the daily notice goes to a plan ending within 3 days, once per subscription (key = subscription id)', async () => {
  db.subscriptions = [
    { id: 'soon', business_id: 'b1', status: 'active', is_autopay: false, end_date: iso(2 * DAY + 3600 * 1000) },
    { id: 'later', business_id: 'b2', status: 'active', is_autopay: false, end_date: iso(10 * DAY) },
    { id: 'auto', business_id: 'b3', status: 'active', is_autopay: true, end_date: iso(1 * DAY) },
    { id: 'renewed-a', business_id: 'b4', status: 'active', is_autopay: false, end_date: iso(1 * DAY) },
    { id: 'renewed-b', business_id: 'b4', status: 'active', is_autopay: false, end_date: iso(40 * DAY) }
  ];
  await subscriptionNotifications.sendPlanExpiringNotices();
  const sent = only('notifyOnce');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(1), ['b1', 'plan_expiring', { days: 3 }, 'soon', 4 * 86400]);
});
