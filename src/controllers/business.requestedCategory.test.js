// Run: node --test src/controllers/business.requestedCategory.test.js
// POST /api/business with requestedCategoryText (an unlisted business signs up as 'general'):
// validation, what reaches the service, and that a failing notification never fails signup.
const test = require('node:test');
const assert = require('node:assert/strict');

let created; let recorded; let recordImpl; let errors;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', {});
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: (...args) => errors.push(args) });
stub('../utils/crypto', { encrypt: (t) => t, decrypt: (t) => t, generateWebhookToken: () => 'x' });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
stub('../services/business.service', {
  getBusinessByOwnerId: async () => null,
  createBusiness: async (userId, data) => { created.push(data); return { id: 'b1', name: data.name, ...data }; },
  flattenTravelSettings: (b) => ({ ...b })
});
stub('../services/businessRequest.service', {
  REQUESTED_TEXT_MAX: 100,
  recordRequest: (args) => { recorded.push(args); return recordImpl(args); }
});
stub('../services/tenant.service', {});
stub('../services/subscription.service', {});
stub('../services/booking.service', {});
// Live shape: 'general' exists but is switched off (hidden from the signup tiles).
const KNOWN = ['general', 'salon', 'travels']; let disabled = [];
stub('../services/businessCategory.service', {
  isEnabledCategory: async (v) => KNOWN.includes(v) && !disabled.includes(v),
  isKnownCategory: async (v) => KNOWN.includes(v),
  getEnabledCategories: async () => KNOWN.filter((v) => !disabled.includes(v)).map((value) => ({ value })),
  getAllCategories: async () => []
});
stub('../services/auth.service', { generateTokens: async () => ({ accessToken: 'a', refreshToken: 'r' }), saveTokenToRedis: async () => {} });
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../services/trial.service', {});
stub('../services/defaultSetup.service', { applyDefaultSetup: async () => ({}) });
stub('../services/accountHealth.service', { withPaymentIssue: (b) => b, dismissPaymentIssue: async () => {} });
stub('axios', {});

const { createBusiness } = require('./business.controller');

const call = async (body) => {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, cookie() { return res; } };
  await handlerCall(res, body);
  return out;
};
const handlerCall = (res, body) => createBusiness({ user: { userId: 'u1', businessId: null }, body }, res, (e) => { throw e; });

const signup = (extra = {}) => ({ name: 'Rangoli Studio', businessCategory: 'general', ...extra });

test.beforeEach(() => { disabled = []; created = []; recorded = []; errors = []; recordImpl = async () => ({ recorded: true, emailsSent: 1 }); });

test('a normal signup is untouched: no request is recorded and no request field reaches the service', async () => {
  const out = await call(signup());
  assert.equal(out.status, 201);
  assert.equal(created[0].requestedCategoryText, undefined);
  assert.equal(recorded.length, 0);
});

test('requestedCategoryText + a 10-digit phone: business created as general, phone stored as 91 + digits', async () => {
  const out = await call(signup({ requestedCategoryText: '  Rangoli   artist ', requestContactPhone: '98765 43210' }));
  assert.equal(out.status, 201);
  assert.equal(created[0].businessCategory, 'general');
  assert.equal(created[0].requestedCategoryText, 'Rangoli artist', 'trimmed, inner spaces collapsed');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].requestedText, 'Rangoli artist');
  assert.equal(recorded[0].contactPhone, '919876543210');
  assert.equal(recorded[0].userId, 'u1');
  assert.equal(recorded[0].business.id, 'b1');
});

test('an 11-15 digit phone keeps its country code; + and separators are dropped', async () => {
  await call(signup({ requestedCategoryText: 'Florist', requestContactPhone: '+971 50-123 4567' }));
  assert.equal(recorded[0].contactPhone, '971501234567');
});

