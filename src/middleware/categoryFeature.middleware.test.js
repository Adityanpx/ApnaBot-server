// Run: node --test src/middleware/categoryFeature.middleware.test.js
// requireCategoryFeature: next() while the feature is on for the caller's
// business, 404 "Not found" while it's off (or the business is gone), and a
// DB error reaches next(err) (fail closed). supabase and the feature service
// are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let business; let businessError; let enabled; let enabledError;
const asked = [];
const lookups = [];
stub('../config/supabase', {
  from: (table) => ({
    select: () => ({
      eq: (col, val) => ({
        maybeSingle: async () => { lookups.push([table, col, val]); return { data: business, error: businessError }; }
      })
    })
  })
});
stub('../services/categoryFeature.service', {
  isEnabled: async (category, feature, businessId) => {
    asked.push([category, feature, businessId]);
    if (enabledError) throw enabledError;
    return enabled;
  }
});

const { requireCategoryFeature } = require('./categoryFeature.middleware');

test.beforeEach(() => {
  business = { business_category: 'travels' }; businessError = null; enabled = true; enabledError = null;
  asked.length = 0; lookups.length = 0;
});

const run = async () => {
  const out = { status: null, body: null, next: 0, nextArg: undefined };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  const req = { user: { businessId: 'b1' } };
  await requireCategoryFeature('broadcasts')(req, res, (err) => { out.next += 1; out.nextArg = err; });
  return out;
};

test('on: passes through, asking for this feature, category and business', async () => {
  const out = await run();
  assert.equal(out.next, 1);
  assert.equal(out.nextArg, undefined);
  assert.equal(out.status, null);
  assert.equal(out.body, null);
  assert.deepEqual(lookups, [['businesses', 'id', 'b1']]);
  assert.deepEqual(asked, [['travels', 'broadcasts', 'b1']]);
});

test('off: 404 Not found with errors.code FEATURE_DISABLED, next is not called', async () => {
  enabled = false;
  const out = await run();
  assert.equal(out.status, 404);
  assert.equal(out.body.message, 'Not found');
  assert.deepEqual(out.body.errors, { code: 'FEATURE_DISABLED' });
  assert.equal(out.next, 0);
});

test('business not found: 404 without consulting the switch', async () => {
  business = null;
  const out = await run();
  assert.equal(out.status, 404);
  assert.equal(out.body.errors, null);
  assert.equal(out.next, 0);
  assert.equal(asked.length, 0);
});

test('a DB error reading the business reaches next(err), no response sent', async () => {
  businessError = new Error('db down');
  const out = await run();
  assert.equal(out.next, 1);
  assert.equal(out.nextArg.message, 'db down');
  assert.equal(out.status, null);
});

test('a DB error reading the switch reaches next(err) — fail closed, not 404 and not pass-through', async () => {
  enabledError = new Error('switch read failed');
  const out = await run();
  assert.equal(out.next, 1);
  assert.equal(out.nextArg.message, 'switch read failed');
  assert.equal(out.status, null);
});
