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
  assert.deepEqual(Object.keys(REVIEWED_MESSAGES).filter((l) => !REVIEW_LANGUAGES.includes(l)), []);
  assert.equal(getSystemMessage('webFormButtonText', 'gu'), 'Fill booking form', 'no reviewed file yet -> English');
  assert.equal(getReviewedMessage('webFormButtonText', 'gu'), undefined);
  REVIEWED_MESSAGES.gu = { optInConfirmed: 'આભાર! {{business}} તરફથી ઑફર મળશે.', webFormButtonText: '   ' };
  try {
    assert.equal(getSystemMessage('optInConfirmed', 'gu', { business: 'SG' }), 'આભાર! SG તરફથી ઑફર મળશે.');
    assert.equal(getSystemMessage('webFormButtonText', 'gu'), 'Fill booking form', 'blank reviewed text -> English');
    assert.equal(getSystemMessage('webFormPrompt', 'gu'), SYSTEM_MESSAGES.webFormPrompt.en, 'missing key -> English');
    assert.equal(getSystemMessage('optInConfirmed', 'ta', { business: 'SG' }), getSystemMessage('optInConfirmed', null, { business: 'SG' }));
    assert.equal(getSystemMessage('webFormButtonText', 'hi'), SYSTEM_MESSAGES.webFormButtonText.hi, 'hi / mr still come from SYSTEM_MESSAGES');
  } finally {
    delete REVIEWED_MESSAGES.gu;
  }
});
