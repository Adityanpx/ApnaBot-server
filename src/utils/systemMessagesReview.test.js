// Run: node --test src/utils/systemMessagesReview.test.js
// Pure logic behind the system-message review export / import scripts, and the loader fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REVIEW_LANGUAGES, CSV_COLUMNS, buildCsv, parseCsv, checkPlaceholders, exportNotes, validateReviewed, buildLangModule
} = require('./systemMessagesReview');
const { SYSTEM_MESSAGES, BUILT_IN_MESSAGES, REVIEWED_MESSAGES, getSystemMessage, getReviewedMessage } = require('./systemMessages');
const { collectEntries, buildRows } = require('../scripts/exportSystemMessagesForReview');
const { languageFromFileName, mergeMessages, englishByKey } = require('../scripts/importReviewedSystemMessages');

test('the 8 review languages are the ones with no hand-written system messages', () => {
  assert.deepEqual(REVIEW_LANGUAGES, ['gu', 'kn', 'ta', 'te', 'ml', 'bn', 'pa', 'or']);
  for (const entry of Object.values(SYSTEM_MESSAGES)) for (const lang of REVIEW_LANGUAGES) assert.equal(entry[lang], undefined);
});

test('CSV round-trips commas, quotes, line breaks, placeholders and Indic text', () => {
  const rows = [
    { key: 'a', english: 'Hi, "{{name}}"\nLine two *bold*', machine_translation: 'નમસ્તે {{name}}', reviewed_translation: '', notes: 'x; y' },
    { key: 'b', english: 'plain', machine_translation: '', reviewed_translation: ' ઠીક\r\nછે ', notes: '' }
  ];
  const parsed = parseCsv('﻿' + buildCsv(rows));
  assert.deepEqual(parsed.map((r) => r.key), ['a', 'b']);
  assert.equal(parsed[0].english, rows[0].english);
  assert.equal(parsed[0].machine_translation, rows[0].machine_translation);
  assert.equal(parsed[1].reviewed_translation, 'ઠીક\nછે', 'trimmed, CRLF from Excel normalised');
  assert.equal(buildCsv([]).trim(), CSV_COLUMNS.join(','));
});

test('parseCsv rejects a CSV that lost a column', () => {
  assert.throws(() => parseCsv('key,english\r\na,b\r\n'), /missing column\(s\): machine_translation, reviewed_translation, notes/);
});

test('placeholder check is exact (multiset), order-insensitive', () => {
  assert.deepEqual(checkPlaceholders('Hi {{a}} {{b}}', '{{b}} નમસ્તે {{a}}'), { ok: true });
  assert.equal(checkPlaceholders('Hi {{a}}', 'નમસ્તે').ok, false);
  assert.equal(checkPlaceholders('Hi {{a}}', 'નમસ્તે {{a}} {{a}}').ok, false);
  assert.equal(checkPlaceholders('Hi {{a}}', 'નમસ્તે {{ a }}').ok, false);
  assert.deepEqual(checkPlaceholders('Plain', 'સાદું'), { ok: true });
});

test('validateReviewed: empty rows skipped, machine text ignored, bad rows rejected, format only warned', () => {
  const english = { k1: 'Hi {{name}}', k2: 'Plain', k3: 'Go *now*\nplease' };
  const { accepted, rejected, warnings, skippedEmpty } = validateReviewed([
    { key: 'k1', reviewed_translation: 'નમસ્તે {{name}}', machine_translation: 'MACHINE' },
    { key: 'k2', reviewed_translation: '', machine_translation: 'MACHINE' },
    { key: 'k3', reviewed_translation: 'હમણાં જાઓ', machine_translation: '' },
    { key: 'k1', reviewed_translation: 'again {{name}}' },
    { key: 'zz', reviewed_translation: 'x' },
    { key: 'k2', reviewed_translation: 'x {{oops}}' }
  ], english);
  assert.deepEqual(accepted, { k1: 'નમસ્તે {{name}}', k3: 'હમણાં જાઓ' });
  assert.equal(skippedEmpty, 1);
  assert.deepEqual(rejected.map((r) => [r.key, r.reason.split(':')[0]]), [['k1', 'duplicate key in the CSV'], ['zz', 'unknown key'], ['k2', 'placeholders differ']]);
  assert.deepEqual(warnings.map((w) => w.key), ['k3']);
});

