// Run: node --test src/services/currentSubscription.service.test.js
// The shared "current subscription" pick rule: non-pending first, then latest
// end_date, then latest created_at; never throws; warns on duplicates.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase, stub } = require('../testUtils/fakeSupabase');

const warnings = [];
let fake;
stub('../config/supabase', { from: (t) => fake.from(t) }, __filename);
stub('../utils/logger', { info: () => {}, error: () => {}, warn: (m) => warnings.push(m) }, __filename);
const svc = require('./currentSubscription.service');

const sub = (o) => ({ business_id: 'b1', plan_id: 'p1', status: 'active', created_at: '2026-10-01T00:00:00Z', end_date: '2026-11-01T00:00:00Z', ...o });
const plans = [
  { id: 'basic', display_name: 'Basic', price: 199 },
  { id: 'biz', display_name: 'Business', price: 999 }
];

test.beforeEach(() => { warnings.length = 0; });

test('picks the later end_date among two active rows and warns (the 2026-10-14 case)', async () => {
  fake = createFakeSupabase({ plans, subscriptions: [
    sub({ id: 'old-business', plan_id: 'biz', end_date: '2027-02-05T11:00:00Z', created_at: '2026-10-08T00:00:00Z' }),
    sub({ id: 'new-autopay', plan_id: 'basic', end_date: '2026-10-14T09:00:59Z', created_at: '2026-10-14T09:00:59Z' })
  ] });
  const { data, error } = await svc.getCurrentSubscriptionRow('b1', { statuses: ['active'] });
  assert.equal(error, null);
  assert.equal(data.id, 'old-business');
  assert.equal(data.plan.display_name, 'Business');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 candidate subscriptions/);
});

test('a pending_start row loses to a non-pending row even with a later end_date', () => {
  const rows = [
    sub({ id: 'pending', status: 'pending_start', end_date: '2030-01-01T00:00:00Z' }),
    sub({ id: 'live', end_date: '2026-11-01T00:00:00Z' })
  ];
  assert.equal(svc.pickCurrentSubscription(rows, 'b1').id, 'live');
});

test('equal end_date falls back to latest created_at', () => {
  const rows = [
    sub({ id: 'older', created_at: '2026-10-01T00:00:00Z' }),
    sub({ id: 'newer', created_at: '2026-10-05T00:00:00Z' })
  ];
  assert.equal(svc.pickCurrentSubscription(rows, 'b1').id, 'newer');
});

test('single row: no warning; empty: null', () => {
  assert.equal(svc.pickCurrentSubscription([sub({ id: 'x' })], 'b1').id, 'x');
  assert.equal(warnings.length, 0);
  assert.equal(svc.pickCurrentSubscription([], 'b1'), null);
  assert.equal(svc.pickCurrentSubscription(null, 'b1'), null);
});

test('only the requested statuses are considered', async () => {
  fake = createFakeSupabase({ plans, subscriptions: [
    sub({ id: 'trial', status: 'trial' }), sub({ id: 'cancelled', status: 'cancelled', end_date: '2030-01-01T00:00:00Z' })
  ] });
  assert.equal((await svc.getCurrentSubscriptionRow('b1', { statuses: ['active'] })).data, null);
  assert.equal((await svc.getCurrentSubscriptionRow('b1', { statuses: ['active', 'trial'] })).data.id, 'trial');
});

test('never throws: a DB error comes back as { error }', async () => {
  fake = { from: () => { throw new Error('boom'); } };
  const res = await svc.getCurrentSubscriptionRow('b1');
  assert.equal(res.data, null);
  assert.equal(res.error.message, 'boom');
});

test('findHigherActiveSubscription: lower plan is blocked, same/higher allowed, ended or inactive rows ignored', () => {
  const now = new Date('2026-10-14T00:00:00Z');
  const bizRow = { status: 'active', end_date: '2027-02-05T00:00:00Z', plan: plans[1] };
  assert.equal(svc.findHigherActiveSubscription([bizRow], plans[0], now), bizRow);   // Basic < Business
  assert.equal(svc.findHigherActiveSubscription([bizRow], plans[1], now), null);     // same plan
  assert.equal(svc.findHigherActiveSubscription([{ status: 'active', end_date: '2026-10-01T00:00:00Z', plan: plans[0] }], plans[1], now), null); // lower row, higher new
  assert.equal(svc.findHigherActiveSubscription([{ ...bizRow, end_date: '2026-10-01T00:00:00Z' }], plans[0], now), null); // ended
  assert.equal(svc.findHigherActiveSubscription([{ ...bizRow, status: 'cancelled' }], plans[0], now), null);
});
