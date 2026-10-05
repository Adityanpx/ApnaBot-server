// Run: node --test src/controllers/business.connectWhatsapp.test.js
// POST /api/business/connect-whatsapp end to end: real controller and real
// onboarding service, with Meta (axios), Supabase, the business/tenant services
// and the queues stubbed - nothing touches a database, Redis or WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = 'b1';

let config; let metaCalls; let node; let registerError; let syncFails; let previous; let otherOwner;
let saved; let invalidated; let marked; let pinRows;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('axios', {
  get: async (url, opts) => {
    metaCalls.push(['get', url]);
    if (url.endsWith('/oauth/access_token')) return { data: { access_token: 'TOK' } };
    if (/\/222$/.test(url)) return { data: node };
    throw new Error(`unexpected GET ${url}`);
  },
  post: async (url, body) => {
    metaCalls.push(['post', url, body]);
    if (url.endsWith('/subscribed_apps')) return { data: { success: true } };
    if (url.endsWith('/register')) {
      if (registerError) { const e = new Error('meta'); e.response = { data: { error: registerError } }; throw e; }
      return { data: { success: true } };
    }
    if (url.endsWith('/smb_app_data')) {
      if (syncFails) { const e = new Error('meta'); e.response = { data: { error: { code: 1 } } }; throw e; }
      return { data: { request_id: 'R' } };
    }
    throw new Error(`unexpected POST ${url}`);
  }
});
stub('../config/env', new Proxy({}, { get: (_, k) => config[k] }));
stub('../config/supabase', {
  from: () => {
    const filters = []; let patch = null;
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push(r => r[c] === v); return q; },
      is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
      update: (p) => { patch = p; return q; },
      maybeSingle: async () => ({ data: pinRows.find(r => filters.every(f => f(r))) || null, error: null }),
      then: (resolve, reject) => {
        if (patch) pinRows.filter(r => filters.every(f => f(r))).forEach(r => Object.assign(r, patch));
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
    };
    return q;
  }
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { encrypt: (t) => `enc(${t})`, decrypt: (t) => t.replace(/^enc\((.*)\)$/, '$1'), generateWebhookToken: () => 'x' });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
stub('../services/business.service', {
  getBusinessById: async () => previous,
  getBusinessByPhoneNumberId: async () => otherOwner,
  connectWhatsapp: async (id, data) => {
    saved = { id, ...data };
    return { id, name: 'Biz', accessToken: 'enc(TOK)', whatsappRegisterPin: 'enc(123456)', phoneNumberId: data.phoneNumberId };
  },
  markCoexSyncRequested: async (id, accepted) => { marked = accepted; },
  flattenTravelSettings: (b) => b
});
stub('../services/tenant.service', { invalidateTenantCache: async (id) => { invalidated.push(id); } });
stub('../services/subscription.service', { invalidateSubscriptionCache: async () => {} });
stub('../services/booking.service', {});
stub('../services/businessCategory.service', {});
stub('../services/auth.service', { generateTokens: () => ({}), saveTokenToRedis: async () => {} });
stub('../services/r2.service', {});
stub('../services/templateSync.service', { runSync: async () => {} });

const { connectWhatsapp } = require('./business.controller');

const NODE_A = { id: '222', display_phone_number: '+91 98765 43210', verified_name: 'Acme', name_status: 'APPROVED', platform_type: 'NOT_APPLICABLE', is_on_biz_app: false };
const NODE_COEX = { id: '222', display_phone_number: '+91 98765 43210', verified_name: 'Acme', name_status: 'APPROVED', platform_type: 'CLOUD_API', is_on_biz_app: true };

const call = async (body) => {
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  let nextErr;
  await connectWhatsapp({ user: { businessId: BIZ }, body }, res, (e) => { nextErr = e; });
  if (nextErr) throw nextErr;
  return res;
};
const posts = (suffix) => metaCalls.filter(c => c[0] === 'post' && c[1].endsWith(suffix));

// parseConnectBody requires numeric ids; the stubbed Meta node lives at /222.
const NUMERIC = { code: 'CODE', wabaId: '111', phoneNumberId: '222' };
const route = (n) => { node = n; };

test.beforeEach(() => {
  config = { META_APP_ID: 'app', META_APP_SECRET: 'secret', COEXISTENCE_SYNC_ENABLED: false };
  metaCalls = []; node = NODE_A; registerError = null; syncFails = false; previous = { id: BIZ, phoneNumberId: null, isWhatsappConnected: false };
  otherOwner = null; saved = null; invalidated = []; marked = null; pinRows = [{ id: BIZ, whatsapp_register_pin: null }];
});


test('Path A (fresh number): registers with the stored PIN, saves cloud_api, returns the new fields', async () => {
  route(NODE_A);
  const res = await call(NUMERIC);
  assert.equal(res.code, 200);
  const reg = posts('/register');
  assert.equal(reg.length, 1);
  assert.deepEqual(Object.keys(reg[0][2]).sort(), ['messaging_product', 'pin']);
  assert.match(reg[0][2].pin, /^[0-9]{6}$/);
  assert.equal(pinRows[0].whatsapp_register_pin, `enc(${reg[0][2].pin})`); // stored encrypted, same PIN
  assert.equal(saved.onboardingType, 'cloud_api');
  assert.ok(saved.connectedAt);
  assert.equal(saved.resetCoexSync, true);
  assert.equal(posts('/smb_app_data').length, 0);
  assert.equal(res.body.data.onboarding_type, 'cloud_api');
  assert.equal(res.body.data.display_phone_number, '+91 98765 43210');
  assert.equal(res.body.data.verified_name, 'Acme');
  assert.equal(res.body.data.name_status, 'APPROVED');
  assert.deepEqual(invalidated, ['222']);
});

