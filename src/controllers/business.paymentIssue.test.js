// Run: node --test src/controllers/business.paymentIssue.test.js
// GET /api/business reports a WhatsApp payment-method problem as paymentIssue
// { since, code } | null and never the raw columns; the owner can dismiss it
// (POST /api/business/payment-issue/dismiss). Services and config are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let business; let dismissResult; let dismissed; let creating;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('../config/env', {});
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { encrypt: (t) => t, decrypt: (t) => t, generateWebhookToken: () => 'x' });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
stub('../services/business.service', {
  getBusinessByOwnerId: async () => (creating ? null : business),
  createBusiness: async () => business,
  updateBusiness: async () => business,
  flattenTravelSettings: (b) => ({ ...b })
});
stub('../services/tenant.service', {});
stub('../services/subscription.service', {});
stub('../services/booking.service', { getPreviewCreditsStatus: () => ({ remaining: 3, resetAt: null }) });
stub('../services/businessCategory.service', { isEnabledCategory: async () => true, getEnabledCategories: async () => [], getAllCategories: async () => [] });
stub('../services/auth.service', { generateTokens: async () => ({ accessToken: 'a', refreshToken: 'r' }), saveTokenToRedis: async () => {} });
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../services/accountHealth.service', {
  ...require('../services/accountHealth.service'),
  dismissPaymentIssue: async (id) => { dismissed.push(id); return dismissResult; }
});
stub('axios', {});

const controller = require('./business.controller');

const call = async (handler, req) => {
  let out; let status;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { out = b; return res; } };
  await handler(req, res, (e) => { throw e; });
  return { status, body: out };
};

test.beforeEach(() => {
  dismissed = []; dismissResult = true; creating = false;
  business = { id: 'b1', name: 'Biz', accessToken: 'secret', paymentIssueAt: null, paymentIssueCode: null };
});

test('no problem: paymentIssue is null and the raw columns are not in the response', async () => {
  const { body } = await call(controller.getBusiness, { user: { userId: 'u', businessId: 'b1' } });
  assert.equal(body.data.paymentIssue, null);
  assert.ok(!('paymentIssueAt' in body.data) && !('paymentIssueCode' in body.data));
  assert.equal(body.data.accessToken, undefined);
});

test('a problem is reported as { since, code } only', async () => {
  business.paymentIssueAt = '2026-10-10T10:00:00.000Z'; business.paymentIssueCode = 131042;
  const { body } = await call(controller.getBusiness, { user: { userId: 'u', businessId: 'b1' } });
  assert.deepEqual(body.data.paymentIssue, { since: '2026-10-10T10:00:00.000Z', code: 131042 });
  assert.ok(!('paymentIssueAt' in body.data) && !('paymentIssueCode' in body.data));
});

test('the update response carries paymentIssue too', async () => {
  business.paymentIssueAt = '2026-10-10T10:00:00.000Z'; business.paymentIssueCode = 131042;
  const { body } = await call(controller.updateBusiness, { user: { userId: 'u', businessId: 'b1' }, body: { name: 'New' } });
  assert.deepEqual(body.data.paymentIssue, { since: '2026-10-10T10:00:00.000Z', code: 131042 });
  assert.ok(!('paymentIssueAt' in body.data));
});

test('the create response carries paymentIssue too', async () => {
  creating = true;
  const { status, body } = await call(controller.createBusiness, { user: { userId: 'u', email: 'e@x.test', role: 'owner' }, body: { name: 'Biz', businessCategory: 'travels' } });
  assert.equal(status, 201);
  assert.equal(body.data.business.paymentIssue, null);
  assert.ok(!('paymentIssueAt' in body.data.business));
});

test('dismiss clears the flag for the signed-in business only', async () => {
  const { status, body } = await call(controller.dismissPaymentIssue, { user: { businessId: 'b1' }, params: { businessId: 'other' }, body: { businessId: 'other' } });
  assert.equal(status, 200);
  assert.deepEqual(body.data, { paymentIssue: null });
  assert.deepEqual(dismissed, ['b1']);
});

test('dismiss reports a failure instead of pretending', async () => {
  dismissResult = false;
  const { status } = await call(controller.dismissPaymentIssue, { user: { businessId: 'b1' } });
  assert.equal(status, 500);
});
