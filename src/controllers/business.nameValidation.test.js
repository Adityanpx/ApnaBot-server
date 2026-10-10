// Run: node --test src/controllers/business.nameValidation.test.js
// POST / PUT /api/business: a business name that is empty once trimmed is a
// 400 (it would read as a blank {{businessName}}). Services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let created; let updated;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', {});
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { encrypt: (t) => t, decrypt: (t) => t, generateWebhookToken: () => 'x' });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
stub('../services/business.service', {
  getBusinessByOwnerId: async () => null,
  createBusiness: async (userId, data) => { created.push(data); return { id: 'b1', ...data }; },
  updateBusiness: async (id, data) => { updated.push(data); return { id, ...data }; },
  flattenTravelSettings: (b) => ({ ...b })
});
stub('../services/tenant.service', { invalidateTenantCache: async () => {} });
stub('../services/subscription.service', {});
stub('../services/booking.service', {});
stub('../services/businessCategory.service', { isEnabledCategory: async () => true, getEnabledCategories: async () => [], getAllCategories: async () => [] });
stub('../services/auth.service', { generateTokens: async () => ({ accessToken: 'a', refreshToken: 'r' }), saveTokenToRedis: async () => {} });
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../services/accountHealth.service', { withPaymentIssue: (b) => b, dismissPaymentIssue: async () => {} });
stub('axios', {});

const { createBusiness, updateBusiness } = require('./business.controller');

const call = async (handler, body) => {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, cookie() { return res; } };
  await handler({ user: { userId: 'u1', businessId: handler === updateBusiness ? 'b1' : null }, body }, res, (e) => { throw e; });
  return out;
};

test.beforeEach(() => { created = []; updated = []; });

test('create: a name of only spaces is a 400 and nothing is created', async () => {
  const out = await call(createBusiness, { name: '   \n ', businessCategory: 'general' });
  assert.equal(out.status, 400);
  assert.equal(created.length, 0);
});

test('create: a name with stray spaces is accepted (the service trims it)', async () => {
  const out = await call(createBusiness, { name: 'PrimeCare ', businessCategory: 'general' });
  assert.equal(out.status, 201);
  assert.equal(created.length, 1);
});

test('update: a name of only spaces is a 400 and nothing is updated', async () => {
  const out = await call(updateBusiness, { name: '  ' });
  assert.equal(out.status, 400);
  assert.equal(updated.length, 0);
});

test('update: a request without a name, or with a real one, goes through', async () => {
  assert.equal((await call(updateBusiness, { city: 'Pune' })).status, 200);
  assert.equal((await call(updateBusiness, { name: ' PrimeCare ' })).status, 200);
  assert.equal(updated.length, 2);
});
