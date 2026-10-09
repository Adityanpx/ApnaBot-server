// Run: node --test src/utils/systemMessages.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { SYSTEM_MESSAGES, getSystemMessage } = require('./systemMessages');

const LANGUAGES = ['en', 'hi', 'mr'];

// WhatsApp reply-button titles are cut at 20 characters
// (whatsapp.service.js#sendInteractiveButtons slices by .length).
test('opt-in button titles fit in 20 characters in every language', () => {
  for (const key of ['optInYesButton', 'optInNoButton']) {
    for (const lang of LANGUAGES) {
      const title = SYSTEM_MESSAGES[key][lang];
      assert.ok(title, `${key}.${lang} missing`);
      assert.ok(title.length <= 20, `${key}.${lang} "${title}" is ${title.length} characters`);
    }
  }
});

test('opt-in consent question names the business and mentions STOP in every language', () => {
  for (const lang of LANGUAGES) {
    assert.ok(SYSTEM_MESSAGES.optInConsentQuestion[lang], `optInConsentQuestion.${lang} missing`);
    const text = getSystemMessage('optInConsentQuestion', lang, { business: 'SG Travels' });
    assert.ok(text.includes('SG Travels'), `${lang}: business name missing`);
    assert.ok(text.includes('STOP'), `${lang}: STOP missing`);
    assert.ok(!text.includes('{{'), `${lang}: unfilled placeholder`);
  }
});

test('opt-in confirmation names the business and mentions STOP in every language', () => {
  for (const lang of LANGUAGES) {
    assert.ok(SYSTEM_MESSAGES.optInConfirmed[lang], `optInConfirmed.${lang} missing`);
    const text = getSystemMessage('optInConfirmed', lang, { business: 'SG Travels' });
    assert.ok(text.includes('SG Travels'), `${lang}: business name missing`);
    assert.ok(text.includes('STOP'), `${lang}: STOP missing`);
  }
});

test('post-booking consent question names the business and mentions STOP in every language', () => {
  for (const lang of LANGUAGES) {
    assert.ok(SYSTEM_MESSAGES.bookingConsentQuestion[lang], `bookingConsentQuestion.${lang} missing`);
    const text = getSystemMessage('bookingConsentQuestion', lang, { business: 'SG Travels' });
    assert.ok(text.includes('SG Travels'), `${lang}: business name missing`);
    assert.ok(text.includes('STOP'), `${lang}: STOP missing`);
    assert.ok(!text.includes('{{'), `${lang}: unfilled placeholder`);
    assert.ok(text.length <= 1024, `${lang}: longer than a button message body`);
  }
});

test('post-booking consent "declined" line exists in every language', () => {
  for (const lang of LANGUAGES) {
    const text = getSystemMessage('bookingConsentDeclined', lang);
    assert.ok(text && text.trim(), `bookingConsentDeclined.${lang} missing`);
  }
});
