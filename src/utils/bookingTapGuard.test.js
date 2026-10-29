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

test('a file question is a typed question for the guard but its hint asks for a file, not text', () => {
  assert.equal(isChoiceFieldType('file'), false);
  assert.match(withTapHint('Send your ID', 'en', 'file'), /^Please send a photo or file as your answer\. Send \*menu\*.*\n\nSend your ID$/);
  assert.match(withTapHint('Q', 'hi', 'file'), /\*menu\*/);
  assert.match(withTapHint('Q', 'en', 'text'), /^Please type your answer/);
});

test('isChoiceFieldType: only buttons / list / vehicle_carousel take a tap', () => {
  for (const type of ['buttons', 'list', 'vehicle_carousel']) assert.equal(isChoiceFieldType(type), true, type);
  for (const type of ['text', 'textarea', 'location_request', undefined]) assert.equal(isChoiceFieldType(type), false, String(type));
});

test('withTapHint: the hint sits above the question, in the customer\'s language, English fallback', () => {
  assert.equal(withTapHint('Any property ID?', 'en'), 'Please type your answer. Send *menu* to leave this booking.\n\nAny property ID?');
  assert.match(withTapHint('Q', 'hi'), /^कृपया अपना उत्तर टाइप करें।.*\*menu\*/);
  assert.match(withTapHint('Q', 'mr'), /\*menu\*/);
  assert.match(withTapHint('Q', 'zz'), /^Please type your answer/);
  assert.match(withTapHint('Q', null), /^Please type your answer/);
  assert.equal(withTapHint('', 'en'), 'Please type your answer. Send *menu* to leave this booking.');
  assert.equal(withTapHint('Q', 'en', 'location_request'), withTapHint('Q', 'en', 'text'));
});

test('withTapHint: a choice question gets the tap-an-option hint, in the customer\'s language, English fallback', () => {
  for (const type of ['buttons', 'list', 'vehicle_carousel']) {
    assert.equal(withTapHint('Buy or rent?', 'en', type), 'Please tap one of the options below. Send *menu* to leave this booking.\n\nBuy or rent?', type);
  }
  assert.match(withTapHint('Q', 'hi', 'list'), /^कृपया नीचे दिए गए विकल्पों में से एक चुनें।.*\*menu\*/);
  assert.match(withTapHint('Q', 'mr', 'buttons'), /^कृपया खालील पर्यायांपैकी एक निवडा\..*\*menu\*/);
  assert.match(withTapHint('Q', 'zz', 'buttons'), /^Please tap one of the options below/);
  assert.equal(withTapHint('', 'en', 'list'), 'Please tap one of the options below. Send *menu* to leave this booking.');
});
