// Run: node --test src/services/whatsappOnboarding.service.test.js
// Pure rules (body parsing, type derivation, register/sync decisions, Meta error
// mapping) plus the PIN store and the Meta calls against a stubbed axios and an
// in-memory businesses table. No network, database or Redis.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows = [];
let axiosCalls = [];
let axiosHandler = async () => ({ data: {} });

const from = () => {
  const filters = []; let patch = null;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    update: (p) => { patch = p; return q; },
    maybeSingle: async () => ({ data: match()[0] || null, error: null }),
    then: (resolve, reject) => {
      if (patch) match().forEach(r => Object.assign(r, patch));
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('axios', {
  get: (url, opts) => { axiosCalls.push(['get', url, opts]); return axiosHandler('get', url, opts); },
  post: (url, body, opts) => { axiosCalls.push(['post', url, body, opts]); return axiosHandler('post', url, body, opts); }
});
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { encrypt: (t) => `enc(${t})`, decrypt: (t) => t.replace(/^enc\((.*)\)$/, '$1') });
stub('./whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });
const svc = require('./whatsappOnboarding.service');

test.beforeEach(() => { rows = [{ id: 'b1', whatsapp_register_pin: null }]; axiosCalls = []; axiosHandler = async () => ({ data: {} }); });

test('parseConnectBody: camelCase and snake_case both work; type is optional', () => {
  assert.deepEqual(svc.parseConnectBody({ code: 'c', wabaId: '123', phoneNumberId: '456' }),
    { code: 'c', wabaId: '123', phoneNumberId: '456', onboardingHint: undefined });
  assert.deepEqual(svc.parseConnectBody({ code: 'c', waba_id: '123', phone_number_id: '456', onboarding_type: 'cloud_api' }),
    { code: 'c', wabaId: '123', phoneNumberId: '456', onboardingHint: 'cloud_api' });
  assert.equal(svc.parseConnectBody({ code: 'c', wabaId: '123' }).phoneNumberId, undefined);
});

test('parseConnectBody: rejects a missing code / waba, non-numeric ids, an unknown type', () => {
  assert.match(svc.parseConnectBody({ wabaId: '1' }).error, /code is required/);
  assert.match(svc.parseConnectBody({ code: 'c' }).error, /Account ID is required/);
  assert.match(svc.parseConnectBody({ code: 'c', wabaId: 'abc' }).error, /must be numeric/);
  assert.match(svc.parseConnectBody({ code: 'c', wabaId: '1', phoneNumberId: '12x' }).error, /Phone number ID must be numeric/);
  assert.match(svc.parseConnectBody({ code: 'c', wabaId: '1', onboardingType: 'other' }).error, /onboardingType must be one of/);
  assert.match(svc.parseConnectBody({ code: ['x'], wabaId: '1' }).error, /code is required/);
});

test('deriveOnboardingType: Meta first, then the client hint, then coexistence', () => {
  assert.deepEqual(svc.deriveOnboardingType(true, 'cloud_api'), { type: 'coexistence', source: 'meta' });
  assert.deepEqual(svc.deriveOnboardingType(false, 'coexistence'), { type: 'cloud_api', source: 'meta' });
  assert.deepEqual(svc.deriveOnboardingType(undefined, 'cloud_api'), { type: 'cloud_api', source: 'client' });
  assert.deepEqual(svc.deriveOnboardingType(null, undefined), { type: 'coexistence', source: 'default' });
  assert.deepEqual(svc.deriveOnboardingType(undefined, 'nonsense'), { type: 'coexistence', source: 'default' });
});

test('shouldRegister: only cloud_api, and not when Meta already says CLOUD_API', () => {
  assert.equal(svc.shouldRegister('cloud_api', 'NOT_APPLICABLE'), true);
  assert.equal(svc.shouldRegister('cloud_api', undefined), true);
  assert.equal(svc.shouldRegister('cloud_api', 'CLOUD_API'), false);
  assert.equal(svc.shouldRegister('coexistence', 'NOT_APPLICABLE'), false);
  assert.equal(svc.shouldRegister('coexistence', 'CLOUD_API'), false);
});

test('mapRegisterError: PIN mismatch tells the owner to turn off two-step verification', () => {
  const m = svc.mapRegisterError({ response: { data: { error: { code: 133005, message: 'PIN incorrect' } } } });
  assert.equal(m.status, 409);
  assert.match(m.message, /turn off two-step verification/i);
  assert.match(m.message, /WhatsApp Manager/);
});

test('mapRegisterError: rate limits, recently deleted, unknown', () => {
  const code = (c, extra = {}) => svc.mapRegisterError({ response: { data: { error: { code: c, ...extra } } } });
  assert.equal(code(133016).status, 429);
  assert.match(code(133016).message, /10 every 72 hours/);
  assert.equal(code(133008).status, 429);
  assert.equal(code(133009).status, 429);
  assert.equal(code(133015).status, 409);
  const other = code(1, { message: 'boom' });
  assert.equal(other.status, 502);
  assert.match(other.message, /boom/);
  assert.equal(svc.mapRegisterError(new Error('network')).status, 502);
});

test('ensureRegisterPin: creates a 6-digit PIN, stores it encrypted, reuses it next time', async () => {
  const pin = await svc.ensureRegisterPin('b1');
  assert.match(pin, /^[0-9]{6}$/);
  assert.equal(rows[0].whatsapp_register_pin, `enc(${pin})`);
  assert.equal(await svc.ensureRegisterPin('b1'), pin);
});

test('ensureRegisterPin: a stored PIN is never overwritten', async () => {
  rows[0].whatsapp_register_pin = 'enc(123456)';
  assert.equal(await svc.ensureRegisterPin('b1'), '123456');
  assert.equal(rows[0].whatsapp_register_pin, 'enc(123456)');
});

test('registerNumber: posts messaging_product + pin to /register with the token', async () => {
  await svc.registerNumber('P1', 'TOKEN', '654321');
  const [method, url, body, opts] = axiosCalls[0];
  assert.equal(method, 'post');
  assert.equal(url, 'https://graph.test/v25.0/P1/register');
  assert.deepEqual(body, { messaging_product: 'whatsapp', pin: '654321' });
  assert.equal(opts.headers.Authorization, 'Bearer TOKEN');
});

test('fetchPhoneNode: asks for is_on_biz_app; if Meta rejects it, re-reads without', async () => {
  axiosHandler = async (m, url, opts) => {
    if (opts.params.fields.includes('is_on_biz_app')) { const e = new Error('bad field'); e.response = { status: 400, data: {} }; throw e; }
    return { data: { id: 'P1', platform_type: 'CLOUD_API' } };
  };
  const node = await svc.fetchPhoneNode('P1', 'T');
  assert.equal(node.platform_type, 'CLOUD_API');
  assert.equal(axiosCalls.length, 2);
  assert.ok(axiosCalls[0][2].params.fields.includes('is_on_biz_app'));
  assert.ok(!axiosCalls[1][2].params.fields.includes('is_on_biz_app'));
});

test('fetchPhoneNode: any other failure propagates', async () => {
  axiosHandler = async () => { const e = new Error('down'); e.response = { status: 500, data: {} }; throw e; };
  await assert.rejects(() => svc.fetchPhoneNode('P1', 'T'), /down/);
});

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00Z');

test('decideSyncs: off unless the flag is on, and only for coexistence', () => {
  assert.deepEqual(svc.decideSyncs({ flagOn: false, type: 'coexistence', existing: null, phoneNumberId: 'P', nowMs: NOW }),
    { contacts: false, history: false, reason: 'flag off' });
  assert.equal(svc.decideSyncs({ flagOn: true, type: 'cloud_api', existing: null, phoneNumberId: 'P', nowMs: NOW }).contacts, false);
  assert.deepEqual(svc.decideSyncs({ flagOn: true, type: 'coexistence', existing: null, phoneNumberId: 'P', nowMs: NOW }),
    { contacts: true, history: true, reason: null });
});

test('decideSyncs: a different number than before is a fresh onboarding', () => {
  const existing = { phoneNumberId: 'OLD', whatsappConnectedAt: new Date(NOW - 100 * HOUR).toISOString(), coexContactsSyncRequestedAt: 'x', coexHistorySyncRequestedAt: 'x' };
  const d = svc.decideSyncs({ flagOn: true, type: 'coexistence', existing, phoneNumberId: 'NEW', nowMs: NOW });
  assert.deepEqual([d.contacts, d.history], [true, true]);
});

test('decideSyncs: same-number reconnect - inside 24h only what was never requested; after 24h nothing', () => {
  const base = { phoneNumberId: 'P', whatsappConnectedAt: new Date(NOW - 2 * HOUR).toISOString(), coexContactsSyncRequestedAt: null, coexHistorySyncRequestedAt: null };
  assert.deepEqual(svc.decideSyncs({ flagOn: true, type: 'coexistence', existing: base, phoneNumberId: 'P', nowMs: NOW }), { contacts: true, history: true, reason: null });

  const contactsDone = { ...base, coexContactsSyncRequestedAt: '2026-10-05T10:00:00Z' };
  const d = svc.decideSyncs({ flagOn: true, type: 'coexistence', existing: contactsDone, phoneNumberId: 'P', nowMs: NOW });
  assert.deepEqual([d.contacts, d.history], [false, true]);

  const old = { ...base, whatsappConnectedAt: new Date(NOW - 25 * HOUR).toISOString() };
  const late = svc.decideSyncs({ flagOn: true, type: 'coexistence', existing: old, phoneNumberId: 'P', nowMs: NOW });
  assert.deepEqual([late.contacts, late.history], [false, false]);
  assert.match(late.reason, /24h/);
});

test('decideSyncs: a same-number reconnect with no recorded connect time (older business) is skipped', () => {
  const d = svc.decideSyncs({ flagOn: true, type: 'coexistence', existing: { phoneNumberId: 'P', whatsappConnectedAt: null }, phoneNumberId: 'P', nowMs: NOW });
  assert.deepEqual([d.contacts, d.history], [false, false]);
});

test('requestCoexistenceSyncs: sends the two documented bodies, contacts first', async () => {
  axiosHandler = async () => ({ data: { messaging_product: 'whatsapp', request_id: 'R' } });
  const accepted = await svc.requestCoexistenceSyncs('P1', 'T', { contacts: true, history: true });
  assert.deepEqual(accepted, { contacts: true, history: true });
  assert.deepEqual(axiosCalls.map(c => [c[1], c[2]]), [
    ['https://graph.test/v25.0/P1/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }],
    ['https://graph.test/v25.0/P1/smb_app_data', { messaging_product: 'whatsapp', sync_type: 'history' }]
  ]);
});

test('requestCoexistenceSyncs: one failing does not stop the other and is not thrown', async () => {
  axiosHandler = async (m, url, body) => {
    if (body.sync_type === 'smb_app_state_sync') { const e = new Error('nope'); e.response = { data: { error: { code: 1 } } }; throw e; }
    return { data: { request_id: 'R' } };
  };
  assert.deepEqual(await svc.requestCoexistenceSyncs('P1', 'T', { contacts: true, history: true }), { contacts: false, history: true });
});

test('requestCoexistenceSyncs: only requests what was asked for', async () => {
  await svc.requestCoexistenceSyncs('P1', 'T', { contacts: false, history: true });
  assert.equal(axiosCalls.length, 1);
  assert.equal(axiosCalls[0][2].sync_type, 'history');
});
