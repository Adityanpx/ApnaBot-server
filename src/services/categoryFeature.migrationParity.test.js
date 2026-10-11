// Run: node --test src/services/categoryFeature.migrationParity.test.js
// Every FEATURES key must be accepted by the check constraints on
// category_features and business_features, as set by the newest migration that
// touches them. A new key added to FEATURES without a migration fails here
// instead of failing at the first Super Admin toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '../../supabase/migrations');
const stub = require.resolve('../config/supabase');
require.cache[stub] = { id: stub, filename: stub, loaded: true, exports: {} };
const { FEATURES } = require('./categoryFeature.service');

const keysFor = (table) => {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort().reverse();
  const re = new RegExp(String.raw`alter table ${table} add constraint ${table}_feature_check\s+check \(feature in \(([^)]*)\)\)`, 'i');
  for (const file of files) {
    const m = fs.readFileSync(path.join(migrationsDir, file), 'utf8').match(re);
    if (m) return { file, keys: [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) };
  }
  throw new Error(`no migration sets ${table}_feature_check`);
};

for (const table of ['category_features', 'business_features']) {
  test(`${table}: the newest constraint lists exactly the FEATURES keys`, () => {
    const { file, keys } = keysFor(table);
    assert.deepEqual([...keys].sort(), Object.keys(FEATURES).sort(), `newest constraint is in ${file}`);
  });
}
