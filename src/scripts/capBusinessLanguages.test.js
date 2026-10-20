// Run: node --test src/scripts/capBusinessLanguages.test.js
// The pure part only - the script itself is never run here.
const test = require('node:test');
const assert = require('node:assert/strict');

const p = require.resolve('../config/supabase');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { from: () => { throw new Error('no database in this test'); } } };
const { capLanguages } = require('./capBusinessLanguages');

test('4 languages -> en + first 2 others, the last is removed', () => {
  assert.deepEqual(capLanguages(['en', 'hi', 'mr', 'gu']), { kept: ['en', 'hi', 'mr'], removed: ['gu'], changed: true });
});

test('at or under the cap is unchanged (Search cab AI en,hi,mr)', () => {
  assert.deepEqual(capLanguages(['en', 'hi', 'mr']), { kept: ['en', 'hi', 'mr'], removed: [], changed: false });
  assert.deepEqual(capLanguages(['en']), { kept: ['en'], removed: [], changed: false });
});

test('en not first is still kept and put first; null / junk is treated as empty', () => {
  assert.deepEqual(capLanguages(['hi', 'en', 'mr', 'gu']), { kept: ['en', 'hi', 'mr'], removed: ['gu'], changed: true });
  assert.deepEqual(capLanguages(null), { kept: ['en'], removed: [], changed: false });
});
