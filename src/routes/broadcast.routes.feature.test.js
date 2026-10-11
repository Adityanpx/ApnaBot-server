// Run: node --test src/routes/broadcast.routes.feature.test.js
// All nine /api/broadcasts routes sit behind the 'broadcasts' switch: 404 while
// it's off (the real requireCategoryFeature runs), the handlers as before while
// it's on. Auth, the controller and the DB are stubbed.
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
const asked = [];
let broadcastsOn = true;
stub('../config/supabase', {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { business_category: 'travels' }, error: null }) }) }) })
});
stub('../services/categoryFeature.service', {
  isEnabled: async (category, feature, businessId) => { asked.push([category, feature, businessId]); return broadcastsOn; }
});
const reached = (name) => (req, res) => res.status(200).json({ reached: name });
stub('../controllers/broadcast.controller', {
  getBroadcasts: reached('getBroadcasts'),
  createBroadcast: reached('createBroadcast'),
  getAudienceCount: reached('getAudienceCount'),
  getAudienceSummary: reached('getAudienceSummary'),
  getAudienceSkipped: reached('getAudienceSkipped'),
  getBroadcastRecipientsPreview: reached('getBroadcastRecipientsPreview'),
  sendBroadcast: reached('sendBroadcast'),
  getBroadcast: reached('getBroadcast'),
  getBroadcastRecipients: reached('getBroadcastRecipients')
});

const app = express();
app.use(express.json());
app.use('/api/broadcasts', require('./broadcast.routes'));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/broadcasts`;
});
test.after(() => server.close());

const call = (method, path, role = 'owner') => fetch(`${base}${path}`, {
  method,
  headers: { 'x-role': role, 'content-type': 'application/json' },
  body: method === 'GET' ? undefined : '{}'
});

// [method, path, handler it reaches]
const ROUTES = [
  ['GET', '', 'getBroadcasts'],
  ['POST', '', 'createBroadcast'],
  ['POST', '/audience-count', 'getAudienceCount'],
  ['POST', '/audience-summary', 'getAudienceSummary'],
  ['POST', '/audience-skipped', 'getAudienceSkipped'],
  ['GET', '/x/recipients-preview', 'getBroadcastRecipientsPreview'],
  ['GET', '/x/recipients', 'getBroadcastRecipients'],
  ['POST', '/x/send', 'sendBroadcast'],
  ['GET', '/x', 'getBroadcast']
];

test('there are nine routes under test', () => {
  assert.equal(ROUTES.length, 9);
});

test('switch Off: every route is 404 and no handler runs', async () => {
  broadcastsOn = false;
  for (const [method, path] of ROUTES) {
    const res = await call(method, path);
    assert.equal(res.status, 404, `${method} ${path || '/'}`);
    assert.equal((await res.json()).message, 'Not found');
  }
});

test('switch On: every route reaches its handler as before', async () => {
  broadcastsOn = true;
  for (const [method, path, handler] of ROUTES) {
    const res = await call(method, path);
    assert.equal(res.status, 200, `${method} ${path || '/'}`);
    assert.equal((await res.json()).reached, handler);
  }
});

test('Off applies to staff too, and the guard asks for the broadcasts key for this business', async () => {
  broadcastsOn = false;
  asked.length = 0;
  assert.equal((await call('GET', '', 'staff')).status, 404);
  assert.deepEqual(asked, [['travels', 'broadcasts', 'b']]);
});

test('the role gates still apply while On (staff cannot send)', async () => {
  broadcastsOn = true;
  assert.equal((await call('POST', '/x/send', 'staff')).status, 403);
  assert.equal((await call('GET', '/x', 'staff')).status, 200);
});
