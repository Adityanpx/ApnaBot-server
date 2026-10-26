// Run: node --test src/routes/appConfig.routes.test.js
// Mobile app version gate: public GET /api/app/version and superadmin
// GET|PUT /api/admin/app-config. The real routes, controller, service and role
// middleware run; auth, logger and the DB (app_config, users) are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const tables = { app_config: [], users: [] };
let failReads = false;
let appConfigReads = 0;
let clock = 0;
const logs = [];

const SEED_AT = '2026-10-18T00:00:00.000Z';
const seed = () => [
  { key: 'android_min_version', value: '1.0.0' },
  { key: 'android_latest_version', value: '1.0.0' },
  { key: 'force_update', value: 'false' },
  { key: 'maintenance_mode', value: 'false' },
  { key: 'play_store_url', value: 'https://play.google.com/store/apps/details?id=com.averixsolutions.apnabot' }
].map(r => ({ ...r, updated_at: SEED_AT, updated_by: null }));

const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    in: (col, vals) => { filters.push(r => vals.includes(r[col])); return q; },
    upsert: async (rows) => {
      for (const row of rows) {
        const existing = tables[table].find(r => r.key === row.key);
        clock += 1000;
        const updated_at = new Date(Date.parse(SEED_AT) + clock).toISOString();
        if (existing) Object.assign(existing, row, { updated_at });
        else tables[table].push({ ...row, updated_at });
      }
      return { error: null };
    },
    then: (resolve) => {
      if (table === 'app_config') {
        appConfigReads += 1;
        if (failReads) return resolve({ data: null, error: new Error('db down') });
      }
      return resolve({ data: tables[table].filter(r => filters.every(f => f(r))).map(r => ({ ...r })), error: null });
    }
  };
  return q;
};
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (msg, meta) => logs.push({ msg, meta }),
  warn: () => {},
  error: () => {}
});
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    if (req.headers['x-anon']) return res.status(401).json({ success: false, message: 'No token provided' });
    req.user = { userId: req.headers['x-user'] || 'admin-1', role: req.headers['x-role'] || 'superadmin' };
    next();
  }
});

const appConfig = require('../services/appConfig.service');

