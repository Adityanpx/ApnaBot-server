// Run: node --test src/routes/customer.routes.resumeMarketing.test.js
// POST /api/customers/:id/resume-marketing is for the owner (and superadmin) only -
// not staff - like block / unblock / opt-in. Middleware and controller are tagged
// stand-ins, so the route's own chain is what is checked.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tag = (name) => Object.assign(() => {}, { tag: name });
stub('../middleware/auth.middleware', { protect: tag('protect') });
stub('../middleware/business.middleware', { requireBusiness: tag('requireBusiness') });
stub('../middleware/role.middleware', { requireRole: (...roles) => tag(`role:${roles.join(',')}`) });
stub('../controllers/customer.controller', new Proxy({}, { get: (_, key) => tag(`controller:${String(key)}`) }));

const router = require('./customer.routes');

test('resume-marketing: owner and superadmin, then the resumeMarketing handler', () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id/resume-marketing');
  assert.ok(layer, 'route is registered');
  assert.deepEqual(Object.keys(layer.route.methods), ['post']);
  assert.deepEqual(layer.route.stack.map((s) => s.handle.tag), ['role:owner,superadmin', 'controller:resumeMarketing']);
});

test('the whole router is behind protect + requireBusiness', () => {
  const guards = router.stack.filter((l) => !l.route).map((l) => l.handle.tag);
  assert.deepEqual(guards, ['protect', 'requireBusiness']);
});
