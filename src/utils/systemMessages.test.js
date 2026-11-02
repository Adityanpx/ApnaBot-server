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

test('values filled into system messages are cleaned', () => {
  assert.equal(
    getSystemMessage('optInConfirmed', 'en', { business: ' PrimeCare\n Clinic ' }),
    "Thanks! You'll now get offers and updates from PrimeCare Clinic. Reply STOP anytime to stop."
  );
  assert.equal(getSystemMessage('bookingIdLine', 'en', { code: 'SG1234 ' }), 'Booking ID: *SG1234*');
  assert.equal(getSystemMessage('bookingIdLine', 'en', { code: '$&' }), 'Booking ID: *$&*');
});

test('catalogue button titles fit WhatsApp\'s 20 characters in every language; the texts have no unfilled placeholder', () => {
  for (const key of ['catalogViewButton', 'catalogOrderButton', 'catalogOrderThisButton', 'catalogShowMoreButton', 'catalogMenuLabel']) {
    for (const lang of LANGUAGES) {
      const title = SYSTEM_MESSAGES[key][lang];
      assert.ok(title, `${key}.${lang} missing`);
      assert.ok(title.length <= 20, `${key}.${lang} "${title}" is ${title.length} characters`);
    }
  }
  const vars = { from: 1, to: 10, total: 34, title: 'Silk' };
  for (const key of ['catalogPageSummary', 'catalogCollectionEmpty']) {
    for (const lang of LANGUAGES) assert.ok(!getSystemMessage(key, lang, vars).includes('{{'), `${key}.${lang}`);
  }
  for (const key of ['catalogFieldCollection', 'catalogFieldDesignNo', 'catalogFieldPrice', 'catalogDefaultText', 'catalogEmptyText', 'catalogOrderMessageDefault', 'catalogTapStale']) {
    for (const lang of LANGUAGES) assert.ok(SYSTEM_MESSAGES[key][lang], `${key}.${lang} missing`);
  }
});

// Travel quote route picker (list rows <= 24 characters, in every language) and its prompts / hint.
test('route picker rows fit a list row (24 characters) in every language', () => {
  for (const key of ['routePickerMore', 'routePickerOtherRoute', 'routePickerOtherPlaces']) {
    for (const lang of LANGUAGES) {
      const title = SYSTEM_MESSAGES[key][lang];
      assert.ok(title, `${key}.${lang} missing`);
      assert.ok(title.length <= 24, `${key}.${lang} "${title}" is ${title.length} characters`);
    }
  }
});

test('route picker prompts and the pickup-time hint exist in every language', () => {
  for (const key of ['routePickerFromPrompt', 'routePickerRegionPrompt', 'routePickerToPrompt', 'pickupTimeInvalid']) {
    for (const lang of LANGUAGES) {
      const text = getSystemMessage(key, lang);
      assert.ok(text && text.trim(), `${key}.${lang} missing`);
      assert.ok(!text.includes('{{'), `${key}.${lang}: unfilled placeholder`);
      assert.ok(text.length <= 1024, `${key}.${lang}: too long for a message body`);
    }
  }
});

test('every travel-quote message exists in every language; button titles fit 20 characters', () => {
  const keys = Object.keys(SYSTEM_MESSAGES).filter(k => k.startsWith('quote'));
  assert.ok(keys.length >= 30);
  for (const key of keys) {
    for (const lang of LANGUAGES) assert.ok(SYSTEM_MESSAGES[key][lang] && SYSTEM_MESSAGES[key][lang].trim(), `${key}.${lang} missing`);
  }
  for (const key of keys.filter(k => k.startsWith('quoteBtn'))) {
    for (const lang of LANGUAGES) assert.ok(SYSTEM_MESSAGES[key][lang].length <= 20, `${key}.${lang} is ${SYSTEM_MESSAGES[key][lang].length} characters`);
  }
});

test('the vehicle carousel and choose-one messages: English is the exact text the code used to hardcode; hi / mr exist and the buttons fit 20 characters', () => {
  const { getSystemMessage } = require('./systemMessages');
  assert.equal(getSystemMessage('vehicleBookThis', 'en'), 'Book this');
  assert.equal(getSystemMessage('vehicleOtherBtn', 'en'), 'Other options');
  assert.equal(getSystemMessage('vehicleOtherPrompt', 'en'), "Don't see the vehicle you want?");
  assert.equal(getSystemMessage('vehicleSeats', 'en', { seats: 4 }), '4 seats');
  assert.equal(getSystemMessage('vehicleTapOne', 'en'), 'Please tap one of the vehicle options above.');
  assert.equal(getSystemMessage('chooseOneOf', 'en'), 'Please choose one of:');
  // no language and an unknown one fall back to English
  assert.equal(getSystemMessage('vehicleBookThis'), 'Book this');
  assert.equal(getSystemMessage('vehicleBookThis', 'xx'), 'Book this');
  for (const key of ['vehicleBookThis', 'vehicleOtherBtn']) {
    for (const lang of ['en', 'hi', 'mr']) assert.ok([...getSystemMessage(key, lang)].length <= 20, `${key} ${lang}`);
  }
  for (const key of ['vehicleSeats', 'vehicleBookThis', 'vehicleOtherPrompt', 'vehicleOtherBtn', 'vehicleTapOne', 'chooseOneOf']) {
    for (const lang of ['hi', 'mr']) {
      assert.notEqual(getSystemMessage(key, lang, { seats: 4 }), getSystemMessage(key, 'en', { seats: 4 }), `${key} ${lang}`);
    }
  }
  assert.equal(getSystemMessage('vehicleSeats', 'hi', { seats: 7 }), '7 सीटें');
});
