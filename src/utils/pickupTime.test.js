// Run: node --test src/utils/pickupTime.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePickupMinute } = require('./pickupTime');

test('12-hour times with am / pm', () => {
  const cases = {
    '6:30 AM': 390, '6.30 pm': 1110, '6 am': 360, '6pm': 1080, '10:00 PM': 1320, '5:59 AM': 359,
    '12 AM': 0, '12:30 am': 30, '12 PM': 720, '12:15 p.m.': 735, ' 7:05  Am ': 425
  };
  for (const [input, minute] of Object.entries(cases)) assert.equal(parsePickupMinute(input), minute, input);
});

test('24-hour times', () => {
  const cases = { '18:30': 1110, '18.30': 1110, '1830': 1110, '06:05': 365, '00:00': 0, '23:59': 1439, '9:15': 555 };
  for (const [input, minute] of Object.entries(cases)) assert.equal(parsePickupMinute(input), minute, input);
});

test('noon, midnight and Devanagari digits', () => {
  assert.equal(parsePickupMinute('noon'), 720);
  assert.equal(parsePickupMinute('Midnight'), 0);
  assert.equal(parsePickupMinute('६:३० pm'), 1110);
  assert.equal(parsePickupMinute('१८:३०'), 1110);
});

test('anything unclear is null, never guessed', () => {
  for (const input of ['', '   ', 'morning', '6', 'tomorrow 6 am', '13 pm', '0 am', '25:00', '24:00', '6:75 am', '18:60', 'abc', null, undefined]) {
    assert.equal(parsePickupMinute(input), null, String(input));
  }
});
