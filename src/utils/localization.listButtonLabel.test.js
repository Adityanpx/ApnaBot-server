// Run: node --test src/utils/localization.listButtonLabel.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getListButtonLabel } = require('./localization');

const list = (extra = {}) => ({ contentType: 'list', buttonText: 'See courses', buttonTextTranslations: { hi: 'कोर्स देखें' }, ...extra });

test('list node: the node button text', () => {
  assert.equal(getListButtonLabel(list(), 'en'), 'See courses');
});

test('list node: the customer-language translation when there is one', () => {
  assert.equal(getListButtonLabel(list(), 'hi'), 'कोर्स देखें');
});

test('list node: falls back to the English text for a language with no translation', () => {
  assert.equal(getListButtonLabel(list(), 'mr'), 'See courses');
});

test('list node: "Choose" when button text is empty, blank or missing', () => {
  assert.equal(getListButtonLabel(list({ buttonText: '', buttonTextTranslations: null }), 'en'), 'Choose');
  assert.equal(getListButtonLabel(list({ buttonText: '   ', buttonTextTranslations: null }), 'en'), 'Choose');
  assert.equal(getListButtonLabel(list({ buttonText: null, buttonTextTranslations: null }), 'en'), 'Choose');
  assert.equal(getListButtonLabel({ contentType: 'list' }, 'en'), 'Choose');
});

test('a blank translation falls back to the English text', () => {
  assert.equal(getListButtonLabel(list({ buttonTextTranslations: { hi: '  ' } }), 'hi'), 'See courses');
});

test('non-list nodes always get "Choose" (button_text keeps its web-form meaning)', () => {
  assert.equal(getListButtonLabel({ contentType: 'buttons', buttonText: 'Fill form' }, 'en'), 'Choose');
  assert.equal(getListButtonLabel({ contentType: 'text', replyKind: 'web_form_trigger', buttonText: 'Fill form' }, 'en'), 'Choose');
  assert.equal(getListButtonLabel(null, 'en'), 'Choose');
});

test('the label is trimmed', () => {
  assert.equal(getListButtonLabel(list({ buttonText: '  See courses  ' }), 'en'), 'See courses');
});
