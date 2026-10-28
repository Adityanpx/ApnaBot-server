// Run: node --test src/utils/bookingTapGuard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isChoiceFieldType, isInternalId, withTapHint } = require('./bookingTapGuard');

const U = 'ad074bf9-1111-4222-8333-944455556666';

test('isInternalId: edge / node ids, {node}:{index|other} and system tap ids are internal', () => {
  for (const value of [U, `${U}:2`, `${U}:other`, `  ${U}  `, 'cat:menu', `cat:${U}:p:0`, 'lang_mr', `optin_yes:${U}`, 'optin_no:booking']) {
    assert.equal(isInternalId(value), true, value);
  }
});

test('isInternalId: ordinary typed answers are never internal (including colon shapes like a time)', () => {
  for (const value of ['Wakad', '10:30', '2:30 pm', 'Flat 3:rent', 'WKD-2B-01', 'catalogue', 'language', '', '   ', null, undefined, 42]) {
    assert.equal(isInternalId(value), false, String(value));
  }
});

test('isChoiceFieldType: only buttons / list / vehicle_carousel take a tap', () => {
  for (const type of ['buttons', 'list', 'vehicle_carousel']) assert.equal(isChoiceFieldType(type), true, type);
  for (const type of ['text', 'textarea', 'location_request', undefined]) assert.equal(isChoiceFieldType(type), false, String(type));
});

test('withTapHint: the hint sits above the question, in the customer\'s language, English fallback', () => {
  assert.equal(withTapHint('Any property ID?', 'en'), 'Please type your answer. Send *menu* to leave this booking.\n\nAny property ID?');
  assert.match(withTapHint('Q', 'hi'), /^कृपया अपना उत्तर टाइप करें।.*\*menu\*/);
  assert.match(withTapHint('Q', 'mr'), /\*menu\*/);
  assert.match(withTapHint('Q', 'ta'), /^Please type your answer/);
  assert.match(withTapHint('Q', null), /^Please type your answer/);
  assert.equal(withTapHint('', 'en'), 'Please type your answer. Send *menu* to leave this booking.');
});
