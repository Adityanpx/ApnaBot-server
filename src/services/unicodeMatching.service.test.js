// Run: node --test src/services/unicodeMatching.service.test.js
// Effective unicode_matching flag: business value wins, NULL follows the global default, cached ~60s,
// and any read failure falls back to legacy matching (false).
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let businessRow;
let businessError;
let globalValue;
let globalError;
let businessReads;
let globalReads;
stub('../config/supabase', {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => { businessReads += 1; return { data: businessRow, error: businessError }; }
      })
    })
  })
});
stub('../utils/logger', { info() {}, error() {}, warn() {}, debug() {} });
stub('./appConfig.service', {
  getBooleanSetting: async () => { globalReads += 1; if (globalError) throw globalError; return globalValue; }
});

const svc = require('./unicodeMatching.service');
const reset = () => {
  svc.clearCache();
  businessRow = { unicode_matching: null }; businessError = null; globalValue = false; globalError = null;
  businessReads = 0; globalReads = 0;
};

test('resolveEffective: business boolean wins, otherwise the global default', () => {
  assert.equal(svc.resolveEffective(true, false), true);
  assert.equal(svc.resolveEffective(false, true), false);
  assert.equal(svc.resolveEffective(null, true), true);
  assert.equal(svc.resolveEffective(null, false), false);
  assert.equal(svc.resolveEffective(undefined, undefined), false);
});

test('NULL business value follows the global default', async () => {
  reset();
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), false);
  reset(); globalValue = true;
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), true);
});

test('an explicit business value beats the global default, both ways', async () => {
  reset(); globalValue = true; businessRow = { unicode_matching: false };
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), false);
  reset(); globalValue = false; businessRow = { unicode_matching: true };
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), true);
  assert.equal(globalReads, 0); // the global is not even read when the business decides
});

test('reads are cached per business for the TTL', async () => {
  reset(); businessRow = { unicode_matching: true };
  await svc.isUnicodeMatchingEnabled('b1');
  await svc.isUnicodeMatchingEnabled('b1');
  assert.equal(businessReads, 1);
  await svc.isUnicodeMatchingEnabled('b2');
  assert.equal(businessReads, 2);
});

test('a business read error (e.g. the migration is not applied) fails open to false, and is not retried per message', async () => {
  reset(); businessError = new Error('column businesses.unicode_matching does not exist'); globalValue = true;
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), false);
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), false);
  assert.equal(businessReads, 1);
});

test('a global read error fails open to false', async () => {
  reset(); globalError = new Error('app_config down');
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), false);
});

test('a missing business row is treated as NULL', async () => {
  reset(); businessRow = null; globalValue = true;
  assert.equal(await svc.isUnicodeMatchingEnabled('b1'), true);
});
