// Run: node --test src/services/languagePicker.service.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const picker = require('./languagePicker.service');

test('2 and 3 languages are reply buttons, 4 are a list', () => {
  const two = picker.buildPicker({ enabledLanguages: ['en', 'hi'], rawSettings: null });
  assert.deepEqual(two.buttons, [{ title: 'English', nextKeyword: 'lang_en' }, { title: 'हिंदी', nextKeyword: 'lang_hi' }]);
  assert.equal(two.listOptions, undefined);

  const three = picker.buildPicker({ enabledLanguages: ['en', 'hi', 'mr'], rawSettings: null });
  assert.equal(three.buttons.length, 3);

  const four = picker.buildPicker({ enabledLanguages: ['en', 'hi', 'mr', 'gu'], rawSettings: null });
  assert.equal(four.buttons, undefined);
  assert.equal(four.listOptions.length, 4);
  assert.deepEqual(four.listOptions[3], { label: 'ગુજરાતી', nextKeyword: 'lang_gu' });
  assert.equal(four.listButtonLabel, 'Language');
});

test('every catalog language fits a button (20) and a list row (24)', () => {
  const { LANGUAGE_CATALOG } = require('../utils/languageCatalog');
  for (const entry of Object.values(LANGUAGE_CATALOG)) assert.ok(entry.name.length <= 20, entry.name);
});

test('the built-in prompt: the long-standing line for en/hi/mr, composed when another language is on', () => {
  assert.equal(picker.defaultPromptLine(['en', 'hi', 'mr']), 'Choose your language / अपनी भाषा चुनें');
  assert.equal(picker.defaultPromptLine(['en', 'ta', 'te']), 'Choose your language / உங்கள் மொழியைத் தேர்ந்தெடுக்கவும் / మీ భాషను ఎంచుకోండి');
});

test('the default prompt follows the English welcome message; an owner prompt replaces both', () => {
  const withWelcome = picker.buildPicker({ enabledLanguages: ['en', 'hi'], rawSettings: null, welcomeMessage: 'Welcome!' });
  assert.equal(withWelcome.text, 'Welcome!\n\nChoose your language / अपनी भाषा चुनें');
  const custom = picker.buildPicker({ enabledLanguages: ['en', 'hi'], rawSettings: { prompt: 'Pick one', promptTranslations: { hi: 'चुनें' } }, welcomeMessage: 'Welcome!' });
  assert.equal(custom.text, 'Pick one');
  const known = picker.buildPicker({ enabledLanguages: ['en', 'hi'], rawSettings: { prompt: 'Pick one', promptTranslations: { hi: 'चुनें' } }, customerLanguage: 'hi' });
  assert.equal(known.text, 'चुनें');
});

test('change keywords: built-in aliases plus the owner word, case-insensitive; typed text only', () => {
  for (const word of ['language', 'LANGUAGE', ' भाषा ', 'bhasha']) assert.equal(picker.isChangeKeyword(word, null), true, word);
  assert.equal(picker.isChangeKeyword('mylang', null), false);
  assert.equal(picker.isChangeKeyword('MyLang', { changeKeyword: 'mylang' }), true);
  assert.equal(picker.isChangeKeyword('hello', { changeKeyword: 'mylang' }), false);
  assert.equal(picker.isChangeKeyword(undefined, null), false);
});

test('settings default to first_message with no custom prompt', () => {
  assert.deepEqual(picker.resolveSettings(null), { prompt: null, promptTranslations: {}, mode: 'first_message', changeKeyword: null });
  assert.equal(picker.resolveSettings({ mode: 'bogus' }).mode, 'first_message');
});

test('validateSettingsInput: modes, prompt length, translations only for enabled non-English languages, keyword rules', () => {
  const ok = (body, existing = null) => picker.validateSettingsInput(body, existing, ['en', 'hi', 'gu']);
  assert.deepEqual(ok({ mode: 'off' }).value, { mode: 'off' });
  assert.match(ok({ mode: 'always' }).error, /mode must be one of: first_message, off/);
  assert.match(ok({ prompt: 'x'.repeat(501) }).error, /500 characters/);
  assert.deepEqual(ok({ promptTranslations: { gu: ' નમસ્તે ' } }).value, { promptTranslations: { gu: 'નમસ્તે' } });
  assert.match(ok({ promptTranslations: { ta: 'x' } }).error, /not an enabled language/);
  assert.match(ok({ promptTranslations: { en: 'x' } }).error, /invalid language code/);
  assert.match(ok({ promptTranslations: { fr: 'x' } }).error, /invalid language code/);
  assert.deepEqual(ok({ changeKeyword: ' Bhasha2 ' }).value, { changeKeyword: 'bhasha2' });
  assert.match(ok({ changeKeyword: 'two words' }).error, /single word/);
  assert.match(ok({ changeKeyword: 'menu' }).error, /already used/);
  assert.match(ok({ changeKeyword: 'stop' }).error, /already used/);
  assert.match(ok('nope').error, /must be an object/);
});

test('validateSettingsInput merges into what is stored; null clears a setting and an empty result stores NULL', () => {
  const existing = { mode: 'off', prompt: 'Pick', changeKeyword: 'mylang' };
  assert.deepEqual(picker.validateSettingsInput({ prompt: null }, existing, ['en']).value, { mode: 'off', changeKeyword: 'mylang' });
  assert.deepEqual(picker.validateSettingsInput({ mode: null }, existing, ['en']).value, { prompt: 'Pick', changeKeyword: 'mylang' });
  assert.equal(picker.validateSettingsInput({}, null, ['en']).value, null);
});

test('the Language node for the canvas', () => {
  const node = picker.buildLanguageNode({ enabledLanguages: ['en', 'hi', 'mr', 'gu'], languagePicker: { mode: 'off', changeKeyword: 'mylang' } });
  assert.equal(node.id, 'language');
  assert.equal(node.type, 'language');
  assert.equal(node.pickerKind, 'list');
  assert.deepEqual(node.languages.map(l => l.code), ['en', 'hi', 'mr', 'gu']);
  assert.equal(node.picker.mode, 'off');
  assert.equal(node.picker.changeKeyword, 'mylang');
  assert.deepEqual(node.picker.builtInKeywords, ['language', 'भाषा', 'bhasha']);
  assert.equal(picker.buildLanguageNode({ enabledLanguages: ['en'] }).pickerKind, 'none');
  assert.equal(picker.buildLanguageNode({ enabledLanguages: ['en', 'hi'] }).pickerKind, 'buttons');
  assert.equal(picker.buildLanguageNode({}).pickerKind, 'none');
});
