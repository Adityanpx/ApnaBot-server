// Run: node --test src/services/flowTranslate.routes.test.js
// translateBusinessFlow fills a business's travel_routes translations: missing slots only, machine marker, the
// translation columns only. The database and Azure are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const db = { routes: [], updates: [], translateCalls: [] };
const query = (table) => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    update: (patch) => ({ eq: (col, id) => { db.updates.push({ table, patch, id }); return Promise.resolve({ error: null }); } }),
    single: async () => ({ data: { flow_fields: null }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve) => resolve({ data: table === 'travel_routes' ? db.routes : [], error: null })
  };
  return builder;
};
stub('../config/supabase', { from: query });
stub('../utils/logger', { error() {}, info() {}, warn() {} });
stub('./chatbot.service', { invalidateRulesCache: async () => {} });
stub('./translation.service', {
  translateTexts: async ({ texts, to }) => {
    db.translateCalls.push(texts);
    return { translations: { [to[0]]: texts.map((t) => `${t}-${to[0]}`) }, warnings: [], charged: 1, usage: null };
  }
});

const { translateBusinessFlow } = require('./flowTranslate.service');

const route = (extra) => ({
  id: 'r1', business_id: 'b1', from_city: 'pune', to_city: 'shirdi', from_label: null, to_label: null, region: 'West',
  from_label_translations: null, to_label_translations: null, region_translations: null, auto_translations: null, ...extra
});

test('fills the missing route texts for the language, marks them machine-made, and writes only the translation columns', async () => {
  db.routes = [route()];
  db.updates = [];
  db.translateCalls = [];
  const out = await translateBusinessFlow({ businessId: 'b1', lang: 'mr', scope: 'flow' });
  assert.equal(out.translated, 3);
  const [update] = db.updates.filter((u) => u.table === 'travel_routes');
  assert.equal(update.id, 'r1');
  assert.deepEqual(Object.keys(update.patch).sort(), ['auto_translations', 'from_label_translations', 'region_translations', 'to_label_translations']);
  assert.deepEqual(update.patch.from_label_translations, { mr: 'Pune-mr' });
  assert.deepEqual(update.patch.to_label_translations, { mr: 'Shirdi-mr' });
  assert.deepEqual(update.patch.region_translations, { mr: 'West-mr' });
  assert.deepEqual(Object.keys(update.patch.auto_translations).sort(), ['fromLabel', 'region', 'toLabel']);
});

test('never overwrites a translation that exists (the owner\'s or an earlier run\'s); a complete route is not written at all', async () => {
  db.routes = [route({ from_label_translations: { mr: 'पुणे' }, to_label_translations: { mr: 'शिर्डी' }, region_translations: { mr: 'पश्चिम' } })];
  db.updates = [];
  db.translateCalls = [];
  const out = await translateBusinessFlow({ businessId: 'b1', lang: 'mr', scope: 'flow' });
  assert.equal(out.translated, 0);
  assert.equal(db.updates.filter((u) => u.table === 'travel_routes').length, 0);

  db.routes = [route({ from_label_translations: { mr: 'पुणे' } })];
  await translateBusinessFlow({ businessId: 'b1', lang: 'mr', scope: 'flow' });
  const [update] = db.updates.filter((u) => u.table === 'travel_routes');
  assert.equal(update.patch.from_label_translations, undefined, 'the existing one is left as it is');
  assert.deepEqual(update.patch.to_label_translations, { mr: 'Shirdi-mr' });
});

test('a language another route already has is kept: only the missing language is added', async () => {
  db.routes = [route({ to_label_translations: { hi: 'शिरडी' } })];
  db.updates = [];
  await translateBusinessFlow({ businessId: 'b1', lang: 'gu', scope: 'flow' });
  const [update] = db.updates.filter((u) => u.table === 'travel_routes');
  assert.deepEqual(update.patch.to_label_translations, { hi: 'शिरडी', gu: 'Shirdi-gu' });
});
