// Run: node --test src/utils/languageCatalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LANGUAGE_CATALOG, STATES, isValidLanguageCode, validateEnabledLanguages, suggestedLanguagesForState,
  canonicalState, catalogList
} = require('./languageCatalog');

test('the catalog has the 11 languages, each with native name, English name and Azure code', () => {
  assert.deepEqual(Object.keys(LANGUAGE_CATALOG), ['en', 'hi', 'mr', 'gu', 'kn', 'ta', 'te', 'ml', 'bn', 'pa', 'or']);
  assert.equal(LANGUAGE_CATALOG.gu.name, 'ગુજરાતી');
  assert.equal(LANGUAGE_CATALOG.or.azure, 'or');
  for (const entry of Object.values(LANGUAGE_CATALOG)) assert.ok(entry.name && entry.englishName && entry.azure);
  assert.equal(isValidLanguageCode('ta'), true);
  assert.equal(isValidLanguageCode('fr'), false);
  assert.equal(catalogList().length, 11);
});

test('Meta template locales: every language but Odia has one', () => {
  assert.equal(LANGUAGE_CATALOG.en.metaTemplate, 'en_US');
  assert.equal(LANGUAGE_CATALOG.or.metaTemplate, null);
  assert.equal(Object.values(LANGUAGE_CATALOG).filter(l => l.metaTemplate).length, 10);
});

test('enabledLanguages: en always included and first, 1 to 4 catalog codes', () => {
  assert.deepEqual(validateEnabledLanguages(['en']), { value: ['en'] });
  assert.deepEqual(validateEnabledLanguages(['en', 'hi', 'gu', 'ta']), { value: ['en', 'hi', 'gu', 'ta'] });
  assert.deepEqual(validateEnabledLanguages(['gu', 'en']), { value: ['en', 'gu'] }, 'en is moved to the front');
  assert.match(validateEnabledLanguages(['en', 'hi', 'gu', 'ta', 'te']).error, /between 1 and 4/);
  assert.match(validateEnabledLanguages([]).error, /between 1 and 4/);
  assert.match(validateEnabledLanguages('en').error, /between 1 and 4/);
  assert.match(validateEnabledLanguages(['en', 'fr']).error, /Invalid language code\(s\): fr/);
  assert.match(validateEnabledLanguages(['en', 'hi', 'hi']).error, /duplicate/);
  assert.match(validateEnabledLanguages(['hi', 'mr']).error, /English cannot be removed/);
});

test('default languages by state', () => {
  const expected = {
    Maharashtra: ['en', 'hi', 'mr'], Gujarat: ['en', 'hi', 'gu'], Karnataka: ['en', 'hi', 'kn'],
    'Tamil Nadu': ['en', 'ta'], Telangana: ['en', 'hi', 'te'], 'Andhra Pradesh': ['en', 'hi', 'te'],
    Kerala: ['en', 'ml'], 'West Bengal': ['en', 'hi', 'bn'], Punjab: ['en', 'hi', 'pa'], Odisha: ['en', 'hi', 'or'],
    Rajasthan: ['en', 'hi'], Delhi: ['en', 'hi']
  };
  for (const [state, languages] of Object.entries(expected)) assert.deepEqual(suggestedLanguagesForState(state), languages, state);
});

test('unknown / missing state -> en, hi; typing is forgiving; every suggestion is valid', () => {
  assert.deepEqual(suggestedLanguagesForState(undefined), ['en', 'hi']);
  assert.deepEqual(suggestedLanguagesForState('Atlantis'), ['en', 'hi']);
  assert.deepEqual(suggestedLanguagesForState('  tamil   NADU '), ['en', 'ta']);
  assert.equal(canonicalState('gujarat'), 'Gujarat');
  assert.equal(canonicalState('Pune'), null);
  assert.equal(STATES.length, 36);
  for (const state of STATES) assert.equal(validateEnabledLanguages(suggestedLanguagesForState(state)).error, undefined, state);
});

test('a suggestion is a copy: changing it does not change the table', () => {
  suggestedLanguagesForState('Gujarat').push('xx');
  assert.deepEqual(suggestedLanguagesForState('Gujarat'), ['en', 'hi', 'gu']);
});