const app = express();
app.use(express.json());
app.use('/api/admin/app-config', require('./appConfigAdmin.routes'));
app.use('/api/app', require('./appVersion.routes'));
app.use(require('../middleware/errorHandler.middleware'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

test.beforeEach(() => {
  tables.app_config = seed();
  tables.users = [
    { id: 'admin-1', name: 'Suresh Gavali', email: 'suresh@example.com' },
    { id: 'admin-2', name: '', email: 'second@example.com' }
  ];
  failReads = false;
  appConfigReads = 0;
  logs.length = 0;
  appConfig.clearCache();
});

const getVersion = () => fetch(`${base}/app/version`);
const adminGet = (headers = {}) => fetch(`${base}/admin/app-config`, { headers });
const adminPut = (body, headers = {}) => fetch(`${base}/admin/app-config`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('public: seeded values in the usual wrapper, booleans real, Cache-Control 60s, no auth needed', async () => {
  const res = await getVersion();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    minimumVersion: '1.0.0',
    latestVersion: '1.0.0',
    forceUpdate: false,
    maintenanceMode: false,
    storeUrl: 'https://play.google.com/store/apps/details?id=com.averixsolutions.apnabot',
    supportWhatsappNumber: '',
    supportMessage: 'Hi, I need help with ApnaBot. Business: {{businessName}}, email: {{email}}'
  });
});

test('public: missing rows fall back to the defaults', async () => {
  tables.app_config = [];
  const { data } = await (await getVersion()).json();
  assert.equal(data.minimumVersion, '1.0.0');
  assert.equal(data.latestVersion, '1.0.0');
  assert.equal(data.forceUpdate, false);
  assert.equal(data.maintenanceMode, false);
  assert.match(data.storeUrl, /^https:\/\/play\.google\.com\//);
});

test('public: maintenance_mode on does not block the endpoint - it is reported', async () => {
  tables.app_config.find(r => r.key === 'maintenance_mode').value = 'true';
  const res = await getVersion();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.maintenanceMode, true);
});

test('public: cached for 60s, and a write clears the cache', async () => {
  await getVersion();
  await getVersion();
  assert.equal(appConfigReads, 1, 'second call is served from the cache');

  // A change straight in the table is invisible until the cache expires...
  tables.app_config.find(r => r.key === 'force_update').value = 'true';
  assert.equal((await (await getVersion()).json()).data.forceUpdate, false);

  // ...but a PUT invalidates it at once.
  const put = await adminPut({ androidLatestVersion: '1.2.0' });
  assert.equal(put.status, 200);
  const { data } = await (await getVersion()).json();
  assert.equal(data.latestVersion, '1.2.0');
  assert.equal(data.forceUpdate, true);
});

test('public: DB failure fails open with defaults, is not browser-cached and not server-cached', async () => {
  failReads = true;
  const res = await getVersion();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { data } = await res.json();
  assert.equal(data.forceUpdate, false);
  assert.equal(data.maintenanceMode, false);
  assert.equal(data.minimumVersion, '1.0.0');

  failReads = false;
  tables.app_config.find(r => r.key === 'android_latest_version').value = '2.0.0';
  assert.equal((await (await getVersion()).json()).data.latestVersion, '2.0.0', 'the fallback was not cached');
});

test('public: a malformed stored value falls back to the default instead of leaking', async () => {
  tables.app_config.find(r => r.key === 'android_min_version').value = 'banana';
  tables.app_config.find(r => r.key === 'force_update').value = 'yes';
  const { data } = await (await getVersion()).json();
  assert.equal(data.minimumVersion, '1.0.0');
  assert.equal(data.forceUpdate, false);
});

test('admin: 401 without a token, 403 for owner and staff, on both GET and PUT', async () => {
  assert.equal((await adminGet({ 'x-anon': '1' })).status, 401);
  assert.equal((await adminGet({ 'x-role': 'owner' })).status, 403);
  assert.equal((await adminGet({ 'x-role': 'staff' })).status, 403);
  assert.equal((await adminPut({ forceUpdate: true }, { 'x-role': 'owner' })).status, 403);
  assert.equal((await adminPut({ forceUpdate: true }, { 'x-anon': '1' })).status, 401);
  assert.equal(tables.app_config.find(r => r.key === 'force_update').value, 'false', 'nothing was written');
});

test('admin GET before any change: values + updatedAt / updatedBy null', async () => {
  const body = await (await adminGet()).json();
  assert.equal(body.success, true);
  assert.equal(body.data.androidMinVersion, '1.0.0');
  assert.equal(body.data.androidLatestVersion, '1.0.0');
  assert.equal(body.data.forceUpdate, false);
  assert.equal(body.data.maintenanceMode, false);
  assert.match(body.data.playStoreUrl, /^https:/);
  assert.equal(body.data.updatedAt, null);
  assert.equal(body.data.updatedBy, null);
  assert.deepEqual(body.data.keys.forceUpdate, { updatedAt: SEED_AT, updatedBy: null });
});

test('admin PUT: partial update returns the full config with updatedAt and updatedBy (display name)', async () => {
  const res = await adminPut({ androidLatestVersion: '1.3.0', forceUpdate: true });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.androidLatestVersion, '1.3.0');
  assert.equal(data.forceUpdate, true);
  assert.equal(data.androidMinVersion, '1.0.0', 'untouched key keeps its value');
  assert.equal(data.updatedBy, 'Suresh Gavali');
  assert.notEqual(data.updatedAt, null);
  assert.equal(data.keys.forceUpdate.updatedBy, 'Suresh Gavali');
  assert.equal(data.keys.maintenanceMode.updatedBy, null);

  // GET returns the same top-level fields.
  const got = (await (await adminGet()).json()).data;
  assert.equal(got.updatedAt, data.updatedAt);
  assert.equal(got.updatedBy, 'Suresh Gavali');
});

