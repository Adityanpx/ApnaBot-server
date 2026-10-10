// Run: node --test src/routes/business.paymentIssue.routes.test.js
// POST /api/business/payment-issue/dismiss is signed-in + owner only (like connecting
// WhatsApp). Middleware and controllers are tagged stand-ins, so the route's own
// chain is what is checked.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tag = (name) => Object.assign(() => {}, { tag: name });
const controllerStub = new Proxy({}, { get: (_, key) => tag(`controller:${String(key)}`) });
stub('../controllers/business.controller', controllerStub);
stub('../controllers/businessMedia.controller', controllerStub);
stub('../middleware/auth.middleware', { protect: tag('protect'), requireBusiness: tag('requireBusiness') });
stub('../middleware/role.middleware', { requireRole: (...roles) => tag(`role:${roles.join(',')}`) });
stub('../middleware/upload.middleware', { uploadSingle: tag('upload'), uploadMediaSingle: tag('uploadMedia') });

const router = require('./business.routes');

test('dismiss is protected, needs a business, owner role, then the dismiss handler', () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/payment-issue/dismiss');
  assert.ok(layer, 'route is registered');
  assert.deepEqual(Object.keys(layer.route.methods), ['post']);
  assert.deepEqual(layer.route.stack.map((s) => s.handle.tag), ['protect', 'requireBusiness', 'role:owner', 'controller:dismissPaymentIssue']);
});
