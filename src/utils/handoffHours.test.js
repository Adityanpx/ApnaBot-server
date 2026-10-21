// Run: node --test src/utils/handoffHours.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateHours, isClosedNow, nextOpening, formatOpening } = require('./handoffHours');

// IST = UTC+05:30. 2026-10-19 is a Monday.
const ist = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00+05:30`);
const WEEK = {
  mon: [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '19:00' }],
  tue: [{ open: '09:00', close: '19:00' }],
  wed: [], // closed day
  thu: [{ open: '09:00', close: '19:00' }],
  fri: [{ open: '09:00', close: '19:00' }]
  // sat, sun missing = closed
};

test('isClosedNow: inside / outside ranges, between two ranges, closed and missing days', () => {
  assert.equal(isClosedNow(WEEK, ist('19', '10:00')), false);
  assert.equal(isClosedNow(WEEK, ist('19', '13:00')), true); // close is exclusive
  assert.equal(isClosedNow(WEEK, ist('19', '14:00')), true);
  assert.equal(isClosedNow(WEEK, ist('19', '15:00')), false);
  assert.equal(isClosedNow(WEEK, ist('19', '19:00')), true);
  assert.equal(isClosedNow(WEEK, ist('21', '10:00')), true); // Wednesday []
  assert.equal(isClosedNow(WEEK, ist('24', '10:00')), true); // Saturday missing
});

test('hours null = unknown: never closed, no next opening', () => {
  assert.equal(isClosedNow(null, ist('19', '03:00')), false);
  assert.equal(nextOpening(null, ist('19', '03:00')), null);
});

test('uses India time, not UTC', () => {
  // 2026-10-19 03:30 UTC = 09:00 IST Monday: open. 2026-10-18 20:00 UTC = 01:30 IST Monday: closed.
  assert.equal(isClosedNow(WEEK, new Date('2026-10-19T03:30:00Z')), false);
  assert.equal(isClosedNow(WEEK, new Date('2026-10-18T20:00:00Z')), true);
});

test('nextOpening: later today, between ranges, tomorrow, over a closed day and a weekend', () => {
  assert.deepEqual(nextOpening(WEEK, ist('19', '07:00')), { dayOffset: 0, dayKey: 'mon', minute: 540 });
  assert.deepEqual(nextOpening(WEEK, ist('19', '14:00')), { dayOffset: 0, dayKey: 'mon', minute: 900 });
  assert.deepEqual(nextOpening(WEEK, ist('19', '20:00')), { dayOffset: 1, dayKey: 'tue', minute: 540 });
  assert.deepEqual(nextOpening(WEEK, ist('20', '20:00')), { dayOffset: 2, dayKey: 'thu', minute: 540 }); // Wed is closed
  assert.deepEqual(nextOpening(WEEK, ist('23', '20:00')), { dayOffset: 3, dayKey: 'mon', minute: 540 }); // Fri night -> Monday
  assert.equal(nextOpening({ mon: [] }, ist('19', '07:00')), null);
});

test('formatOpening: today / tomorrow / weekday, en', () => {
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 600 }), 'today at 10:00 am');
  assert.equal(formatOpening({ dayOffset: 1, dayKey: 'tue', minute: 540 }), 'tomorrow at 9:00 am');
  assert.equal(formatOpening({ dayOffset: 3, dayKey: 'mon', minute: 600 }, 'en'), 'Monday at 10:00 am');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 15 * 60 + 30 }), 'today at 3:30 pm');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 0 }), 'today at 12:00 am');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 720 }), 'today at 12:00 pm');
});

test('formatOpening: hi / mr, and an unknown language falls back to en', () => {
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 600 }, 'hi'), 'आज सुबह 10:00 बजे');
  assert.equal(formatOpening({ dayOffset: 1, dayKey: 'tue', minute: 540 }, 'hi'), 'कल सुबह 9:00 बजे');
  assert.equal(formatOpening({ dayOffset: 3, dayKey: 'mon', minute: 600 }, 'hi'), 'सोमवार को सुबह 10:00 बजे');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 600 }, 'mr'), 'आज सकाळी 10:00 वाजता');
  assert.equal(formatOpening({ dayOffset: 1, dayKey: 'tue', minute: 17 * 60 }, 'mr'), 'उद्या संध्याकाळी 5:00 वाजता');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 600 }, 'ta'), 'today at 10:00 am');
  assert.equal(formatOpening({ dayOffset: 0, dayKey: 'mon', minute: 600 }, null), 'today at 10:00 am');
});

test('validateHours: accepts null and a good week; sorts ranges; names the bad field', () => {
  assert.deepEqual(validateHours(null), { ok: true, hours: null });
  const ok = validateHours({ mon: [{ open: '15:00', close: '19:00' }, { open: '09:00', close: '13:00' }], sun: [] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.hours.mon, [{ open: '09:00', close: '13:00' }, { open: '15:00', close: '19:00' }]);
  assert.deepEqual(ok.hours.sun, []);
  const field = (h) => validateHours(h).field;
  assert.equal(field('x'), 'hours');
  assert.equal(field([]), 'hours');
  assert.equal(field({ monday: [] }), 'hours.monday');
  assert.equal(field({ mon: {} }), 'hours.mon');
  assert.equal(field({ mon: [{ open: '9:00', close: '13:00' }] }), 'hours.mon[0].open');
  assert.equal(field({ mon: [{ open: '09:00', close: '25:00' }] }), 'hours.mon[0].close');
  assert.equal(field({ mon: [{ open: '13:00', close: '09:00' }] }), 'hours.mon[0]');
  assert.equal(field({ mon: [{ open: '09:00', close: '13:00', x: 1 }] }), 'hours.mon[0].x');
  assert.equal(field({ mon: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '14:00' }] }), 'hours.mon');
  assert.equal(field({ mon: Array.from({ length: 5 }, (_, i) => ({ open: `0${i}:00`, close: `0${i}:30` })) }), 'hours.mon');
});
