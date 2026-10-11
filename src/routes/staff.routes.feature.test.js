// Run: node --test src/routes/staff.routes.feature.test.js
// All five /api/staff routes sit behind the 'staff' switch: 404 while it's off
// (the real requireCategoryFeature runs), the handlers as before while it's on.
// Auth, business check, the controller and the DB are stubbed; requireRole is real.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => { req.user = { userId: 'u', businessId: 'b', role: req.headers['x-role'] || 'owner' }; next(); }
});
stub('../middleware/business.middleware', { requireBusiness: (req, res, next) => next() });
const asked = [];
let staffOn = true;
stub('../config/supabase', {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { business_category: 'travels' }, error: null }) }) }) })
});
stub('../services/categoryFeature.service', {
  isEnabled: async (category, feature, businessId) => { asked.push([category, feature, businessId]); return staffOn; }
});
const reached = (name) => (req, res) => res.status(200).json({ reached: name });
stub('../controllers/staff.controller', {
  getStaff: reached('getStaff'),
  inviteStaff: reached('inviteStaff'),
  updatePermissions: reached('updatePermissions'),
  removeStaff: reached('removeStaff'),
  toggleStaff: reached('toggleStaff')
});

const app = express();
app.use(express.json());
app.use('/api/staff', require('./staff.routes'));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/staff`;
});
test.after(() => server.close());

const call = (method, path, role = 'owner') => fetch(`${base}${path}`, {
  method,
  headers: { 'x-role': role, 'content-type': 'application/json' },
  body: method === 'GET' || method === 'DELETE' ? undefined : '{}'
});

const ROUTES = [
  ['GET', '', 'getStaff'],
  ['POST', '/invite', 'inviteStaff'],
  ['PUT', '/x/permissions', 'updatePermissions'],
  ['DELETE', '/x', 'removeStaff'],
  ['POST', '/x/toggle', 'toggleStaff']
];

test('switch Off: all five routes are 404 and no handler runs', async () => {
  staffOn = false;
  for (const [method, path] of ROUTES) {
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path || '/'}`);
    assert.equal((await res.json()).message, 'Not found');
  }
});

test('switch On: all five routes reach their handlers as before', async () => {
  staffOn = true;
  for (const [method, path, handler] of ROUTES) {
    const res = await call(method, path);
    assert.equal(res.status, 200, `${method} ${path || '/'}`);
    assert.equal((await res.json()).reached, handler);
  }
});

test('the guard asks for the staff key for this business; the owner-only gate still applies while On', async () => {
  staffOn = false;
  asked.length = 0;
  assert.equal((await call('GET', '')).status, 404);
  assert.deepEqual(asked, [['travels', 'staff', 'b']]);
  staffOn = true;
  for (const [method, path] of ROUTES) {
    assert.equal((await call(method, path, 'staff')).status, 403, `${method} ${path || '/'}`);
  }
});
