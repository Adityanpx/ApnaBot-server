// Run: node --test src/scripts/cleanTranslatedLabels.test.js
// The pure planning only - the script itself is never run here.
const test = require('node:test');
const assert = require('node:assert/strict');

const p = require.resolve('../config/supabase');
require.cache[p] = { id: p, filename: p, loaded: true, exports: { from: () => { throw new Error('no database in this test'); } } };
const { planRouteCleanup, planCacheCleanup } = require('./cleanTranslatedLabels');
const { textHash, shapeRouteAuto } = require('../utils/translationSlots');
const { sha256 } = require('../services/translation.service');

const route = (extra = {}) => ({
  from_city: 'pune', to_city: 'mumbai airport', from_label: null, to_label: null, region: 'Mumbai & Konkan',
  from_label_translations: { hi: 'पुणे', mr: 'पुणे .' }, to_label_translations: { mr: 'मुंबई विमानतळ .' }, region_translations: { mr: 'मुंबई आणि कोकण' },
  auto_translations: {
    fromLabel: { hi: textHash('पुणे'), mr: textHash('पुणे .') },
    toLabel: { mr: textHash('मुंबई विमानतळ .') },
    region: { mr: textHash('मुंबई आणि कोकण') }
  },
  ...extra
});

test('a machine-made text with a stray " ." is cleaned and its mark follows, so the auto badge stays', () => {
  const r = route();
  const { changes, patch } = planRouteCleanup(r);
  assert.deepEqual(changes.map(c => [c.slot, c.lang, c.to]), [['fromLabel', 'mr', 'पुणे'], ['toLabel', 'mr', 'मुंबई विमानतळ']]);
  assert.deepEqual(patch.from_label_translations, { hi: 'पुणे', mr: 'पुणे' });
  assert.deepEqual(patch.to_label_translations, { mr: 'मुंबई विमानतळ' });
  assert.equal('region_translations' in patch, false, 'untouched columns are not written');
  const after = { ...r, ...patch };
  assert.deepEqual(shapeRouteAuto(after), { fromLabel: ['hi', 'mr'], toLabel: ['mr'], region: ['mr'] });
  assert.equal(r.from_label_translations.mr, 'पुणे .', 'the input row is not mutated');
});

test('hand-edited text (hash mismatch) and unmarked text are never touched', () => {
  const edited = route({ from_label_translations: { hi: 'पुणे', mr: 'पुणे .' }, auto_translations: { fromLabel: { mr: textHash('something the machine said') } } });
  assert.deepEqual(planRouteCleanup(edited), { changes: [], patch: {} });
  const unmarked = route({ auto_translations: null });
  assert.deepEqual(planRouteCleanup(unmarked), { changes: [], patch: {} });
});

test('a clean route changes nothing', () => {
  const clean = route({ from_label_translations: { mr: 'पुणे' }, to_label_translations: null, auto_translations: { fromLabel: { mr: textHash('पुणे') } } });
  assert.deepEqual(planRouteCleanup(clean), { changes: [], patch: {} });
});

test('cache rows: a known source is rewritten cleaned, an unknown source with a stray edge is only listed', () => {
  const rows = [
    { source_hash: sha256('Pune'), target_lang: 'mr', translated_text: 'पुणे .' },
    { source_hash: sha256('Pune'), target_lang: 'hi', translated_text: 'पुणे' },
    { source_hash: sha256('Unknown'), target_lang: 'mr', translated_text: 'काही .' },
    { source_hash: sha256('Fine'), target_lang: 'mr', translated_text: 'ठीक' }
  ];
  const { rewrite, unknown } = planCacheCleanup(rows, new Map([[sha256('Pune'), 'Pune']]));
  assert.deepEqual(rewrite.map(r => [r.source, r.target_lang, r.to]), [['Pune', 'mr', 'पुणे']]);
  assert.deepEqual(unknown.map(r => r.translated_text), ['काही .']);
});
