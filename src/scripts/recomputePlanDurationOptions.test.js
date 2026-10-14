// Run: node --test src/scripts/recomputePlanDurationOptions.test.js
// The recompute script: dry run writes nothing; --confirm writes duration_options only (never price).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

const SCRIPT = path.join(__dirname, 'recomputePlanDurationOptions.js');

// Runs the script in-process with a fake supabase and the given argv; returns { out, db }.
const run = async (argv, plans) => {
  const fake = createFakeSupabase();
  fake.db.plans = plans.map(p => ({ ...p }));
  const supabasePath = require.resolve('../config/supabase');
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: (t) => fake.from(t) } };
  delete require.cache[SCRIPT];
  const oldArgv = process.argv; const oldLog = console.log;
  const lines = [];
  process.argv = ['node', SCRIPT, ...argv];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const mod = require(SCRIPT);
    await mod.main();   // only auto-runs when the file is the entry point
  } finally { process.argv = oldArgv; console.log = oldLog; delete require.cache[SCRIPT]; }
  return { out: lines.join('\n'), db: fake.db };
};

const stale = () => ([{
  id: 'p1', name: 'basic', price: 199,
  duration_options: [{ months: 1, price: 150, label: 'Monthly', discount: 0 }, { months: 3, price: 537, label: 'Quarterly', discount: 10 }]
}]);

test('dry run prints the diff and writes nothing', async () => {
  const { out, db } = await run([], stale());
  assert.match(out, /Dry run only/);
  assert.match(out, /~  1mo: 150/);
  assert.deepEqual(db.plans[0].duration_options, stale()[0].duration_options);
});

test('--confirm rewrites duration_options from price + stored discounts and never touches price', async () => {
  const { db } = await run(['--confirm'], stale());
  const p = db.plans[0];
  assert.equal(p.price, 199);
  assert.deepEqual(p.duration_options.map(t => [t.months, t.price]), [[1, 199], [3, 537], [6, 955], [12, 1672]]);
});

test('an already-consistent plan is left alone', async () => {
  const { buildDurationOptions } = require('../utils/planFields');
  const { out } = await run(['--confirm'], [{ id: 'p', name: 'x', price: 100, duration_options: buildDurationOptions(100) }]);
  assert.match(out, /already consistent/);
  assert.match(out, /Updated 0 plan/);
});