test('export: every SYSTEM_MESSAGES key and the built-in line, notes flag placeholders / failures', () => {
  const entries = collectEntries();
  assert.equal(entries.length, Object.keys(SYSTEM_MESSAGES).length + Object.keys(BUILT_IN_MESSAGES).length);
  assert.ok(entries.some((e) => e.key === 'chooseLanguageLine' && e.english === 'Choose your language'));
  assert.match(exportNotes('Hi {{a}} *x*\nb', null), /Keep unchanged: \{\{a\}\}.*bold.*line breaks/);
  const rows = buildRows([{ key: 'k', english: 'Hi' }, { key: 'j', english: 'Yo' }], ['નમસ્તે', null], new Map([[1, 'Placeholder mismatch.']]));
  assert.equal(rows[0].machine_translation, 'નમસ્તે');
  assert.equal(rows[0].reviewed_translation, '');
  assert.equal(rows[1].machine_translation, '');
  assert.match(rows[1].notes, /Machine translation unavailable: Placeholder mismatch/);
});

test('import helpers: language from file name, merge keeps existing keys', () => {
  assert.equal(languageFromFileName('docs/translations-review/system-messages-gu.csv'), 'gu');
  assert.equal(languageFromFileName('system-messages-hi.csv'), null);
  assert.equal(languageFromFileName('other.csv'), null);
  const r = mergeMessages({ a: '1', b: '2', c: '3' }, { b: '2', c: 'new', d: '4' });
  assert.deepEqual(r.merged, { a: '1', b: '2', c: 'new', d: '4' });
  assert.deepEqual([r.added, r.changed, r.unchanged], [['d'], ['c'], ['b']]);
  assert.ok(englishByKey().chooseLanguageLine && englishByKey().webFormPrompt);
});

test('generated module is valid JS with keys in English order and round-trips', () => {
  const src = buildLangModule('gu', { b: 'બી {{x}}', a: 'એ' }, ['a', 'b']);
  assert.match(src, /GENERATED/);
  const mod = { exports: {} };
  new Function('module', src)(mod);
  assert.deepEqual(Object.keys(mod.exports), ['a', 'b']);
  assert.equal(mod.exports.b, 'બી {{x}}');
});

test('getSystemMessage: reviewed text for the 8 languages, English fallback for missing keys / files', () => {
  const { MACHINE_MESSAGES } = require('./systemMessages');
  assert.deepEqual(Object.keys(REVIEWED_MESSAGES).filter((l) => !REVIEW_LANGUAGES.includes(l)), []);
  assert.deepEqual(Object.keys(MACHINE_MESSAGES).filter((l) => !REVIEW_LANGUAGES.includes(l)), []);
  // The real machine files are loaded; isolate this test from them (and from any reviewed file).
  const saved = { reviewed: { ...REVIEWED_MESSAGES }, machine: { ...MACHINE_MESSAGES } };
  for (const lang of REVIEW_LANGUAGES) { delete REVIEWED_MESSAGES[lang]; delete MACHINE_MESSAGES[lang]; }
  try {
    assert.equal(getSystemMessage('webFormButtonText', 'gu'), 'Fill booking form', 'no file yet -> English');
    assert.equal(getReviewedMessage('webFormButtonText', 'gu'), undefined);
    REVIEWED_MESSAGES.gu = { optInConfirmed: 'આભાર! {{business}} તરફથી ઑફર મળશે.', webFormButtonText: '   ' };
    assert.equal(getSystemMessage('optInConfirmed', 'gu', { business: 'SG' }), 'આભાર! SG તરફથી ઑફર મળશે.');
    assert.equal(getSystemMessage('webFormButtonText', 'gu'), 'Fill booking form', 'blank reviewed text -> English');
    assert.equal(getSystemMessage('webFormPrompt', 'gu'), SYSTEM_MESSAGES.webFormPrompt.en, 'missing key -> English');
    assert.equal(getSystemMessage('optInConfirmed', 'ta', { business: 'SG' }), getSystemMessage('optInConfirmed', null, { business: 'SG' }));
    assert.equal(getSystemMessage('webFormButtonText', 'hi'), SYSTEM_MESSAGES.webFormButtonText.hi, 'hi / mr still come from SYSTEM_MESSAGES');
  } finally {
    for (const lang of REVIEW_LANGUAGES) {
      delete REVIEWED_MESSAGES[lang]; delete MACHINE_MESSAGES[lang];
      if (saved.reviewed[lang]) REVIEWED_MESSAGES[lang] = saved.reviewed[lang];
      if (saved.machine[lang]) MACHINE_MESSAGES[lang] = saved.machine[lang];
    }
  }
});