test('admin: top-level updatedAt / updatedBy follow the most recent change; email when no name', async () => {
  await adminPut({ androidLatestVersion: '1.3.0' }, { 'x-user': 'admin-1' });
  await adminPut({ maintenanceMode: true }, { 'x-user': 'admin-2' });
  const { data } = await (await adminGet()).json();
  assert.equal(data.updatedBy, 'second@example.com');
  assert.equal(data.keys.androidLatestVersion.updatedBy, 'Suresh Gavali');
  assert.equal(data.updatedAt, data.keys.maintenanceMode.updatedAt);
});

test('admin: a change whose user was later deleted (updated_by back to NULL) reads as never changed', async () => {
  // on delete set null: updated_by goes back to NULL, indistinguishable from the seed.
  await adminPut({ forceUpdate: true });
  tables.app_config.find(r => r.key === 'force_update').updated_by = null;
  const { data } = await (await adminGet()).json();
  assert.equal(data.updatedAt, null);
  assert.equal(data.updatedBy, null);
});

test('admin PUT: writes are logged with who changed what (old -> new), only for real changes', async () => {
  await adminPut({ androidMinVersion: '1.0.0', androidLatestVersion: '1.4.0' });
  const entry = logs.find(l => l.msg === 'App config changed by superadmin');
  assert.ok(entry);
  assert.equal(entry.meta.userId, 'admin-1');
  assert.deepEqual(entry.meta.changes, { androidLatestVersion: ['1.0.0', '1.4.0'] });

  logs.length = 0;
  const res = await adminPut({ androidLatestVersion: '1.4.0' });
  assert.equal(res.status, 200);
  assert.equal(logs.length, 0, 'a no-op PUT logs nothing');
  assert.equal(tables.app_config.find(r => r.key === 'android_latest_version').updated_by, 'admin-1');
});

test('admin PUT: validation - versions, booleans, https URL, unknown keys, empty body', async () => {
  for (const bad of [
    { androidMinVersion: '1.0' },
    { androidMinVersion: '1.0.0.1' },
    { androidLatestVersion: 'v1.0.0' },
    { androidLatestVersion: 12 },
    { forceUpdate: 'true' },
    { maintenanceMode: 1 },
    { playStoreUrl: 'http://play.google.com/x' },
    { playStoreUrl: 'not a url' },
    { playStoreUrl: 'javascript:alert(1)' },
    { somethingElse: true },
    {}
  ]) {
    const res = await adminPut(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).success, false);
  }
  assert.deepEqual(tables.app_config, seed(), 'a rejected request writes nothing');
});

test('admin PUT: min must not exceed latest (numeric compare, against the stored value too)', async () => {
  assert.equal((await adminPut({ androidMinVersion: '1.0.1' })).status, 400, 'latest is still 1.0.0');
  assert.equal((await adminPut({ androidMinVersion: '2.0.0', androidLatestVersion: '1.9.9' })).status, 400);
  assert.equal((await adminPut({ androidLatestVersion: '1.10.0', androidMinVersion: '1.9.0' })).status, 200, '1.9.0 < 1.10.0 numerically, not as text');
  assert.equal((await adminPut({ androidLatestVersion: '1.5.0' })).status, 400, 'lowering latest below the stored min is rejected');
  assert.equal((await adminPut({ androidMinVersion: '1.10.0' })).status, 200, 'min == latest is allowed');
});

test('admin PUT: a store URL change is saved and shows on the public endpoint', async () => {
  const url = 'https://example.com/get-the-app';
  assert.equal((await adminPut({ playStoreUrl: url })).status, 200);
  assert.equal((await (await getVersion()).json()).data.storeUrl, url);
});

