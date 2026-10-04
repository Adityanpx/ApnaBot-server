// Run: node --test src/services/usage.service.test.js
// The usage month key (and the Redis key's TTL) follow the India-time
// month, so usage rolls over at 00:00 IST on the 1st, not 05:30 IST (UTC
// midnight on Render). Redis / Supabase are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const hash = new Map();
const expires = [];
const redis = {
  hincrby: async (key, field, n) => { const h = hash.get(key) || {}; h[field] = (h[field] || 0) + n; hash.set(key, h); },
  ttl: async (key) => (hash.has(key) ? -1 : -2),
  expire: async (key, seconds) => { expires.push({ key, seconds }); },
  hget: async (key, field) => (hash.get(key) || {})[field] ?? null
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/redis', redis);
stub('../config/supabase', { from: () => { throw new Error('not expected'); } });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const { getCurrentMonthKey, incrementUsage } = require('./usage.service');

const at = (t, iso) => {
  const tz = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { process.env.TZ = tz; if (tz === undefined) delete process.env.TZ; });
  t.mock.timers.enable({ apis: ['Date'], now: new Date(iso) });
};

test('month key: November from 00:00 IST Nov 1 (18:30 UTC Oct 31)', (t) => {
  at(t, '2026-10-31T18:30:00Z');
  assert.equal(getCurrentMonthKey(), '2026-11');
});

test('month key: still October at 23:59 IST Oct 31', (t) => {
  at(t, '2026-10-31T18:29:00Z');
  assert.equal(getCurrentMonthKey(), '2026-10');
});

test('new Redis key expires at the end of the India-time month', async (t) => {
  hash.clear(); expires.length = 0;
  at(t, '2026-10-31T12:00:00Z'); // 17:30 IST, last day of October
  await incrementUsage('b', 'inbound');
  assert.deepEqual(expires, [{ key: 'usage:b:2026-10', seconds: 6.5 * 3600 }]); // until 18:30 UTC
});

test('new Redis key mid-month: TTL runs to 00:00 IST on the 1st', async (t) => {
  hash.clear(); expires.length = 0;
  at(t, '2026-10-15T18:30:00Z'); // 00:00 IST Oct 16
  await incrementUsage('b', 'outbound');
  assert.deepEqual(expires, [{ key: 'usage:b:2026-10', seconds: 16 * 24 * 3600 }]);
});
