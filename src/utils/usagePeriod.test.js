// Run: node --test src/utils/usagePeriod.test.js
// Which message-counter period a subscription is in: monthly windows from current_period_start for
// one-time / trial rows, Razorpay's real cycle for autopay (never the 48-hour placeholder end).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeriod } = require('./usagePeriod');

const iso = (d) => d && d.toISOString();
const sub = (over) => ({
  start_date: '2026-10-01T00:00:00.000Z', current_period_start: '2026-10-01T00:00:00.000Z',
  end_date: '2026-11-01T00:00:00.000Z', is_autopay: false, ...over
});

test('one-month purchase: the period is the purchase month, ending at end_date', () => {
  const p = resolvePeriod(sub(), new Date('2026-10-15T12:00:00Z'));
  assert.equal(iso(p.periodStart), '2026-10-01T00:00:00.000Z');
  assert.equal(iso(p.periodEnd), '2026-11-01T00:00:00.000Z');
});

test('a 3-month purchase resets the counter each month (the period start steps forward)', () => {
  const s = sub({ end_date: '2027-01-01T00:00:00.000Z' });
  assert.equal(iso(resolvePeriod(s, new Date('2026-10-31T23:00:00Z')).periodStart), '2026-10-01T00:00:00.000Z');
  assert.equal(iso(resolvePeriod(s, new Date('2026-11-01T00:00:00Z')).periodStart), '2026-11-01T00:00:00.000Z');
  const dec = resolvePeriod(s, new Date('2026-12-20T00:00:00Z'));
  assert.equal(iso(dec.periodStart), '2026-12-01T00:00:00.000Z');
  assert.equal(iso(dec.periodEnd), '2027-01-01T00:00:00.000Z');
});

test('a stacked early renewal keeps the running period, then resets when the next month starts', () => {
  // bought on Oct 20 while the old month ran to Nov 1: anchor carried over, end pushed to Dec 1
  const s = sub({ start_date: '2026-10-20T00:00:00.000Z', end_date: '2026-12-01T00:00:00.000Z' });
  assert.equal(iso(resolvePeriod(s, new Date('2026-10-25T00:00:00Z')).periodStart), '2026-10-01T00:00:00.000Z');
  assert.equal(iso(resolvePeriod(s, new Date('2026-10-31T23:59:00Z')).periodStart), '2026-10-01T00:00:00.000Z');
  assert.equal(iso(resolvePeriod(s, new Date('2026-11-01T00:01:00Z')).periodStart), '2026-11-01T00:00:00.000Z');
});

test('a trial shorter than a month ends at its end_date', () => {
  const p = resolvePeriod(sub({ end_date: '2026-10-15T00:00:00.000Z' }), new Date('2026-10-05T00:00:00Z'));
  assert.equal(iso(p.periodEnd), '2026-10-15T00:00:00.000Z');
});

test('a day-31 anchor never skips a month (Feb overflows to Mar 3, which is when the next period starts)', () => {
  const s = sub({ start_date: '2027-01-31T00:00:00.000Z', current_period_start: '2027-01-31T00:00:00.000Z', end_date: '2027-04-30T00:00:00.000Z' });
  assert.equal(iso(resolvePeriod(s, new Date('2027-03-02T00:00:00Z')).periodStart), '2027-01-31T00:00:00.000Z');
  assert.equal(iso(resolvePeriod(s, new Date('2027-03-03T00:00:00Z')).periodStart), '2027-03-03T00:00:00.000Z');
});

test('autopay with a real cycle: current_period_start .. end_date, whatever the month length', () => {
  const s = sub({ is_autopay: true, current_period_start: '2026-10-10T08:00:00.000Z', end_date: '2026-11-10T08:00:00.000Z' });
  const p = resolvePeriod(s, new Date('2026-10-30T00:00:00Z'));
  assert.equal(iso(p.periodStart), '2026-10-10T08:00:00.000Z');
  assert.equal(iso(p.periodEnd), '2026-11-10T08:00:00.000Z');
});

test('autopay still on its 48-hour placeholder (no current_period_start): periodEnd is null, never the placeholder end_date', () => {
  const s = sub({ is_autopay: true, current_period_start: null, end_date: '2026-10-03T00:00:00.000Z' });
  const p = resolvePeriod(s, new Date('2026-10-02T00:00:00Z'));
  assert.equal(iso(p.periodStart), '2026-10-01T00:00:00.000Z');
  assert.equal(p.periodEnd, null);
});

test('a row without current_period_start falls back to start_date', () => {
  const p = resolvePeriod(sub({ current_period_start: null, start_date: '2026-09-05T00:00:00.000Z', end_date: '2026-10-05T00:00:00.000Z' }), new Date('2026-09-20T00:00:00Z'));
  assert.equal(iso(p.periodStart), '2026-09-05T00:00:00.000Z');
});

test('no subscription: the India-time calendar month', () => {
  const p = resolvePeriod(null, new Date('2026-10-15T12:00:00Z'));
  assert.equal(iso(p.periodStart), '2026-09-30T18:30:00.000Z');
  assert.equal(iso(p.periodEnd), '2026-10-31T18:30:00.000Z');
});
