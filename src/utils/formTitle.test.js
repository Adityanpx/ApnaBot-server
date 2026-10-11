// Run: node --test src/utils/formTitle.test.js
// Pure - no Supabase/Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { FORM_TITLE_MAX, localizedFormTitle, bookingFormTitle } = require('./formTitle');

const node = { form_title: 'Enquiry form', form_title_translations: { hi: 'पूछताछ फ़ॉर्म', mr: ' ' } };

test('limit is 60', () => assert.equal(FORM_TITLE_MAX, 60));

test('localizedFormTitle: the customer\'s language, else English', () => {
  assert.equal(localizedFormTitle(node, 'hi'), 'पूछताछ फ़ॉर्म');
  assert.equal(localizedFormTitle(node, null), 'Enquiry form');
  assert.equal(localizedFormTitle(node), 'Enquiry form');
  assert.equal(localizedFormTitle(node, 'en'), 'Enquiry form');
  assert.equal(localizedFormTitle(node, 'mr'), 'Enquiry form', 'a blank translation falls back');
  assert.equal(localizedFormTitle(node, 'te'), 'Enquiry form', 'a language with no entry falls back');
});

test('localizedFormTitle: nothing set, or a bad node, is null', () => {
  assert.equal(localizedFormTitle(null, 'hi'), null);
  assert.equal(localizedFormTitle({}, 'hi'), null);
  assert.equal(localizedFormTitle({ form_title: '  ', form_title_translations: null }, null), null);
  assert.equal(localizedFormTitle({ form_title: null, form_title_translations: { hi: 'x' } }, null), null);
  assert.equal(localizedFormTitle({ form_title: null, form_title_translations: { hi: 'x' } }, 'hi'), 'x');
  assert.equal(localizedFormTitle({ form_title: 'A', form_title_translations: 'junk' }, 'hi'), 'A');
});

test('bookingFormTitle: always the English title, trimmed, else null', () => {
  assert.equal(bookingFormTitle(node), 'Enquiry form');
  assert.equal(bookingFormTitle({ form_title: ' A ' }), 'A');
  assert.equal(bookingFormTitle({ form_title: '' }), null);
  assert.equal(bookingFormTitle({ form_title_translations: { hi: 'x' } }), null);
  assert.equal(bookingFormTitle(null), null);
});