test('Path A: /register failing with a PIN mismatch -> clear error, business NOT marked connected', async () => {
  route(NODE_A);
  registerError = { code: 133005, message: 'PIN incorrect' };
  const res = await call(NUMERIC);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /turn off two-step verification/i);
  assert.equal(saved, null);
  assert.deepEqual(invalidated, []);
});

test('the response and the stored PIN never leak: no accessToken, no whatsappRegisterPin', async () => {
  route(NODE_A);
  const res = await call(NUMERIC);
  assert.equal(res.body.data.business.accessToken, undefined);
  assert.equal(res.body.data.business.whatsappRegisterPin, undefined);
  assert.ok(!JSON.stringify(res.body).includes('123456'));
});

test('Path B (coexistence number): never calls /register; flag off -> no syncs, *_requested_at untouched', async () => {
  route(NODE_COEX);
  const res = await call(NUMERIC);
  assert.equal(res.code, 200);
  assert.equal(posts('/register').length, 0);
  assert.equal(posts('/smb_app_data').length, 0);
  assert.equal(marked, null);
  assert.equal(saved.onboardingType, 'coexistence');
  assert.equal(res.body.data.onboarding_type, 'coexistence');
});

test('Path B with the flag on: both syncs requested after the save, and recorded', async () => {
  config.COEXISTENCE_SYNC_ENABLED = true;
  route(NODE_COEX);
  await call(NUMERIC);
  assert.deepEqual(posts('/smb_app_data').map(c => c[2].sync_type), ['smb_app_state_sync', 'history']);
  assert.deepEqual(marked, { contacts: true, history: true });
  assert.equal(posts('/register').length, 0);
});

test('Path B: a failed sync request never fails the onboarding', async () => {
  config.COEXISTENCE_SYNC_ENABLED = true;
  syncFails = true;
  route(NODE_COEX);
  const res = await call(NUMERIC);
  assert.equal(res.code, 200);
  assert.deepEqual(marked, { contacts: false, history: false });
  assert.equal(saved.onboardingType, 'coexistence');
});

test('type: Meta node wins over the client hint', async () => {
  route(NODE_COEX);
  await call({ ...NUMERIC, onboardingType: 'cloud_api' });
  assert.equal(saved.onboardingType, 'coexistence');
  assert.equal(posts('/register').length, 0);
});

test('type: node without is_on_biz_app -> client hint; no hint -> coexistence (and no /register)', async () => {
  const { is_on_biz_app, ...unknown } = NODE_A;
  route(unknown);
  await call({ ...NUMERIC, onboarding_type: 'cloud_api' });
  assert.equal(saved.onboardingType, 'cloud_api');
  assert.equal(posts('/register').length, 1);

  metaCalls = []; saved = null;
  route(unknown);
  await call(NUMERIC);
  assert.equal(saved.onboardingType, 'coexistence');
  assert.equal(posts('/register').length, 0);
});

test('repeat connect of a registered Cloud API number: /register skipped, original connect time kept', async () => {
  route({ ...NODE_A, platform_type: 'CLOUD_API' });
  previous = { id: BIZ, phoneNumberId: '222', isWhatsappConnected: true, whatsappConnectedAt: '2026-10-01T00:00:00Z' };
  const res = await call(NUMERIC);
  assert.equal(res.code, 200);
  assert.equal(posts('/register').length, 0);
  assert.equal(saved.connectedAt, undefined);
  assert.equal(saved.resetCoexSync, false);
});

test('a different number than before: both old and new tenant cache keys are invalidated', async () => {
  route(NODE_A);
  previous = { id: BIZ, phoneNumberId: '999', isWhatsappConnected: true };
  await call(NUMERIC);
  assert.deepEqual(invalidated.sort(), ['222', '999']);
});

test('snake_case body works', async () => {
  route(NODE_COEX);
  const res = await call({ code: 'CODE', waba_id: '111', phone_number_id: '222' });
  assert.equal(res.code, 200);
});

test('validation: missing code / bad ids / bad type -> 400, Meta never called', async () => {
  for (const body of [{ wabaId: '1' }, { code: 'c' }, { code: 'c', wabaId: 'x' }, { code: 'c', wabaId: '1', phoneNumberId: 'p!' }, { code: 'c', wabaId: '1', onboardingType: 'nope' }]) {
    const res = await call(body);
    assert.equal(res.code, 400, JSON.stringify(body));
  }
  assert.equal(metaCalls.length, 0);
});

test('a number already connected to another business -> 409 before Meta is called', async () => {
  otherOwner = { id: 'someone-else' };
  const res = await call(NUMERIC);
  assert.equal(res.code, 409);
  assert.equal(metaCalls.length, 0);
});
