// Run: node --test src/utils/ist.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IST_OFFSET_MS, istMinuteOfDay, istDayStart, isWithinSendHours, nextSendHoursStart
} = require('./ist');

// 2026-10-03 09:00 IST = 03:30 UTC
const at = (iso) => new Date(iso);

test('IST offset is +05:30', () => {
  assert.equal(IST_OFFSET_MS, 330 * 60 * 1000);
});

test('istMinuteOfDay: India time, wraps at India midnight', () => {
  assert.equal(istMinuteOfDay(at('2026-10-03T03:30:00Z')), 540);  // 09:00 IST
  assert.equal(istMinuteOfDay(at('2026-10-02T18:30:00Z')), 0);    // 00:00 IST
  assert.equal(istMinuteOfDay(at('2026-10-02T18:29:00Z')), 1439); // 23:59 IST previous day
  assert.equal(istMinuteOfDay('2026-10-03T00:00:00Z'), 330);      // accepts strings
});

test('istDayStart: 00:00 IST of that India day, as a UTC instant', () => {
  const start = '2026-10-02T18:30:00.000Z';
  assert.equal(istDayStart(at('2026-10-03T03:30:00Z')).toISOString(), start);
  assert.equal(istDayStart(at('2026-10-02T18:30:00Z')).toISOString(), start);  // exactly midnight
  assert.equal(istDayStart(at('2026-10-03T18:29:59Z')).toISOString(), start);  // 23:59:59 IST
  // 20:00 UTC on Oct 2 is already Oct 3 in India
  assert.equal(istDayStart(at('2026-10-02T20:00:00Z')).toISOString(), start);
  assert.equal(istDayStart(at('2026-10-02T18:29:00Z')).toISOString(), '2026-10-01T18:30:00.000Z');
});

test('isWithinSendHours: start inclusive, end exclusive', () => {
  // 09:00–21:00 IST
  assert.equal(isWithinSendHours(at('2026-10-03T03:30:00Z'), 540, 1260), true);   // 09:00
  assert.equal(isWithinSendHours(at('2026-10-03T03:29:00Z'), 540, 1260), false);  // 08:59
  assert.equal(isWithinSendHours(at('2026-10-03T15:29:00Z'), 540, 1260), true);   // 20:59
  assert.equal(isWithinSendHours(at('2026-10-03T15:30:00Z'), 540, 1260), false);  // 21:00
  assert.equal(isWithinSendHours(at('2026-10-03T03:30:00Z'), 0, 1440), true);     // all day
});

test('isWithinSendHours: overnight window wraps; equal bounds are empty', () => {
  // 22:00–08:00 IST
  assert.equal(isWithinSendHours(at('2026-10-03T17:00:00Z'), 1320, 480), true);   // 22:30
  assert.equal(isWithinSendHours(at('2026-10-03T00:30:00Z'), 1320, 480), true);   // 06:00
  assert.equal(isWithinSendHours(at('2026-10-03T03:30:00Z'), 1320, 480), false);  // 09:00
  assert.equal(isWithinSendHours(at('2026-10-03T03:30:00Z'), 540, 540), false);
});

test('nextSendHoursStart: later today, else tomorrow; exactly at start returns it', () => {
  // 07:00 IST → 09:00 IST same day
  assert.equal(nextSendHoursStart(at('2026-10-03T01:30:00Z'), 540).toISOString(), '2026-10-03T03:30:00.000Z');
  // 09:00 IST exactly → itself
  assert.equal(nextSendHoursStart(at('2026-10-03T03:30:00Z'), 540).toISOString(), '2026-10-03T03:30:00.000Z');
  // 21:30 IST → 09:00 IST next day
  assert.equal(nextSendHoursStart(at('2026-10-03T16:00:00Z'), 540).toISOString(), '2026-10-04T03:30:00.000Z');
  // 23:30 UTC on Oct 2 is 05:00 IST Oct 3 → 09:00 IST Oct 3
  assert.equal(nextSendHoursStart(at('2026-10-02T23:30:00Z'), 540).toISOString(), '2026-10-03T03:30:00.000Z');
});
