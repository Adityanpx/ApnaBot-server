// Run: node --test src/services/categoryFeature.service.test.js
// Supabase is replaced by an in-memory stand-in for the two tables.
const test = require('node:test');
const assert = require('node:assert/strict');

const tables = { category_features: [], business_features: [] };
const supabasePath = require.resolve('../config/supabase');
const query = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (col, val) => { filters.push([col, val]); return q; },
    maybeSingle: async () => ({ data: tables[table].find(r => filters.every(([c, v]) => r[c] === v)) || null, error: null }),
    then: (resolve) => resolve({ data: tables[table].filter(r => filters.every(([c, v]) => r[c] === v)), error: null }),
    upsert: async (row) => { tables[table] = tables[table].filter(r => !(r.business_id === row.business_id && r.feature === row.feature)); tables[table].push(row); return { error: null }; },
    delete: () => ({ eq: (c1, v1) => ({ eq: async (c2, v2) => { tables[table] = tables[table].filter(r => !(r[c1] === v1 && r[c2] === v2)); return { error: null }; } }) })
  };
  return q;
};
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query } };
const svc = require('./categoryFeature.service');

const reset = (categoryOn) => {
  tables.category_features = categoryOn === null ? [] : [{ category: 'coaching', feature: 'bot_builder', is_enabled: categoryOn }];
  tables.business_features = [];
};

test('no override: follows the category switch (as before)', async () => {
  reset(true);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), true);
  reset(false);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), false);
  reset(null);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), false);
});

test('override On wins over category OFF (pilot one institute)', async () => {
  reset(false);
  await svc.setBusinessOverride('daring', 'bot_builder', true);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), true);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'bright'), false);
});

test('override Off wins over category ON; null goes back to the category', async () => {
  reset(true);
  await svc.setBusinessOverride('bright', 'bot_builder', false);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'bright'), false);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), true);
  await svc.setBusinessOverride('bright', 'bot_builder', null);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'bright'), true);
});

test('an override never applies outside the feature\'s categories', async () => {
  reset(true);
  await svc.setBusinessOverride('swanand', 'bot_builder', true);
  assert.equal(await svc.isEnabled('internet_cafe', 'bot_builder', 'swanand'), false);
});

test('listForBusiness: category state, override and result', async () => {
  reset(false);
  await svc.setBusinessOverride('daring', 'bot_builder', true);
  const [f] = await svc.listForBusiness('daring', 'coaching');
  assert.deepEqual({ feature: f.feature, categoryEnabled: f.categoryEnabled, override: f.override, isEnabled: f.isEnabled },
    { feature: 'bot_builder', categoryEnabled: false, override: true, isEnabled: true });
  // bot_builder is coaching-only; followups, opt_in_links and contact_import ('*') apply everywhere.
  assert.deepEqual((await svc.listForBusiness('swanand', 'internet_cafe')).map(f => f.feature), ['followups', 'opt_in_links', 'contact_import']);
});

test('followups: off for every category until switched on; per-business pilot works', async () => {
  reset(null);
  assert.equal(await svc.isEnabled('travels', 'followups', 'sg'), false);
  assert.equal(await svc.isEnabled('multi_brand', 'followups', 'mb'), false);
  await svc.setBusinessOverride('sg', 'followups', true);
  assert.equal(await svc.isEnabled('travels', 'followups', 'sg'), true);
  assert.equal(await svc.isEnabled('travels', 'followups', 'searchcab'), false);
  // bot_builder stays coaching-only
  assert.equal(svc.appliesTo('travels', 'bot_builder'), false);
  assert.deepEqual((await svc.listForBusiness('sg', 'travels')).map(f => [f.feature, f.isEnabled]), [['followups', true], ['opt_in_links', false], ['contact_import', false]]);
});

test('opt_in_links: off for every category until switched on; per-business pilot works', async () => {
  reset(null);
  assert.equal(svc.FEATURES.opt_in_links.categories, '*');
  assert.equal(await svc.isEnabled('travels', 'opt_in_links', 'sg'), false);
  assert.equal(await svc.isEnabled('travels', 'opt_in_links', 'searchcab'), false);
  await svc.setBusinessOverride('sg', 'opt_in_links', true);
  assert.equal(await svc.isEnabled('travels', 'opt_in_links', 'sg'), true);
  assert.equal(await svc.isEnabled('travels', 'opt_in_links', 'searchcab'), false);
});

test("'*' covers every category, including one added later; a list stays a list", async () => {
  reset(null);
  assert.equal(svc.FEATURES.followups.categories, '*');
  assert.equal(svc.appliesTo('pet_shop', 'followups'), true); // not in any list anywhere
  assert.equal(svc.appliesTo('pet_shop', 'bot_builder'), false);
  assert.equal(svc.appliesTo('coaching', 'bot_builder'), true);
  assert.equal(svc.appliesTo('pet_shop', 'no_such_feature'), false);
  assert.deepEqual((await svc.listForCategory('pet_shop')).map(f => f.feature), ['followups', 'opt_in_links', 'contact_import']);
  assert.deepEqual((await svc.listForCategory('coaching')).map(f => f.feature), ['bot_builder', 'followups', 'opt_in_links', 'contact_import']);
  await svc.setBusinessOverride('pets', 'followups', true);
  assert.equal(await svc.isEnabled('pet_shop', 'followups', 'pets'), true);
});

test('contact_import: every category, off until switched on; Search cab AI stays off', async () => {
  reset(null);
  assert.equal(svc.FEATURES.contact_import.categories, '*');
  assert.equal(await svc.isEnabled('travels', 'contact_import', 'sg'), false);
  await svc.setBusinessOverride('sg', 'contact_import', true);
  assert.equal(await svc.isEnabled('travels', 'contact_import', 'sg'), true);
  assert.equal(await svc.isEnabled('travels', 'contact_import', 'searchcab'), false);
});
