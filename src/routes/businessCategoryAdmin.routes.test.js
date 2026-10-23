// Run: node --test src/routes/businessCategoryAdmin.routes.test.js
// POST / and PUT /:value on /api/admin/business-categories are superadmin-only; the public GET stays open
// to any signed-in user. Real router + controller; auth and the DB are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const h = require('../test-support/storageHarness');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    req.user = { userId: 'u', businessId: null, role: req.headers['x-role'] || 'owner' };
    next();
  }
});

const app = express();
app.use(express.json());
app.use('/api/admin/business-categories', require('./businessCategoryAdmin.routes'));
app.use('/api/business-categories', require('./businessCategory.routes'));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_categories = [{ value: 'general', label: 'General', icon: '', emoji: '', label_translations: {}, is_enabled: true, display_order: 80 }];
});

const send = (method, path, role, body) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-role': role }, body: body ? JSON.stringify(body) : undefined
});

test('POST / creates for a superadmin and answers 201', async () => {
  const res = await send('POST', '/admin/business-categories', 'superadmin', { value: 'mobile_electronics', label: 'Mobile & Electronics', emoji: '📱' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).data.emoji, '📱');
  assert.equal(db.business_categories.length, 2);
});

test('POST / and PUT /:value are 403 for every other role and change nothing', async () => {
  for (const role of ['owner', 'staff', 'admin']) {
    const post = await send('POST', '/admin/business-categories', role, { value: 'mobile_electronics', label: 'X' });
    const put = await send('PUT', '/admin/business-categories/general', role, { label: 'Hacked' });
    assert.equal(post.status, 403, `${role} POST`);
    assert.equal(put.status, 403, `${role} PUT`);
  }
  assert.equal(db.business_categories.length, 1);
  assert.equal(db.business_categories[0].label, 'General');
});

test('PUT /:value edits for a superadmin; there is no DELETE route', async () => {
  const put = await send('PUT', '/admin/business-categories/general', 'superadmin', { label: 'Everything' });
  assert.equal(put.status, 200);
  assert.equal(db.business_categories[0].label, 'Everything');
  const del = await send('DELETE', '/admin/business-categories/general', 'superadmin');
  assert.equal(del.status, 404);
  assert.equal(db.business_categories.length, 1);
});

test('the toggle route still works next to PUT /:value', async () => {
  const res = await send('PUT', '/admin/business-categories/general/toggle', 'superadmin', { isEnabled: false });
  assert.equal(res.status, 200);
  assert.equal(db.business_categories[0].is_enabled, false);
});

test('public GET lists only enabled categories, with emoji and labelTranslations, to any role', async () => {
  db.business_categories.push({ value: 'draft_cat', label: 'Draft', icon: '', emoji: '🧪', label_translations: {}, is_enabled: false, display_order: 90 });
  db.business_categories[0].emoji = '🧰';
  db.business_categories[0].label_translations = { hi: 'सामान्य' };
  const res = await send('GET', '/business-categories', 'owner');
  assert.equal(res.status, 200);
  const { categories } = (await res.json()).data;
  assert.deepEqual(categories.map((c) => c.value), ['general']);
  assert.deepEqual([categories[0].emoji, categories[0].labelTranslations], ['🧰', { hi: 'सामान्य' }]);
});
