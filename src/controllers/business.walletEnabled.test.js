// Run: node --test src/controllers/business.walletEnabled.test.js
// GET /api/business exposes walletEnabled (from WALLET_BILLING_ENABLED) so the
// apps can hide wallet UI. Services and config are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let config = {};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('../config/env', new Proxy({}, { get: (_, k) => config[k] }));
stub('../config/supabase', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { encrypt: (t) => t, decrypt: (t) => t, generateWebhookToken: () => 'x' });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
stub('../services/business.service', {
  getBusinessByOwnerId: async () => ({ id: 'b1', name: 'Biz', accessToken: 'secret' }),
  flattenTravelSettings: (b) => ({ ...b })
});
stub('../services/tenant.service', {});
stub('../services/subscription.service', {});
stub('../services/booking.service', { getPreviewCreditsStatus: () => ({ remaining: 3, resetAt: null }) });
stub('../services/businessCategory.service', {});
stub('../services/auth.service', { generateTokens: () => ({}), saveTokenToRedis: async () => {} });
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('axios', {});

const { getBusiness } = require('./business.controller');

const run = async () => {
  let out;
  const res = { status: () => res, json: (b) => { out = b; return res; } };
  await getBusiness({ user: { userId: 'u', businessId: 'b1' } }, res, (e) => { throw e; });
  return out.data;
};

test('walletEnabled is false by default', async () => {
  config = {};
  assert.equal((await run()).walletEnabled, false);
});

test('walletEnabled is true when WALLET_BILLING_ENABLED is on', async () => {
  config = { WALLET_BILLING_ENABLED: true };
  const data = await run();
  assert.equal(data.walletEnabled, true);
  assert.equal(data.accessToken, undefined);
});
