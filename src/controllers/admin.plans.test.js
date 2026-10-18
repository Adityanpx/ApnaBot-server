// Run: node --test src/controllers/admin.plans.test.js
// Super Admin plan create/update: price is the monthly price and duration_options is derived from it in
// the same write; new display fields (isPopular/features/sortOrder/storageLimitMb); isActive on create.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
// admin.controller pulls in the Razorpay SDK, which throws without a key id at load time.
h.cfg.RAZORPAY_KEY_ID = 'rzp_test_x'; h.cfg.RAZORPAY_KEY_SECRET = 's';
require('../test-support/stubRedis');
const admin = require('./admin.controller');

let db;
test.beforeEach(() => {
  db = h.reset();
  db.plans = [{
    id: 'p-basic', name: 'basic', display_name: 'Basic', price: 199, is_active: true, sort_order: 0,
    duration_options: [
      { months: 1, price: 199, label: 'Monthly', discount: 0 },
      { months: 3, price: 500, label: 'Quarterly', discount: 15 }
    ]
  }];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, user: { userId: 'admin-1' } }, res, (err) => { throw err; });
  return out;
};
const base = { name: 'gold', displayName: 'Gold', price: 1000 };
const row = (name) => db.plans.find(p => p.name === name);

test('create: derives all tiers from price, defaults the new fields, honours isActive:false', async () => {
  const out = await call(admin.createPlan, { body: { ...base, isActive: false, isPopular: true, features: [' Unlimited chats '], sortOrder: 5, storageLimitMb: 500 } });
  assert.equal(out.status, 201);
  const gold = row('gold');
  assert.deepEqual(gold.duration_options.map(t => [t.months, t.price]), [[1, 1000], [3, 2700], [6, 4800], [12, 8400]]);
  assert.equal(gold.is_active, false);
  assert.equal(gold.is_popular, true);
  assert.deepEqual(gold.features, ['Unlimited chats']);
  assert.equal(gold.sort_order, 5);
  assert.equal(gold.storage_limit_mb, 500);
  assert.equal(out.body.data.isPopular, true);
});

test('create: defaults - active, not popular, no features, sort 0, storage left to the DB default', async () => {
  await call(admin.createPlan, { body: base });
  const gold = row('gold');
  assert.deepEqual([gold.is_active, gold.is_popular, gold.features, gold.sort_order], [true, false, [], 0]);
  assert.equal('storage_limit_mb' in gold, false);
});

test('create: 400 when a supplied Monthly tier disagrees with price, or Monthly is missing', async () => {
  const bad = await call(admin.createPlan, { body: { ...base, durationOptions: [{ months: 1, price: 900 }] } });
  assert.equal(bad.status, 400);
  const none = await call(admin.createPlan, { body: { ...base, durationOptions: [{ months: 3, price: 2700 }] } });
  assert.equal(none.status, 400);
  assert.equal(row('gold'), undefined);
});

test('create: 400 on bad price / features / isActive', async () => {
  for (const body of [{ ...base, price: -1 }, { ...base, price: '10' }, { ...base, features: 'x' }, { ...base, isActive: 'no' }]) {
    assert.equal((await call(admin.createPlan, { body })).status, 400);
  }
});

test('update: changing price alone rewrites duration_options in the same update, keeping stored discounts', async () => {
  const out = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { price: 300 } });
  assert.equal(out.status, 200);
  const updates = h.state.fake.calls.filter(c => c.table === 'plans' && c.op === 'update');
  assert.equal(updates.length, 1, 'price and duration_options are written by ONE update');
  assert.equal(row('basic').price, 300);
  const tiers = row('basic').duration_options;
  assert.deepEqual(tiers[0], { months: 1, price: 300, label: 'Monthly', discount: 0 });
  assert.deepEqual(tiers.find(t => t.months === 3), { months: 3, price: 765, label: 'Quarterly', discount: 15 });   // 900 x 0.85
});

test('update: a Monthly tier that disagrees with the (new or stored) price is a 400 and writes nothing', async () => {
  const withPrice = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { price: 300, durationOptions: [{ months: 1, price: 199 }] } });
  assert.equal(withPrice.status, 400);
  const storedPrice = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { durationOptions: [{ months: 1, price: 250 }] } });
  assert.equal(storedPrice.status, 400);
  const noMonthly = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { durationOptions: [{ months: 3, price: 1 }] } });
  assert.equal(noMonthly.status, 400);
  assert.equal(h.state.fake.calls.filter(c => c.table === 'plans' && c.op === 'update').length, 0);
  assert.equal(row('basic').price, 199);
});

test('update: new display fields and storage; a non-price edit leaves duration_options alone', async () => {
  const out = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { isPopular: true, features: ['A'], sortOrder: 2, storageLimitMb: 250 } });
  assert.equal(out.status, 200);
  const basic = row('basic');
  assert.deepEqual([basic.is_popular, basic.features, basic.sort_order, basic.storage_limit_mb], [true, ['A'], 2, 250]);
  assert.equal(basic.duration_options[1].price, 500, 'untouched');
});

test('update: 404 for an unknown plan; 400 for an invalid price', async () => {
  assert.equal((await call(admin.updatePlan, { params: { id: 'nope' }, body: { price: 1 } })).status, 404);
  assert.equal((await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { price: -5 } })).status, 400);
});

test('GET /admin/plans: ordered by sort_order then price, inactive included', async () => {
  db.plans.push({ id: 'p2', name: 'pro', display_name: 'Pro', price: 399, is_active: false, sort_order: -1, duration_options: [] });
  const out = await call(admin.getPlans);
  assert.deepEqual(out.body.data.plans.map(p => p.name), ['pro', 'basic']);
});

test('carouselMaxCards: create defaults to 3, update accepts 2..10, anything else is a 400 that writes nothing', async () => {
  await call(admin.createPlan, { body: base });
  assert.equal(row('gold').carousel_max_cards, 3);
  const explicit = await call(admin.createPlan, { body: { ...base, name: 'plat', displayName: 'Plat', carouselMaxCards: 10 } });
  assert.equal(explicit.status, 201);
  assert.equal(row('plat').carousel_max_cards, 10);
  assert.equal(explicit.body.data.carouselMaxCards, 10);

  const ok = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { carouselMaxCards: 5 } });
  assert.equal(ok.status, 200);
  assert.equal(row('basic').carousel_max_cards, 5);
  for (const bad of [1, 11, 2.5, '5', null]) {
    const out = await call(admin.updatePlan, { params: { id: 'p-basic' }, body: { carouselMaxCards: bad } });
    assert.equal(out.status, 400, String(bad));
    assert.match(out.body.message, /carouselMaxCards must be an integer between 2 and 10/);
  }
  assert.equal(row('basic').carousel_max_cards, 5);
});
