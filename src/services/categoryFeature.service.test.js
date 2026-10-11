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
  // bot_builder is coaching-only; followups, opt_in_links, contact_import and owner_phone_media ('*') apply everywhere.
  assert.deepEqual((await svc.listForBusiness('swanand', 'internet_cafe')).map(f => f.feature), ['followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts']);
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
  assert.deepEqual((await svc.listForBusiness('sg', 'travels')).map(f => [f.feature, f.isEnabled]), [['followups', true], ['opt_in_links', false], ['contact_import', false], ['owner_phone_media', false], ['staff', false], ['broadcasts', false]]);
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
  assert.deepEqual((await svc.listForCategory('pet_shop')).map(f => f.feature), ['followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts']);
  assert.deepEqual((await svc.listForCategory('coaching')).map(f => f.feature), ['bot_builder', 'followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts']);
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

test('owner_phone_media: every category, off until switched on; Search cab AI stays off', async () => {
  reset(null);
  assert.equal(svc.FEATURES.owner_phone_media.categories, '*');
  assert.equal(svc.FEATURES.owner_phone_media.label, "Save owner's phone-app media");
  assert.equal(await svc.isEnabled('travels', 'owner_phone_media', 'sg'), false);
  await svc.setBusinessOverride('sg', 'owner_phone_media', true);
  assert.equal(await svc.isEnabled('travels', 'owner_phone_media', 'sg'), true);
  assert.equal(await svc.isEnabled('travels', 'owner_phone_media', 'searchcab'), false);
});

test('staff / broadcasts: every category, Off until switched on like the other keys; no default flag', async () => {
  reset(null);
  for (const key of ['staff', 'broadcasts']) {
    assert.equal(svc.FEATURES[key].categories, '*');
    assert.equal(svc.FEATURES[key].defaultEnabled, undefined);
    assert.equal(await svc.isEnabled('travels', key, 'searchcab'), false);
    assert.equal(await svc.isEnabled('pet_shop', key, 'pets'), false); // category with no rows at all
    assert.equal(await svc.isEnabled('pet_shop', key), false); // no business id
  }
  assert.equal(svc.FEATURES.staff.label, 'Staff');
  assert.equal(svc.FEATURES.staff.description, 'Staff members and permissions');
  assert.equal(svc.FEATURES.broadcasts.label, 'Broadcasts');
  assert.equal(svc.FEATURES.broadcasts.description, 'Broadcasts to customers');
});

test('staff / broadcasts: a business override On turns them on for that business only', async () => {
  reset(null);
  await svc.setBusinessOverride('sg', 'staff', true);
  await svc.setBusinessOverride('searchcab', 'broadcasts', true);
  assert.equal(await svc.isEnabled('travels', 'staff', 'sg'), true);
  assert.equal(await svc.isEnabled('travels', 'broadcasts', 'sg'), false); // a staff row doesn't switch on broadcasts
  assert.equal(await svc.isEnabled('travels', 'broadcasts', 'searchcab'), true);
  assert.equal(await svc.isEnabled('travels', 'staff', 'searchcab'), false);
  assert.equal(await svc.isEnabled('travels', 'staff', 'newbiz'), false); // a brand-new business: Off
  await svc.setBusinessOverride('sg', 'staff', null);
  assert.equal(await svc.isEnabled('travels', 'staff', 'sg'), false);
});

test('staff / broadcasts: the category switch turns them on for the category; an override Off beats it', async () => {
  reset(null);
  tables.category_features.push({ category: 'travels', feature: 'broadcasts', is_enabled: true });
  assert.equal(await svc.isEnabled('travels', 'broadcasts', 'sg'), true);
  assert.equal(await svc.isEnabled('salon', 'broadcasts', 's1'), false);
  await svc.setBusinessOverride('sg', 'broadcasts', false);
  assert.equal(await svc.isEnabled('travels', 'broadcasts', 'sg'), false);
  const biz = await svc.listForBusiness('sg', 'travels');
  const b = biz.find(f => f.feature === 'broadcasts');
  assert.deepEqual({ c: b.categoryEnabled, o: b.override, e: b.isEnabled }, { c: true, o: false, e: false });
  const st = biz.find(f => f.feature === 'staff');
  assert.deepEqual({ c: st.categoryEnabled, o: st.override, e: st.isEnabled }, { c: false, o: null, e: false });
});

test('every key: no row = off', async () => {
  reset(null);
  for (const key of ['followups', 'opt_in_links', 'contact_import', 'owner_phone_media', 'staff', 'broadcasts']) {
    assert.equal(svc.FEATURES[key].defaultEnabled, undefined);
    assert.equal(await svc.isEnabled('travels', key, 'sg'), false);
  }
  assert.equal(svc.FEATURES.bot_builder.defaultEnabled, undefined);
  assert.equal(await svc.isEnabled('coaching', 'bot_builder', 'daring'), false);
});

test('contact_import no longer promises a broadcast on its own', () => {
  assert.doesNotMatch(svc.FEATURES.contact_import.description, /and broadcast to a group/);
  assert.match(svc.FEATURES.contact_import.description, /while Broadcasts is on/);
});
