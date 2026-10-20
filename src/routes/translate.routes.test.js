// Run: node --test src/routes/translate.routes.test.js
// The language / auto-translate HTTP surface: public catalog, owner-only translate endpoints
// (400 / 429 / 503 shapes), the Super Admin template translate, PUT /api/business language rules and
// PUT /api/business/language-settings. The real routes, controllers, validators and role middleware
// run; auth, the database and Azure are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let business; let updated; let customerResets; let translateImpl; let flowImpl; let templateImpl; let configured; let templateRow; let usageRow;

stub('../config/env', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    req.user = { userId: 'u1', role: req.headers['x-role'] || 'owner', businessId: req.headers['x-nobiz'] ? null : 'b1' };
    next();
  },
  requireBusiness: (req, res, next) => (req.user.businessId || req.user.role === 'superadmin' ? next() : res.status(403).json({ success: false, message: 'No business' }))
});
stub('../config/supabase', {
  from: (table) => {
    const q = {
      select: () => q, eq: () => q, in: (c, v) => { if (table === 'customers') customerResets.push({ column: c, values: v }); return q; },
      update: (p) => { if (table === 'businesses') updated.push(p); return q; },
      maybeSingle: async () => ({ data: table === 'flow_snapshots' ? templateRow : null, error: null }),
      then: (resolve) => resolve({ error: null, data: [] })
    };
    return q;
  }
});
stub('../services/business.service', {
  getBusinessById: async () => business,
  getBusinessByOwnerId: async () => null,
  updateBusiness: async (id, data) => { updated.push(data); return { id, ...business, ...data }; },
  createBusiness: async (userId, data) => ({ id: 'b9', ...data }),
  flattenTravelSettings: (b) => ({ ...b })
});
stub('../services/tenant.service', { invalidateTenantCache: async () => {} });
stub('../services/translation.service', {
  translateTexts: (args) => translateImpl(args),
  getUsage: async () => usageRow
});
stub('../services/flowTranslate.service', {
  translateBusinessFlow: (args) => flowImpl(args),
  translateTemplate: (args) => templateImpl(args),
  startNewBusinessTranslation: async () => ({ started: false })
});
const realAzure = require('../services/azureTranslate.service');
stub('../services/azureTranslate.service', { ...realAzure, isConfigured: () => configured });
stub('../middleware/rateLimiter.middleware', { translateLimiter: (req, res, next) => next(), helpFeedbackLimiter: (req, res, next) => next(), globalLimiter: (req, res, next) => next() });
// business.controller's other dependencies, unused here
for (const rel of ['../services/subscription.service', '../services/trial.service', '../services/booking.service', '../services/r2.service', '../services/templateSync.service', '../services/whatsappOnboarding.service', '../services/whatsapp.service']) stub(rel, { META_API_BASE: 'x' });
stub('../services/businessCategory.service', { isEnabledCategory: async () => true, getEnabledCategories: async () => [], getAllCategories: async () => [] });
stub('../services/auth.service', { generateTokens: async () => ({ accessToken: 'a', refreshToken: 'r' }) });
stub('../services/defaultSetup.service', { applyDefaultSetup: async () => ({}) });
stub('../services/accountHealth.service', { withPaymentIssue: (b) => b, dismissPaymentIssue: async () => {} });
stub('../utils/crypto', { encrypt: (t) => t, decrypt: (t) => t, generateWebhookToken: () => 'x' });
stub('axios', {});
stub('../controllers/businessMedia.controller', {});
stub('../controllers/publicServiceForm.controller', {});
stub('../controllers/help.controller', {});
stub('../middleware/upload.middleware', {});
stub('../services/flowSnapshot.service', { readBusinessGraphRows: async () => ({}), withNodeDefaults: (r) => r, withEdgeDefaults: (r) => r });

const businessController = require('../controllers/business.controller');
const { requireRole } = require('../middleware/role.middleware');
const authStub = require('../middleware/auth.middleware');

const app = express();
app.use(express.json());
app.use('/api/translate', require('./translate.routes'));
app.use('/api/public/languages', (() => {
  const r = express.Router();
  const languages = require('../controllers/languages.controller');
  r.get('/', languages.getLanguages);
  r.get('/suggested', languages.getSuggestedLanguages);
  return r;
})());
app.put('/api/business', authStub.protect, authStub.requireBusiness, businessController.updateBusiness);
app.get('/api/business/language-settings', authStub.protect, authStub.requireBusiness, businessController.getLanguageSettings);
app.put('/api/business/language-settings', authStub.protect, authStub.requireBusiness, requireRole('owner'), businessController.updateLanguageSettings);
app.post('/api/admin/category-templates/:id/translate', authStub.protect, requireRole('superadmin'), require('../controllers/categoryTemplate.controller').translateTemplate);
app.use(require('../middleware/errorHandler.middleware'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

test.beforeEach(() => {
  business = { id: 'b1', enabledLanguages: ['en', 'hi', 'gu'], languagePicker: null, phoneNumberId: 'pn1' };
  updated = []; customerResets = [];
  configured = true;
  usageRow = { used: 0, cap: 20000, remaining: 20000 };
  templateRow = { id: 't1', nodes: [], edges: [] };
  translateImpl = async ({ texts, to }) => ({
    translations: Object.fromEntries(to.map(l => [l, texts.map(t => `[${l}] ${t}`)])), warnings: [], usage: { used: 12, cap: 20000 }
  });
  flowImpl = async () => ({ language: 'hi', translated: 3, alreadyTranslated: 1, skipped: [], warnings: [], usage: { used: 40, cap: 20000 } });
  templateImpl = async () => ({ language: 'gu', translated: 2, alreadyTranslated: 0, skipped: [], warnings: [], charged: 30 });
});

const json = (method, path, body, headers = {}) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body)
});