test('the generated machine files are loaded: every machine key is a real key and keeps placeholders, terms and bold', () => {
  const { MACHINE_MESSAGES } = require('./systemMessages');
  assert.deepEqual(Object.keys(MACHINE_MESSAGES).sort(), [...REVIEW_LANGUAGES].sort());
  const english = englishByKey();
  for (const [lang, table] of Object.entries(MACHINE_MESSAGES)) {
    assert.ok(Object.keys(table).length > 70, lang);
    for (const [key, text] of Object.entries(table)) {
      assert.ok(english[key] !== undefined, `${lang}.${key} is not a message key`);
      assert.equal(checkPlaceholders(english[key], text).ok, true, `${lang}.${key} placeholders`);
      assert.equal(require('./systemMessagesReview').checkProtectedTerms(english[key], text), null, `${lang}.${key} protected terms`);
    }
  }
});

test('checkProtectedTerms: every protected word must appear as often as in English', () => {
  const { checkProtectedTerms, PROTECTED_TERMS } = require('./systemMessagesReview');
  assert.deepEqual(PROTECTED_TERMS, ['ApnaBot', 'WhatsApp', 'UPI', 'OTP', 'Razorpay', 'menu', 'STOP', 'START']);
  assert.equal(checkProtectedTerms('Send *menu* or STOP on WhatsApp', 'WhatsApp પર *menu* અથવા STOP મોકલો'), null);
  assert.match(checkProtectedTerms('Send *menu*', 'મેનુ મોકલો'), /"menu" was translated or lost/);
  assert.match(checkProtectedTerms('Pay by UPI', 'UPI UPI'), /"UPI"/);
  assert.equal(checkProtectedTerms('Thanks', 'આભાર'), null);
});

test('validateReviewed can read the machine column; the default column is unchanged', () => {
  const english = { k1: 'Hi {{name}}', k2: 'Plain' };
  const rows = [
    { key: 'k1', reviewed_translation: '', machine_translation: 'MT {{name}}' },
    { key: 'k2', reviewed_translation: 'REV', machine_translation: 'MT bad {{oops}}' }
  ];
  assert.deepEqual(validateReviewed(rows, english).accepted, { k2: 'REV' });
  const machine = validateReviewed(rows, english, 'machine_translation');
  assert.deepEqual(machine.accepted, { k1: 'MT {{name}}' });
  assert.deepEqual(machine.rejected.map((r) => r.key), ['k2'], 'placeholder mismatch is dropped');
});

test('machine module: marked MACHINE-TRANSLATED, valid JS; the reviewed module header is unchanged', () => {
  const machine = buildLangModule('gu', { a: 'એ' }, ['a'], 'machine');
  assert.match(machine, /^\/\/ MACHINE-TRANSLATED system messages for 'gu'.*NOT native-reviewed/);
  const mod = { exports: {} };
  new Function('module', machine)(mod);
  assert.deepEqual(mod.exports, { a: 'એ' });
  assert.match(buildLangModule('gu', { a: 'એ' }, ['a']), /^\/\/ Native-reviewed system messages for 'gu'/);
});

test('lookup order is reviewed, then machine, then English; hi / mr still come from SYSTEM_MESSAGES', () => {
  const { MACHINE_MESSAGES, getMachineMessage } = require('./systemMessages');
  const saved = { reviewed: REVIEWED_MESSAGES.kn, machine: MACHINE_MESSAGES.kn };
  REVIEWED_MESSAGES.kn = { optInConfirmed: 'REVIEWED {{business}}' };
  MACHINE_MESSAGES.kn = { optInConfirmed: 'MACHINE {{business}}', webFormButtonText: 'MACHINE-BTN', webFormPrompt: '  ' };
  try {
    assert.equal(getSystemMessage('optInConfirmed', 'kn', { business: 'SG' }), 'REVIEWED SG', 'reviewed wins');
    assert.equal(getSystemMessage('webFormButtonText', 'kn'), 'MACHINE-BTN', 'machine when not reviewed');
    assert.equal(getReviewedMessage('webFormButtonText', 'kn'), undefined, 'machine text is not "reviewed"');
    assert.equal(getMachineMessage('webFormButtonText', 'kn'), 'MACHINE-BTN');
    assert.equal(getSystemMessage('webFormPrompt', 'kn'), SYSTEM_MESSAGES.webFormPrompt.en, 'blank machine text -> English');
    assert.equal(getSystemMessage('webFormButtonText', 'hi'), SYSTEM_MESSAGES.webFormButtonText.hi);
  } finally {
    REVIEWED_MESSAGES.kn = saved.reviewed; MACHINE_MESSAGES.kn = saved.machine;
    if (saved.reviewed === undefined) delete REVIEWED_MESSAGES.kn;
    if (saved.machine === undefined) delete MACHINE_MESSAGES.kn;
  }
});

