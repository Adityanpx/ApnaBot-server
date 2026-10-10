// Run: node --test src/services/marketingBlock.service.test.js
// customers.marketing_blocked_at: the first stamp wins, a write names one business
// and one customer, an unknown customer matches nothing, a resume only clears an
// older stamp, and a database error never escapes. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let failWith; let writes;

const from = (table) => {
  const filters = []; let payload;
  const matching = () => db[table].filter((r) => filters.every((f) => f(r)));
  const q = {
    update: (p) => { payload = p; return q; },
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    lt: (c, v) => { filters.push((r) => r[c] != null && new Date(r[c]).getTime() < new Date(v).getTime()); return q; },
    then: (resolve, reject) => {
      if (failWith === 'throw') return Promise.reject(new Error('db down')).then(resolve, reject);
      if (failWith) return Promise.resolve({ error: { message: failWith } }).then(resolve, reject);
      const hit = matching();
      writes.push(hit.length);
      hit.forEach((r) => Object.assign(r, payload));
      return Promise.resolve({ error: null }).then(resolve, reject);
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const svc = require('./marketingBlock.service');

const cust = (id) => db.customers.find((c) => c.id === id);
const T1 = '2026-10-10T10:00:00.000Z';
const T2 = '2026-10-10T11:00:00.000Z';

test.beforeEach(() => {
  failWith = null; writes = [];
  db = { customers: [
    { id: 'c1', business_id: 'b1', whatsapp_number: '911', marketing_blocked_at: null },
    { id: 'c2', business_id: 'b1', whatsapp_number: '912', marketing_blocked_at: null },
    { id: 'x1', business_id: 'b2', whatsapp_number: '911', marketing_blocked_at: null }
  ] };
});

test('only Meta code 131050 means the customer stopped marketing messages', () => {
  assert.equal(svc.isMarketingStoppedCode(131050), true);
  assert.equal(svc.isMarketingStoppedCode('131050'), true);
  assert.equal(svc.isMarketingStoppedCode(131049), false);
  assert.equal(svc.isMarketingStoppedCode(131042), false);
  assert.equal(svc.isMarketingStoppedCode(null), false);
});

test('block by customer id stamps that customer only', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T1 });
  assert.equal(cust('c1').marketing_blocked_at, T1);
  assert.equal(cust('c2').marketing_blocked_at, null);
  assert.equal(cust('x1').marketing_blocked_at, null);
});

test('block by number is scoped to the business: the same number elsewhere is untouched', async () => {
  await svc.blockMarketing({ businessId: 'b1', whatsappNumber: '911', at: T1 });
  assert.equal(cust('c1').marketing_blocked_at, T1);
  assert.equal(cust('x1').marketing_blocked_at, null);
});

test('a customer id from another business matches nothing', async () => {
  await svc.blockMarketing({ businessId: 'b2', customerId: 'c1', at: T1 });
  assert.equal(cust('c1').marketing_blocked_at, null);
});

test('the first stamp wins: a repeat changes nothing', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T1 });
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T2 });
  assert.equal(cust('c1').marketing_blocked_at, T1);
  assert.deepEqual(writes, [1, 0]);
});

test('an unknown customer or number matches nothing and nothing is created', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'nope', at: T1 });
  await svc.blockMarketing({ businessId: 'b1', whatsappNumber: '999', at: T1 });
  assert.equal(db.customers.length, 3);
  assert.ok(db.customers.every((c) => c.marketing_blocked_at === null));
});

test('without a business or without a customer to name, nothing is written', async () => {
  await svc.blockMarketing({ customerId: 'c1' });
  await svc.blockMarketing({ businessId: 'b1' });
  assert.deepEqual(writes, []);
});

test('resume clears an older stamp', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T1 });
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c1', at: T2 });
  assert.equal(cust('c1').marketing_blocked_at, null);
});

test('resume does not clear a newer (or equal) stamp: an out-of-order resume cannot undo a newer stop', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T2 });
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c1', at: T1 });
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c1', at: T2 });
  assert.equal(cust('c1').marketing_blocked_at, T2);
});

test('resume is scoped to the business and to a customer who was stopped', async () => {
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1', at: T1 });
  await svc.resumeMarketing({ businessId: 'b2', customerId: 'c1', at: T2 });
  assert.equal(cust('c1').marketing_blocked_at, T1);
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c2', at: T2 });
  assert.equal(cust('c2').marketing_blocked_at, null);
});

test('a database error is logged, never thrown', async () => {
  failWith = 'boom';
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1' });
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c1' });
  failWith = 'throw';
  await svc.blockMarketing({ businessId: 'b1', customerId: 'c1' });
  await svc.resumeMarketing({ businessId: 'b1', customerId: 'c1' });
});