// ---- public catalog
test('GET /public/languages: the catalog, the cap of 4 and the state suggestions, nothing else', async () => {
  const { data } = await (await json('GET', '/public/languages')).json();
  assert.deepEqual(Object.keys(data).sort(), ['defaultSuggested', 'languages', 'maxEnabled', 'states']);
  assert.equal(data.languages.length, 11);
  assert.deepEqual(data.languages[3], { code: 'gu', name: 'ગુજરાતી', englishName: 'Gujarati' });
  assert.equal(data.maxEnabled, 3);
  assert.deepEqual(data.states.find(s => s.name === 'Gujarat'), { name: 'Gujarat', suggested: ['en', 'hi', 'gu'] });
  assert.equal(JSON.stringify(data).includes('azure'), false);
});

test('GET /public/languages/suggested', async () => {
  assert.deepEqual((await (await json('GET', '/public/languages/suggested?state=kerala')).json()).data, { state: 'Kerala', suggested: ['en', 'ml'] });
  assert.deepEqual((await (await json('GET', '/public/languages/suggested?state=Nowhere')).json()).data, { state: null, suggested: ['en', 'hi'] });
  assert.deepEqual((await (await json('GET', '/public/languages/suggested')).json()).data, { state: null, suggested: ['en', 'hi'] });
});

// ---- POST /api/translate
test('POST /translate: owner only', async () => {
  const res = await json('POST', '/translate', { texts: ['Hi'], to: ['hi'] }, { 'x-role': 'staff' });
  assert.equal(res.status, 403);
});

test('POST /translate: translations aligned with texts, plus usage', async () => {
  const res = await json('POST', '/translate', { texts: ['Hi', 'Bye'], to: ['hi', 'gu'] });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.deepEqual(data.translations, { hi: ['[hi] Hi', '[hi] Bye'], gu: ['[gu] Hi', '[gu] Bye'] });
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.usage, { used: 12, cap: 20000, remaining: 19988 });
});

test('POST /translate: 400 for bad input and for languages the business has not enabled', async () => {
  const cases = [
    [{ texts: [], to: ['hi'] }, /1 to 100/],
    [{ texts: 'Hi', to: ['hi'] }, /1 to 100/],
    [{ texts: [1], to: ['hi'] }, /texts\[0\]/],
    [{ texts: ['x'.repeat(4097)], to: ['hi'] }, /texts\[0\]/],
    [{ texts: ['Hi'] }, /non-empty array/],
    [{ texts: ['Hi'], to: [] }, /non-empty array/],
    [{ texts: ['Hi'], to: ['en'] }, /source language/],
    [{ texts: ['Hi'], to: ['xx'] }, /Unknown language/],
    [{ texts: ['Hi'], to: ['ta'] }, /not one of your enabled languages/],
    [{ texts: ['Hi'], to: ['hi', 'hi'] }, /duplicate/]
  ];
  for (const [body, pattern] of cases) {
    const res = await json('POST', '/translate', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).message, pattern);
  }
});

test('POST /translate: 503 with a clear message when Azure is not configured', async () => {
  configured = false;
  const res = await json('POST', '/translate', { texts: ['Hi'], to: ['hi'] });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.message, /not configured/);
  assert.deepEqual(body.errors, { code: 'TRANSLATE_NOT_CONFIGURED' });
});

test('POST /translate: 429 with the agreed message when the monthly cap is spent', async () => {
  const { TranslateError } = realAzure;
  translateImpl = async () => { throw new TranslateError(429, 'Monthly auto-translate limit reached, type it manually or wait until next month', 'TRANSLATE_CAP_EXCEEDED'); };
  const res = await json('POST', '/translate', { texts: ['Hi'], to: ['hi'] });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.message, 'Monthly auto-translate limit reached, type it manually or wait until next month');
  assert.deepEqual(body.errors, { code: 'TRANSLATE_CAP_EXCEEDED' });
  assert.equal(body.success, false);
});

test('POST /translate: 503 when Azure itself is down', async () => {
  const { TranslateError } = realAzure;
  translateImpl = async () => { throw new TranslateError(503, 'Auto-translate is temporarily unavailable. You can still type translations manually.', 'TRANSLATE_UNAVAILABLE'); };
  const res = await json('POST', '/translate', { texts: ['Hi'], to: ['hi'] });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errors.code, 'TRANSLATE_UNAVAILABLE');
});