test('src/i18n holds only generated files: reviewed <lang>.js or <lang>.machine.js, machine ones carry the marker', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'i18n');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    const m = /^systemMessages\.([a-z]{2})(\.machine)?\.js$/.exec(file);
    assert.ok(m && REVIEW_LANGUAGES.includes(m[1]), `unexpected file in src/i18n: ${file}`);
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/^\/\/ MACHINE-TRANSLATED/.test(source), !!m[2], `${file}: only .machine.js files may be machine-translated, and they must say so`);
  }
});

test('mixedScriptTokens / hasGluedPlaceholder: the checks themselves', () => {
  const { mixedScriptTokens, hasGluedPlaceholder } = require('./systemMessagesReview');
  assert.deepEqual(mixedScriptTokens('offersફર્સ WhatsApp પર *menu* STOP જવાબ {{x}}'), ['offersફર્સ']);
  assert.deepEqual(mixedScriptTokens('WhatsApp-এ পাঠান, IDକୁ ଦିଅ'), ['WhatsApp-এ', 'IDକୁ']);
  assert.deepEqual(mixedScriptTokens('WhatsApp પર STOP ₹{{fare}} 10:30 (GPay, PhonePe) જુઓ.'), [], 'pure-Latin and pure-Indic words are fine');
  assert.equal(hasGluedPlaceholder('{{business}}તરફથી'), true);
  assert.equal(hasGluedPlaceholder('તરફથી{{business}}'), true);
  assert.equal(hasGluedPlaceholder('તરફથી {{business}}, ₹{{fare}}: {{a}}{{b}}'), false);
});

test('machine files: no placeholder glued to a word and no word that mixes Latin with another script', () => {
  const { MACHINE_MESSAGES } = require('./systemMessages');
  const { mixedScriptTokens, hasGluedPlaceholder } = require('./systemMessagesReview');
  for (const [lang, table] of Object.entries(MACHINE_MESSAGES)) {
    for (const [key, text] of Object.entries(table)) {
      assert.equal(hasGluedPlaceholder(text), false, `${lang}.${key}: placeholder glued to a word: ${text}`);
      assert.deepEqual(mixedScriptTokens(text), [], `${lang}.${key}: Latin letters mixed into a word of another script`);
    }
  }
});

test('machine files: every message that went to a customer button fits WhatsApp\'s 20 characters', () => {
  const { MACHINE_MESSAGES } = require('./systemMessages');
  const graphemes = (s) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;
  const buttonKeys = Object.keys(SYSTEM_MESSAGES).filter((k) => SYSTEM_MESSAGES[k].en.length <= 24 && !SYSTEM_MESSAGES[k].en.includes('{{'));
  for (const [lang, table] of Object.entries(MACHINE_MESSAGES)) {
    for (const key of buttonKeys) if (table[key]) assert.ok(graphemes(table[key]) <= 20, `${lang}.${key} is ${graphemes(table[key])} characters`);
  }
});

test('consent texts keep what English says: the business, WhatsApp, offers and updates, and STOP / START', () => {
  const { MACHINE_MESSAGES } = require('./systemMessages');
  for (const [lang, table] of Object.entries(MACHINE_MESSAGES)) {
    for (const key of ['optInConsentQuestion', 'bookingConsentQuestion', 'optInConfirmed']) {
      assert.ok(table[key].includes('{{business}}'), `${lang}.${key} names the business`);
      assert.ok(table[key].includes('STOP'), `${lang}.${key} says STOP`);
    }
    for (const key of ['optInConsentQuestion', 'bookingConsentQuestion']) assert.ok(table[key].includes('WhatsApp'), `${lang}.${key} says WhatsApp`);
    assert.ok(table.stopOptOutDefault.includes('START'), `${lang}.stopOptOutDefault says START`);
    assert.ok(table.startOptInDefault, `${lang} has the START reply`);
    assert.ok(table.optInConsentQuestion.includes('\n\n'), `${lang}.optInConsentQuestion keeps the two paragraphs`);
  }
});
