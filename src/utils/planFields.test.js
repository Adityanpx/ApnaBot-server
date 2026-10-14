// Run: node --test src/utils/planFields.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDurationOptions, validateDurationOptions, validatePlanExtras, comparePlans
} = require('./planFields');

test('buildDurationOptions: Monthly = price, 3/6/12 from default 10/20/30 %, rounded to the rupee', () => {
  const out = buildDurationOptions(199);
  assert.deepEqual(out, [
    { months: 1, price: 199, label: 'Monthly', discount: 0 },
    { months: 3, price: 537, label: 'Quarterly', discount: 10 },     // 537.3
    { months: 6, price: 955, label: 'Half-Yearly', discount: 20 },   // 955.2
    { months: 12, price: 1672, label: 'Yearly', discount: 30 }       // 1671.6
  ]);
});

test('buildDurationOptions: keeps a stored discount and label, recomputes the amount from the new price', () => {
  const stored = [
    { months: 1, price: 100, label: 'Monthly', discount: 0 },
    { months: 3, price: 270, label: 'Quarter', discount: 5 }
  ];
  const out = buildDurationOptions(400, stored);
  assert.deepEqual(out.find(t => t.months === 3), { months: 3, price: 1140, label: 'Quarter', discount: 5 });
  assert.equal(out[0].price, 400);          // Monthly follows price, not the stale tier
  assert.equal(out.find(t => t.months === 12).discount, 30);   // missing tier -> default
});

test('buildDurationOptions: keeps and recomputes an extra tier; Monthly is always first', () => {
  const out = buildDurationOptions(100, [{ months: 2, price: 1, label: 'Two', discount: 50 }]);
  assert.deepEqual(out.map(t => t.months), [1, 2, 3, 6, 12]);
  assert.equal(out[1].price, 100);          // 100 x 2 x 0.5
});

test('buildDurationOptions: a plan with no Monthly tier stored gets one', () => {
  assert.equal(buildDurationOptions(50, [{ months: 12, price: 1, discount: 30 }])[0].months, 1);
});

test('validateDurationOptions: rejects missing Monthly, disagreeing Monthly, bad shapes', () => {
  assert.match(validateDurationOptions([{ months: 3, price: 10 }], 10), /Monthly/);
  assert.match(validateDurationOptions([{ months: 1, price: 99 }], 100), /must equal the plan price/);
  assert.match(validateDurationOptions('x', 100), /array/);
  assert.match(validateDurationOptions([{ months: 1, price: 100 }, { months: 1, price: 100 }], 100), /more than once/);
  assert.match(validateDurationOptions([{ months: 1, price: 100 }, { months: 3, discount: 120 }], 100), /discount/);
  assert.equal(validateDurationOptions([{ months: 1, price: 100 }, { months: 3, discount: 10 }], 100), null);
});

test('validatePlanExtras', () => {
  assert.equal(validatePlanExtras({}), null);
  assert.equal(validatePlanExtras({ features: ['a', 'b'], isPopular: true, sortOrder: -2, storageLimitMb: 0 }), null);
  assert.match(validatePlanExtras({ features: 'a' }), /features/);
  assert.match(validatePlanExtras({ features: ['ok', '  '] }), /features/);
  assert.match(validatePlanExtras({ isPopular: 'yes' }), /isPopular/);
  assert.match(validatePlanExtras({ sortOrder: 1.5 }), /sortOrder/);
  assert.match(validatePlanExtras({ storageLimitMb: -1 }), /storageLimitMb/);
});

test('comparePlans: sort_order first, then price', () => {
  const rows = [
    { name: 'c', sort_order: 0, price: 699 }, { name: 'a', sort_order: 0, price: 199 },
    { name: 'z', sort_order: -1, price: 999 }
  ];
  assert.deepEqual(rows.sort(comparePlans).map(r => r.name), ['z', 'a', 'c']);
});
