// Run: node --test src/services/accountHealth.service.test.js
// The payment-method flag on businesses (Meta 131042): first failure wins, only a
// send made after it can clear it, the owner can dismiss it, and a database error
// never escapes. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let failWith;

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
      matching().forEach((r) => Object.assign(r, payload));
      return Promise.resolve({ error: null }).then(resolve, reject);
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const svc = require('./accountHealth.service');

const biz = (id = 'b1') => db.businesses.find((b) => b.id === id);

test.beforeEach(() => {
  failWith = null;
  db = { businesses: [
    { id: 'b1', payment_issue_at: null, payment_issue_code: null },
    { id: 'b2', payment_issue_at: null, payment_issue_code: null }
  ] };
});

test('only Meta code 131042 is a payment issue', () => {
  assert.equal(svc.isPaymentIssueCode(131042), true);
  assert.equal(svc.isPaymentIssueCode('131042'), true);
  assert.equal(svc.isPaymentIssueCode(131050), false);
  assert.equal(svc.isPaymentIssueCode(null), false);
});

test('record sets the time and code on that business only', async () => {
  await svc.recordPaymentIssue('b1', '2026-10-10T10:00:00.000Z');
  assert.deepEqual([biz().payment_issue_at, biz().payment_issue_code], ['2026-10-10T10:00:00.000Z', 131042]);
  assert.equal(biz('b2').payment_issue_at, null);
});

test('a repeat record keeps the first time (since does not move)', async () => {
  await svc.recordPaymentIssue('b1', '2026-10-10T10:00:00.000Z');
  await svc.recordPaymentIssue('b1', '2026-10-11T10:00:00.000Z');
  assert.equal(biz().payment_issue_at, '2026-10-10T10:00:00.000Z');
});

test('a delivery of something sent after the problem clears it', async () => {
  await svc.recordPaymentIssue('b1', '2026-10-10T10:00:00.000Z');
  await svc.clearPaymentIssueIfSentAfter('b1', '2026-10-10T10:00:01.000Z');
  assert.deepEqual([biz().payment_issue_at, biz().payment_issue_code], [null, null]);
});

test('a delivery of something sent before (or at) the problem does not clear it', async () => {
  await svc.recordPaymentIssue('b1', '2026-10-10T10:00:00.000Z');
  await svc.clearPaymentIssueIfSentAfter('b1', '2026-10-10T09:59:59.000Z');
  await svc.clearPaymentIssueIfSentAfter('b1', '2026-10-10T10:00:00.000Z');
  assert.equal(biz().payment_issue_at, '2026-10-10T10:00:00.000Z');
});

test('clearing a business with no problem, or another business, changes nothing', async () => {
  await svc.recordPaymentIssue('b1', '2026-10-10T10:00:00.000Z');
  await svc.clearPaymentIssueIfSentAfter('b2', '2026-10-12T10:00:00.000Z');
  assert.equal(biz().payment_issue_at, '2026-10-10T10:00:00.000Z');
  assert.equal(biz('b2').payment_issue_at, null);
});

test('the owner dismiss clears it, for that business only', async () => {
  await svc.recordPaymentIssue('b1');
  await svc.recordPaymentIssue('b2');
  assert.equal(await svc.dismissPaymentIssue('b1'), true);
  assert.equal(biz().payment_issue_at, null);
  assert.notEqual(biz('b2').payment_issue_at, null);
});

test('a database error is logged, never thrown; dismiss reports false', async () => {
  failWith = 'boom';
  await svc.recordPaymentIssue('b1');
  await svc.clearPaymentIssueIfSentAfter('b1', new Date());
  assert.equal(await svc.dismissPaymentIssue('b1'), false);
  failWith = 'throw';
  await svc.recordPaymentIssue('b1');
  await svc.clearPaymentIssueIfSentAfter('b1', new Date());
  assert.equal(await svc.dismissPaymentIssue('b1'), false);
});

test('withPaymentIssue replaces the raw columns with paymentIssue { since, code }', () => {
  const out = svc.withPaymentIssue({ name: 'Biz', paymentIssueAt: '2026-10-10T10:00:00.000Z', paymentIssueCode: 131042 });
  assert.deepEqual(out, { name: 'Biz', paymentIssue: { since: '2026-10-10T10:00:00.000Z', code: 131042 } });
});

test('withPaymentIssue is null when there is no problem, and when the columns do not exist yet', () => {
  assert.deepEqual(svc.withPaymentIssue({ paymentIssueAt: null, paymentIssueCode: null }), { paymentIssue: null });
  assert.deepEqual(svc.withPaymentIssue({ name: 'Biz' }), { name: 'Biz', paymentIssue: null });
});
