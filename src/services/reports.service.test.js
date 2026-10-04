// Run: node --test src/services/reports.service.test.js
// The reports "month" period is the India-time calendar month — on a UTC
// server (Render) a local-time month would start at 05:30 IST on the 1st.
// Supabase is stubbed; the test reads the ranges the queries were given.
const test = require('node:test');
const assert = require('node:assert/strict');

const ranges = [];
const supabase = {
  from: () => {
    const range = {};
    const q = {
      select: () => q,
      eq: () => q,
      in: () => q,
      gte: (c, v) => { range.start = v; return q; },
      lt: (c, v) => { range.end = v; ranges.push(range); return q; },
      then: (resolve) => resolve({ count: 0, error: null })
    };
    return q;
  },
  rpc: async () => ({ data: 0, error: null })
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', supabase);
const { getReportsSummary } = require('./reports.service');

const run = async (t, nowIso) => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { process.env.TZ = tz; if (tz === undefined) delete process.env.TZ; });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(nowIso) });
  ranges.length = 0;
  await getReportsSummary('b', 'month');
  // 2 tables × (current, previous)
  const starts = [...new Set(ranges.map(r => r.start))].sort();
  const ends = [...new Set(ranges.map(r => r.end))].sort();
  return { starts, ends };
};

test('month: starts 00:00 IST on the 1st (18:30 UTC the day before)', async (t) => {
  const { starts, ends } = await run(t, '2026-10-15T12:00:00Z');
  assert.deepEqual(starts, ['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
  // previous period = same elapsed time into September (IST)
  assert.deepEqual(ends, ['2026-09-15T12:00:00.000Z', '2026-10-15T12:00:00.000Z']);
});

test('month: 00:15 IST on Nov 1 is already November, while UTC still says Oct 31', async (t) => {
  const { starts } = await run(t, '2026-10-31T18:45:00Z');
  assert.deepEqual(starts, ['2026-09-30T18:30:00.000Z', '2026-10-31T18:30:00.000Z']);
});

test('month: 23:59 IST on Oct 31 is still October', async (t) => {
  const { starts } = await run(t, '2026-10-31T18:29:00Z');
  assert.deepEqual(starts, ['2026-08-31T18:30:00.000Z', '2026-09-30T18:30:00.000Z']);
});

test('month: on 31 March the previous period stops at the end of February', async (t) => {
  const { starts, ends } = await run(t, '2026-03-31T12:00:00Z'); // 17:30 IST Mar 31
  assert.deepEqual(starts, ['2026-01-31T18:30:00.000Z', '2026-02-28T18:30:00.000Z']);
  // previous: Feb 1 → Mar 1 00:00 IST (all of February), not into March
  assert.deepEqual(ends, ['2026-02-28T18:30:00.000Z', '2026-03-31T12:00:00.000Z']);
});

test('month: early in the month the previous period is still duration-matched', async (t) => {
  const { ends } = await run(t, '2026-03-10T06:30:00Z'); // 12:00 IST Mar 10
  assert.deepEqual(ends, ['2026-02-10T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
});
