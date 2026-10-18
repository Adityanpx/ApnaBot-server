// Run: node --test src/config/categoryFeatures.newCategories.test.js
// clothing_wholesaler and menswear (migration 20261023120000) must be accepted everywhere categories
// are enumerated: the four CHECK constraints stay in sync with each other, the business_categories
// rows exist, and categoryFeatures.js knows them (no features).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORY_DEFAULT_FEATURES, computeFeatureFlags, isTravelFeaturedCategory } = require('./categoryFeatures');

const NEW = ['clothing_wholesaler', 'menswear'];
const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20261023120000_add_clothing_wholesaler_menswear_categories.sql'), 'utf8');

const constraintLists = () => [...sql.matchAll(/add constraint (\w+)\s+check \(([^;]*?)\);/g)].map(m => ({
  name: m[1], values: [...m[2].matchAll(/'([a-z_]+)'/g)].map(v => v[1])
}));

test('the migration recreates all four category constraints with the same list', () => {
  const lists = constraintLists();
  assert.deepEqual(lists.map(l => l.name).sort(), [
    'businesses_business_category_check', 'category_whatsapp_flows_category_check',
    'flow_snapshots_category_check', 'node_library_entries_category_check'
  ]);
  for (const { name, values } of lists) {
    for (const c of NEW) assert.ok(values.includes(c), `${name} accepts ${c}`);
    assert.deepEqual(values, lists[0].values, `${name} lists the same categories as the others`);
    assert.equal(new Set(values).size, values.length, `${name} has no duplicates`);
  }
});

test('the new list is the hotel list plus the two new values (nothing dropped)', () => {
  const hotel = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '20260918120000_add_hotel_category.sql'), 'utf8');
  const hotelValues = [...hotel.split('add constraint businesses_business_category_check')[1].split(';')[0].matchAll(/'([a-z_]+)'/g)].map(v => v[1]);
  assert.deepEqual(constraintLists()[0].values, [...hotelValues, ...NEW]);
});

test('business_categories rows: enabled, icon names for web/Flutter, ordered next to boutique', () => {
  assert.match(sql, /\('menswear', 'Men''s Wear', 'shirt', true, 133\)/);
  assert.match(sql, /\('clothing_wholesaler', 'Clothing Wholesaler', 'warehouse', true, 136\)/);
});

test('categoryFeatures.js: both categories exist with no features and are not travel-featured', () => {
  for (const c of NEW) {
    assert.deepEqual(CATEGORY_DEFAULT_FEATURES[c], []);
    assert.deepEqual(computeFeatureFlags({ businessCategory: c }), {
      enable_fleet: false, enable_distance_fares: false, round_trip_driver_da_enabled: false
    });
    assert.equal(isTravelFeaturedCategory(c), false);
  }
  assert.deepEqual(CATEGORY_DEFAULT_FEATURES.boutique, [], 'boutique unchanged');
  assert.deepEqual(CATEGORY_DEFAULT_FEATURES.travels, ['fleet', 'distanceFares', 'driverDA'], 'travels unchanged');
});

test('every category in the latest constraint has a categoryFeatures entry', () => {
  for (const value of constraintLists()[0].values) {
    assert.ok(value in CATEGORY_DEFAULT_FEATURES || value === 'multi_brand', `${value} missing from CATEGORY_DEFAULT_FEATURES`);
  }
});
