// Run: node --test src/config/categoryFeatures.dataDriven.test.js
// Categories are data (migration 20261031120000): the four category CHECK lists become foreign keys to
// business_categories(value), the table gains emoji + label_translations, mobile_electronics is the first
// row created that way, and categoryFeatures.js treats any category it does not list as "no features".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORY_DEFAULT_FEATURES, computeFeatureFlags, isTravelFeaturedCategory } = require('./categoryFeatures');

const MIGRATIONS = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
const raw = read('20261031120000_data_driven_categories.sql');
const code = raw.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const statements = code.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const NO_FEATURES = { enable_fleet: false, enable_distance_fares: false, round_trip_driver_da_enabled: false };

test('the four category CHECK constraints are dropped by name', () => {
  const dropped = statements
    .map((s) => s.match(/^alter table (\w+) drop constraint (\w+)$/))
    .filter(Boolean).map((m) => `${m[1]}.${m[2]}`).sort();
  assert.deepEqual(dropped, [
    'businesses.businesses_business_category_check',
    'category_whatsapp_flows.category_whatsapp_flows_category_check',
    'flow_snapshots.flow_snapshots_category_check',
    'node_library_entries.node_library_entries_category_check'
  ]);
});

test('they are exactly the constraints the previous category migration re-created (nothing missed)', () => {
  const prev = read('20261023120000_add_clothing_wholesaler_menswear_categories.sql');
  const recreated = [...prev.matchAll(/alter table (\w+) add constraint (\w+)\s+check/g)].map((m) => `${m[1]}.${m[2]}`).sort();
  const dropped = statements.map((s) => s.match(/^alter table (\w+) drop constraint (\w+)$/)).filter(Boolean).map((m) => `${m[1]}.${m[2]}`).sort();
  assert.deepEqual(dropped, recreated);
});

test('each becomes a foreign key to business_categories(value), on update cascade, on delete restrict', () => {
  const fks = statements
    .map((s) => s.match(/^alter table (\w+) add constraint (\w+) foreign key \((\w+)\) references business_categories ?\(value\) on update cascade on delete restrict$/))
    .filter(Boolean).map((m) => `${m[1]}.${m[3]}`).sort();
  assert.deepEqual(fks, [
    'businesses.business_category',
    'category_whatsapp_flows.category',
    'flow_snapshots.category',
    'node_library_entries.category'
  ]);
});

test('no CHECK list is re-added, and the dead tables are left alone', () => {
  assert.doesNotMatch(code, /\bcheck\s*\(/i);
  assert.doesNotMatch(code, /business_type_templates|flow_packs/);
});

test('flow_snapshots.category stays nullable (personal snapshots have none): the FK does not change nullability', () => {
  assert.doesNotMatch(code, /alter column category set not null/i);
  assert.doesNotMatch(code, /alter table flow_snapshots[^;]*not null/i);
});

test('business_categories gains emoji and label_translations with defaults that need no backfill', () => {
  assert.match(code, /alter table business_categories add column if not exists emoji text not null default ''/);
  assert.match(code, /alter table business_categories add column if not exists label_translations jsonb not null default '\{\}'::jsonb/);
});

test('mobile_electronics row: enabled, smartphone icon, emoji, hi + mr translations, order 158, idempotent', () => {
  const insert = statements.find((s) => s.startsWith('insert into business_categories'));
  assert.ok(insert, 'has the insert');
  assert.match(insert, /\(value, label, icon, emoji, label_translations, is_enabled, display_order\)/);
  assert.match(insert, /'mobile_electronics', 'Mobile & Electronics', 'smartphone', '📱'/);
  assert.match(insert, /'\{"hi":"मोबाइल और इलेक्ट्रॉनिक्स","mr":"मोबाइल आणि इलेक्ट्रॉनिक्स"\}'::jsonb, true, 158\)/);
  assert.match(insert, /on conflict \(value\) do nothing$/);
  const translations = JSON.parse(insert.match(/'(\{"hi".*?\})'::jsonb/)[1]);
  assert.deepEqual(Object.keys(translations), ['hi', 'mr']);
});

test('electronics_repair is not touched', () => {
  assert.doesNotMatch(code, /electronics_repair/);
});

test('the header documents the preflight (0 rows) and the deploy order, and the migration is one transaction', () => {
  assert.match(raw, /PREFLIGHT[^\n]*MUST return 0 rows/);
  assert.match(raw, /DEPLOY ORDER: apply this BEFORE deploying the server code/);
  assert.equal(statements[0], 'begin');
  assert.equal(statements[statements.length - 1], 'commit');
  for (const table of ['businesses', 'flow_snapshots', 'category_whatsapp_flows', 'node_library_entries']) {
    assert.match(raw, new RegExp(`from ${table}\\b`), `preflight covers ${table}`);
  }
});

test('categoryFeatures.js: mobile_electronics is listed with no features and is not travel-featured', () => {
  assert.deepEqual(CATEGORY_DEFAULT_FEATURES.mobile_electronics, []);
  assert.deepEqual(computeFeatureFlags({ businessCategory: 'mobile_electronics' }), NO_FEATURES);
  assert.equal(isTravelFeaturedCategory('mobile_electronics'), false);
});

test('categoryFeatures.js: a category it has never heard of means no features, never a crash', () => {
  for (const businessCategory of ['brand_new_category', undefined, null, '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(computeFeatureFlags({ businessCategory }), NO_FEATURES, `category ${JSON.stringify(businessCategory)}`);
  }
  assert.equal(isTravelFeaturedCategory('brand_new_category'), false);
});

test('categoryFeatures.js: multi_brand with unknown sub-categories only collects features from the known ones', () => {
  assert.deepEqual(computeFeatureFlags({ businessCategory: 'multi_brand', subCategories: ['brand_new_category', 'constructor'] }), NO_FEATURES);
  assert.deepEqual(computeFeatureFlags({ businessCategory: 'multi_brand' }), NO_FEATURES);
  assert.deepEqual(
    computeFeatureFlags({ businessCategory: 'multi_brand', subCategories: ['brand_new_category', 'cab'] }),
    { enable_fleet: true, enable_distance_fares: true, round_trip_driver_da_enabled: true }
  );
});

test('categoryFeatures.js: travels / cab defaults are unchanged', () => {
  assert.deepEqual(CATEGORY_DEFAULT_FEATURES.travels, ['fleet', 'distanceFares', 'driverDA']);
  assert.deepEqual(CATEGORY_DEFAULT_FEATURES.cab, ['fleet', 'distanceFares', 'driverDA']);
});