// ---- POST /api/translate/flow
test('POST /translate/flow: summary + usage; only one enabled language', async () => {
  const ok = await json('POST', '/translate/flow', { to: 'hi' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).data, {
    language: 'hi', translated: 3, alreadyTranslated: 1, skipped: [], warnings: [], usage: { used: 40, cap: 20000, remaining: 19960 }
  });
  for (const body of [{}, { to: ['hi'] }, { to: 'en' }, { to: 'ta' }, { to: 'xx' }]) {
    assert.equal((await json('POST', '/translate/flow', body)).status, 400, JSON.stringify(body));
  }
  configured = false;
  assert.equal((await json('POST', '/translate/flow', { to: 'hi' })).status, 503);
});

test('GET /translate/usage', async () => {
  usageRow = { used: 500, cap: 20000, remaining: 19500 };
  const { data } = await (await json('GET', '/translate/usage')).json();
  assert.deepEqual(data, { used: 500, cap: 20000, remaining: 19500, configured: true });
});

// ---- admin template translate
test('POST /admin/category-templates/:id/translate: superadmin only, any catalog language but English', async () => {
  const path = '/admin/category-templates/t1/translate';
  assert.equal((await json('POST', path, { to: 'gu' }, { 'x-role': 'owner' })).status, 403);
  const ok = await json('POST', path, { to: 'gu' }, { 'x-role': 'superadmin' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.charged, 30);
  assert.equal((await json('POST', path, { to: 'en' }, { 'x-role': 'superadmin' })).status, 400);
  assert.equal((await json('POST', path, {}, { 'x-role': 'superadmin' })).status, 400);
  templateRow = null;
  assert.equal((await json('POST', path, { to: 'gu' }, { 'x-role': 'superadmin' })).status, 404);
  templateRow = { id: 't1', nodes: [], edges: [] };
  configured = false;
  assert.equal((await json('POST', path, { to: 'gu' }, { 'x-role': 'superadmin' })).status, 503);
});

// ---- PUT /api/business
test('PUT /business: enabledLanguages is validated (en first, max 3, catalog) and reordered', async () => {
  assert.equal((await json('PUT', '/business', { enabledLanguages: ['en', 'hi', 'gu', 'ta'] })).status, 400);
  assert.equal((await json('PUT', '/business', { enabledLanguages: ['en', 'zz'] })).status, 400);
  assert.equal((await json('PUT', '/business', { enabledLanguages: ['hi', 'gu'] })).status, 400);
  assert.equal((await json('PUT', '/business', { enabledLanguages: ['en', 'hi', 'hi'] })).status, 400);
  assert.equal(updated.length, 0);

  const ok = await json('PUT', '/business', { enabledLanguages: ['gu', 'en', 'hi'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(updated[0].enabledLanguages, ['en', 'gu', 'hi']);
});

test('PUT /business: switching a language off resets only those customers; stored translations are not touched', async () => {
  const res = await json('PUT', '/business', { enabledLanguages: ['en', 'hi'] });
  assert.equal(res.status, 200);
  assert.deepEqual(customerResets, [{ column: 'preferred_language', values: ['gu'] }]);
  assert.equal(Object.keys(updated[0]).some(k => /ranslations/.test(k)), false);

  customerResets = [];
  await json('PUT', '/business', { enabledLanguages: ['en', 'hi', 'gu'] }); // only adds
  assert.deepEqual(customerResets, []);
});

test('PUT /business: state must be an Indian state / UT (case-insensitive), null clears it', async () => {
  assert.equal((await json('PUT', '/business', { state: 'Atlantis' })).status, 400);
  assert.equal((await json('PUT', '/business', { state: 'gujarat' })).status, 200);
  assert.equal(updated[0].state, 'Gujarat');
  assert.equal((await json('PUT', '/business', { state: null })).status, 200);
  assert.equal(updated[1].state, null);
});

// ---- language settings
test('GET/PUT /business/language-settings: the Language node, owner-only writes, validated', async () => {
  const got = await (await json('GET', '/business/language-settings')).json();
  assert.equal(got.data.id, 'language');
  assert.equal(got.data.pickerKind, 'buttons');
  assert.equal(got.data.picker.mode, 'first_message');

  assert.equal((await json('PUT', '/business/language-settings', { mode: 'off' }, { 'x-role': 'staff' })).status, 403);
  assert.equal((await json('PUT', '/business/language-settings', { mode: 'always' })).status, 400);
  assert.equal((await json('PUT', '/business/language-settings', { changeKeyword: 'menu' })).status, 400);
  assert.equal((await json('PUT', '/business/language-settings', { promptTranslations: { ta: 'x' } })).status, 400);
  assert.equal(updated.length, 0);

  const ok = await json('PUT', '/business/language-settings', { mode: 'off', changeKeyword: 'MyLang', prompt: 'Pick', promptTranslations: { gu: 'પસંદ કરો' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(updated[0], { language_picker: { mode: 'off', changeKeyword: 'mylang', prompt: 'Pick', promptTranslations: { gu: 'પસંદ કરો' } } });
  const node = (await ok.json()).data;
  assert.equal(node.picker.mode, 'off');
  assert.equal(node.picker.changeKeyword, 'mylang');
});
