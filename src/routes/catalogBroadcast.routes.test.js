// Run: node --test src/routes/catalogBroadcast.routes.test.js
// POST /api/catalog/broadcast[/preview] sit behind BOTH the 'catalogue' and the 'broadcasts' switches. The
// broadcasts switch is off by default per business: its 404 carries errors.code 'BROADCASTS_DISABLED' (so the apps
// can say "Broadcasts are not enabled for your account") while the catalogue switch keeps the generic
// 'FEATURE_DISABLED'. Writes are owner only. Auth, the controllers and the DB are stubbed; the real
// requireCategoryFeature and requireRole run.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => { req.user = { userId: 'u', businessId: 'b', role: req.headers['x-role'] || 'owner' }; next(); },
  requireBusiness: (req, res, next) => next()
});
stub('../config/supabase', {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { business_category: 'menswear' }, error: null }) }) }) })
});
const on = { catalogue: true, broadcasts: true };
const asked = [];
stub('../services/categoryFeature.service', {
  isEnabled: async (category, feature, businessId) => { asked.push([category, feature, businessId]); return on[feature]; }
});
const reached = (name) => (req, res) => res.status(200).json({ reached: name });
stub('../controllers/catalogBroadcast.controller', { preview: reached('preview'), send: reached('send') });
// The rest of catalog.routes.js, which these tests don't exercise.
const anyHandler = new Proxy({}, { get: () => reached('other') });
stub('../controllers/catalog.controller', anyHandler);
stub('../controllers/translate.controller', anyHandler);
stub('../middleware/rateLimiter.middleware', { translateLimiter: (req, res, next) => next() });
stub('../middleware/upload.middleware', { uploadCatalogImages: (req, res, next) => next() });

const app = express();
app.use(express.json());
app.use('/api/catalog', require('./catalog.routes'));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/catalog`;
});
test.after(() => server.close());
test.beforeEach(() => { on.catalogue = true; on.broadcasts = true; asked.length = 0; });

const post = (path, role = 'owner') => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-role': role, 'content-type': 'application/json' }, body: '{}' });

test('both routes reach their handler for the owner while both switches are on', async () => {
  assert.deepEqual(await (await post('/broadcast/preview')).json(), { reached: 'preview' });
  assert.deepEqual(await (await post('/broadcast')).json(), { reached: 'send' });
  assert.deepEqual(asked.map(a => a[1]), ['catalogue', 'broadcasts', 'catalogue', 'broadcasts']);
});

test('broadcasts switched off: 404 with errors.code BROADCASTS_DISABLED and the message the app shows', async () => {
  on.broadcasts = false;
  for (const path of ['/broadcast/preview', '/broadcast']) {
    const res = await post(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), {
      success: false,
      message: 'Broadcasts are not enabled for your account. Contact support.',
      data: null,
      errors: { code: 'BROADCASTS_DISABLED', feature: 'broadcasts' }
    });
  }
});

test('catalogue switched off: the catalogue\'s own FEATURE_DISABLED 404 comes first', async () => {
  on.catalogue = false;
  on.broadcasts = false;
  const res = await post('/broadcast');
  assert.equal(res.status, 404);
  assert.deepEqual((await res.json()).errors, { code: 'FEATURE_DISABLED' });
  assert.deepEqual(asked.map(a => a[1]), ['catalogue'], 'the broadcasts switch is not even asked');
});

test('only the owner may preview or send', async () => {
  for (const role of ['staff', 'manager']) {
    assert.equal((await post('/broadcast/preview', role)).status, 403, role);
    assert.equal((await post('/broadcast', role)).status, 403, role);
  }
});
