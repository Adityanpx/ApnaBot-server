// Run: node --test src/services/tenant.service.test.js
// resolveBusinessByPhoneNumberId only returns an active business whose WhatsApp
// is still connected: account_update (PARTNER_REMOVED etc.) switches
// is_whatsapp_connected off without clearing the IDs, and that must stop the
// webhook from treating the number as a live tenant.
const test = require('node:test');
const assert = require('node:assert/strict');

let businesses; let cache;

const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    maybeSingle: async () => {
      if (table === 'businesses') return { data: businesses.filter(b => filters.every(f => f(b)))[0] || null, error: null };
      return { data: null, error: null }; // no active subscription row
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../config/redis', {
  get: async (k) => cache.get(k) || null,
  set: async (k, v) => { cache.set(k, v); },
  del: async (k) => { cache.delete(k); }
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const tenantService = require('./tenant.service');

const row = (extra = {}) => ({ id: 'b1', name: 'Biz', phone_number_id: 'pn1', is_active: true, is_whatsapp_connected: true, access_token: 'enc', ...extra });

test.beforeEach(() => { businesses = [row()]; cache = new Map(); });

test('an active, connected business resolves', async () => {
  const t = await tenantService.resolveBusinessByPhoneNumberId('pn1');
  assert.equal(t.businessId, 'b1');
});

test('a business marked disconnected does not resolve (IDs and token are still on the row)', async () => {
  businesses = [row({ is_whatsapp_connected: false })];
  assert.equal(await tenantService.resolveBusinessByPhoneNumberId('pn1'), null);
});

test('an inactive business still does not resolve', async () => {
  businesses = [row({ is_active: false })];
  assert.equal(await tenantService.resolveBusinessByPhoneNumberId('pn1'), null);
});

test('after a disconnect the cache entry is cleared so the change takes effect at once', async () => {
  await tenantService.resolveBusinessByPhoneNumberId('pn1'); // cached
  businesses = [row({ is_whatsapp_connected: false })];
  assert.ok((await tenantService.resolveBusinessByPhoneNumberId('pn1')), 'still served from cache until invalidated');
  await tenantService.invalidateTenantCache('pn1');
  assert.equal(await tenantService.resolveBusinessByPhoneNumberId('pn1'), null);
});