test('requestedCategoryText needs the general category', async () => {
  const out = await call(signup({ businessCategory: 'salon', requestedCategoryText: 'Florist', requestContactPhone: '9876543210' }));
  assert.equal(out.status, 400);
  assert.equal(created.length, 0);
  assert.equal(recorded.length, 0);
});

test('requestedCategoryText needs a valid contact phone', async () => {
  for (const requestContactPhone of [undefined, '', '   ', '12345', '1234567890123456', 'call me', {}]) {
    const out = await call(signup({ requestedCategoryText: 'Florist', requestContactPhone }));
    assert.equal(out.status, 400, JSON.stringify(requestContactPhone));
  }
  assert.equal(created.length, 0);
});

test('requestedCategoryText: over 100 characters or not a string is a 400; exactly 100 is fine', async () => {
  assert.equal((await call(signup({ requestedCategoryText: 'x'.repeat(101), requestContactPhone: '9876543210' }))).status, 400);
  assert.equal((await call(signup({ requestedCategoryText: 42, requestContactPhone: '9876543210' }))).status, 400);
  assert.equal(created.length, 0);
  assert.equal((await call(signup({ requestedCategoryText: 'x'.repeat(100), requestContactPhone: '9876543210' }))).status, 201);
});

test('a blank or null requestedCategoryText is treated as not sent (no phone needed, no request)', async () => {
  for (const requestedCategoryText of ['', '   ', null]) {
    const out = await call(signup({ requestedCategoryText }));
    assert.equal(out.status, 201, JSON.stringify(requestedCategoryText));
  }
  assert.equal(recorded.length, 0);
  assert.ok(created.every((c) => c.requestedCategoryText === undefined));
});

test('a blank requestedCategoryText on a non-general category does not block signup', async () => {
  assert.equal((await call(signup({ businessCategory: 'salon', requestedCategoryText: '' }))).status, 201);
});

test('unlisted signup succeeds while general is disabled', async () => {
  disabled = ['general'];
  const out = await call(signup({ requestedCategoryText: 'Florist', requestContactPhone: '9876543210' }));
  assert.equal(out.status, 201);
  assert.equal(created[0].businessCategory, 'general');
  assert.equal(recorded.length, 1);
});

test('plain general signup (no requestedCategoryText, or blank) is still rejected while general is disabled', async () => {
  disabled = ['general'];
  for (const extra of [{}, { requestedCategoryText: '   ' }, { requestedCategoryText: null }]) {
    const out = await call(signup(extra));
    assert.equal(out.status, 400, JSON.stringify(extra));
    assert.match(out.body.message || out.body.error || JSON.stringify(out.body), /Invalid business category/);
  }
  assert.equal(created.length, 0);
});

test('other categories are unchanged: enabled works, disabled is rejected, with or without requestedCategoryText', async () => {
  assert.equal((await call(signup({ businessCategory: 'salon' }))).status, 201);
  disabled = ['salon'];
  assert.equal((await call(signup({ businessCategory: 'salon' }))).status, 400);
  assert.equal((await call(signup({ businessCategory: 'salon', requestedCategoryText: 'Florist', requestContactPhone: '9876543210' }))).status, 400);
  assert.equal((await call(signup({ businessCategory: 'nope' }))).status, 400);
  assert.equal(created.length, 1);
});

test('signup succeeds even if recording / notifying rejects or throws', async () => {
  recordImpl = async () => { throw new Error('mail down'); };
  const out = await call(signup({ requestedCategoryText: 'Florist', requestContactPhone: '9876543210' }));
  assert.equal(out.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1, 'the failure is logged');
});

test('signup does not wait for the notification', async () => {
  let release;
  recordImpl = () => new Promise((resolve) => { release = resolve; });
  const out = await call(signup({ requestedCategoryText: 'Florist', requestContactPhone: '9876543210' }));
  assert.equal(out.status, 201, 'answered while recordRequest is still pending');
  release({ recorded: true, emailsSent: 0 });
});
