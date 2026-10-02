// Run: node --test src/scripts/backfillOptedOut.test.js
// The pure parts only — the script itself is never run here.
const test = require('node:test');
const assert = require('node:assert/strict');

const p = require.resolve('../config/supabase');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { from: () => { throw new Error('no database in this test'); } } };
const { findOptedOut, maskNumber } = require('./backfillOptedOut');

// As fetchKeywordMessages returns them: oldest first, word = trimmed lowercase content.
const msg = (customer_id, word, created_at) => ({ customer_id, word, created_at });

test('latest STOP with no START after it → opted out at that STOP', () => {
  const r = findOptedOut([
    msg('a', 'stop', '2026-09-01T10:00:00Z'),
    msg('b', 'unsubscribe', '2026-09-02T10:00:00Z'),
    msg('a', 'stop', '2026-09-05T10:00:00Z')
  ]);
  assert.deepEqual([...r.entries()].sort(), [['a', '2026-09-05T10:00:00Z'], ['b', '2026-09-02T10:00:00Z']]);
});

test('a START after the latest STOP means not opted out; STOP after START means opted out again', () => {
  const r = findOptedOut([
    msg('a', 'stop', '2026-09-01T10:00:00Z'),
    msg('a', 'start', '2026-09-03T10:00:00Z'),
    msg('b', 'stop', '2026-09-01T10:00:00Z'),
    msg('b', 'start', '2026-09-02T10:00:00Z'),
    msg('b', 'stop', '2026-09-04T10:00:00Z')
  ]);
  assert.deepEqual([...r.entries()], [['b', '2026-09-04T10:00:00Z']]);
});

test('START with no STOP before it is ignored', () => {
  assert.equal(findOptedOut([msg('a', 'start', '2026-09-01T10:00:00Z')]).size, 0);
});

test('maskNumber keeps the country/area start and last digits', () => {
  assert.equal(maskNumber('919876543210'), '9198*****210');
  assert.equal(maskNumber('12345'), '***45');
  assert.equal(maskNumber(null), '');
});
