// Run: node --test src/routes/customer.routes.ids.test.js
// GET /api/customers/ids and /tags are matched before /:id (otherwise "ids"
// would be looked up as a customer id), and are open to the same roles as the
// list. Auth and the controller are stubbed — only the routing is real.
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
stub('../middleware/business.middleware', { requireBusiness: (req, res, next) => next() });
const reached = (name) => (req, res) => res.status(200).json({ reached: name, id: req.params.id });
stub('../controllers/customer.controller', {
  getCustomers: reached('getCustomers'),
  getCustomerIds: reached('getCustomerIds'),
  getCustomerTags: reached('getCustomerTags'),
  getCustomerSummary: reached('getCustomerSummary'),
  getCustomerById: reached('getCustomerById'),
  updateCustomer: reached('updateCustomer'),
  blockCustomer: reached('blockCustomer'),
  unblockCustomer: reached('unblockCustomer'),
  toggleCustomerOptIn: reached('toggleCustomerOptIn')
});

const app = express();
app.use('/api/customers', require('./customer.routes'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

const get = async (path, role) => {
  const res = await fetch(`${base}${path}`, { headers: { 'x-role': role } });
  return { status: res.status, body: await res.json() };
};

test('/ids and /tags reach their own handlers, not /:id', async () => {
  assert.equal((await get('/customers/ids?tags=vip', 'owner')).body.reached, 'getCustomerIds');
  assert.equal((await get('/customers/tags', 'owner')).body.reached, 'getCustomerTags');
  const byId = await get('/customers/abc', 'owner');
  assert.equal(byId.body.reached, 'getCustomerById');
  assert.equal(byId.body.id, 'abc');
});

test('owner, staff and superadmin can read ids and tags, like the list', async () => {
  for (const role of ['owner', 'staff', 'superadmin']) {
    assert.equal((await get('/customers/ids', role)).status, 200, `${role} ids`);
    assert.equal((await get('/customers/tags', role)).status, 200, `${role} tags`);
  }
});