test('compareVersions is numeric per part', () => {
  assert.ok(appConfig.compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(appConfig.compareVersions('1.0.0', '1.0.1') < 0);
  assert.equal(appConfig.compareVersions('2.3.4', '2.3.4'), 0);
});

test('translate caps: editable by the superadmin (whole numbers only) and never part of the public /app/version payload', async () => {
  tables.app_config.push({ key: 'translate_monthly_char_cap', value: '20000', updated_at: SEED_AT, updated_by: null });
  tables.app_config.push({ key: 'translate_global_monthly_cap', value: '1800000', updated_at: SEED_AT, updated_by: null });

  const pub = await (await getVersion()).json();
  assert.deepEqual(Object.keys(pub.data).sort(), ['forceUpdate', 'latestVersion', 'maintenanceMode', 'minimumVersion', 'storeUrl', 'supportMessage', 'supportWhatsappNumber']);
  assert.equal(JSON.stringify(pub).includes('translate'), false);

  const admin = await (await adminGet()).json();
  assert.equal(admin.data.translateMonthlyCharCap, 20000);
  assert.equal(admin.data.translateGlobalMonthlyCap, 1800000);

  for (const bad of [{ translateMonthlyCharCap: -1 }, { translateMonthlyCharCap: '5000' }, { translateMonthlyCharCap: 1.5 }]) {
    assert.equal((await adminPut(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await adminPut({ translateMonthlyCharCap: 50000 })).status, 200);
  assert.equal(tables.app_config.find(r => r.key === 'translate_monthly_char_cap').value, '50000');

  appConfig.clearCache();
  const pubAfter = await (await getVersion()).json();
  assert.equal(JSON.stringify(pubAfter).includes('translate'), false);
});

test('support: number and message are public (before login), default off, and the marks stay as written', async () => {
  const { data } = await (await getVersion()).json();
  assert.equal(data.supportWhatsappNumber, '', 'no number set = no support button');
  assert.match(data.supportMessage, /{{businessName}}/);
  assert.match(data.supportMessage, /{{email}}/);

  const message = 'Hello, I am {{businessName}} ({{email}}) and need help';
  assert.equal((await adminPut({ supportWhatsappNumber: '+91 98765-43210', supportMessage: message })).status, 200);
  const after = (await (await getVersion()).json()).data;
  assert.equal(after.supportWhatsappNumber, '919876543210', 'stored as digits with the country code');
  assert.equal(after.supportMessage, message);
  assert.equal((await (await adminGet()).json()).data.supportWhatsappNumber, '919876543210');
});

test('support: a number can be cleared, an 11-15 digit number keeps its own country code', async () => {
  assert.equal((await adminPut({ supportWhatsappNumber: '971501234567' })).status, 200);
  assert.equal((await (await getVersion()).json()).data.supportWhatsappNumber, '971501234567');
  assert.equal((await adminPut({ supportWhatsappNumber: '' })).status, 200);
  assert.equal((await (await getVersion()).json()).data.supportWhatsappNumber, '');
});

test('support: validation - number shape, message length, types', async () => {
  for (const bad of [
    { supportWhatsappNumber: '12345' },
    { supportWhatsappNumber: '1234567890123456' },
    { supportWhatsappNumber: 'call me' },
    { supportWhatsappNumber: 9876543210 },
    { supportMessage: '' },
    { supportMessage: '   ' },
    { supportMessage: 'x'.repeat(501) },
    { supportMessage: 5 }
  ]) {
    const res = await adminPut(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(tables.app_config, seed(), 'a rejected request writes nothing');
  assert.equal((await adminPut({ supportMessage: 'x'.repeat(500) })).status, 200);
});

test('support: a malformed stored value falls back to the default instead of leaking', async () => {
  tables.app_config.push({ key: 'support_whatsapp_number', value: 'abc', updated_at: SEED_AT, updated_by: null });
  tables.app_config.push({ key: 'support_message', value: '', updated_at: SEED_AT, updated_by: null });
  const { data } = await (await getVersion()).json();
  assert.equal(data.supportWhatsappNumber, '');
  assert.match(data.supportMessage, /ApnaBot/);
});

test('support: the public endpoint answers without a token even though the admin one refuses it', async () => {
  assert.equal((await fetch(`${base}/app/version`, { headers: { 'x-anon': '1' } })).status, 200);
  assert.equal((await adminGet({ 'x-anon': '1' })).status, 401);
});
