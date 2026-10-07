// Run: node --test src/routes/broadcastTemplate.roles.test.js
// Broadcast create/send and template create/submit/delete are owner /
// superadmin only (a broadcast send debits the wallet); staff keep read
// access. Auth and the controllers are stubbed — only the role gate is real.
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
stub('../middleware/upload.middleware', { uploadSingle: (req, res, next) => next() });
const reached = (name) => (req, res) => res.status(200).json({ reached: name });
stub('../controllers/broadcast.controller', {
  getBroadcasts: reached('getBroadcasts'),
  createBroadcast: reached('createBroadcast'),
  getAudienceCount: reached('getAudienceCount'),
  getAudienceSummary: reached('getAudienceSummary'),
  getAudienceSkipped: reached('getAudienceSkipped'),
  getBroadcastRecipientsPreview: reached('getBroadcastRecipientsPreview'),
  sendBroadcast: reached('sendBroadcast'),
  getBroadcast: reached('getBroadcast')
});
stub('../controllers/messageTemplate.controller', {
  getMessageTemplates: reached('getMessageTemplates'),
  syncMessageTemplates: reached('syncMessageTemplates'),
  setHeaderMedia: reached('setHeaderMedia'),
  setButtonActions: reached('setButtonActions'),
  createMessageTemplate: reached('createMessageTemplate'),
  uploadHeaderImage: reached('uploadHeaderImage'),
  submitMessageTemplate: reached('submitMessageTemplate'),
  deleteMessageTemplate: reached('deleteMessageTemplate')
});

const app = express();
app.use(express.json());
app.use('/api/broadcasts', require('./broadcast.routes'));
app.use('/api/message-templates', require('./messageTemplate.routes'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

const call = (method, path, role) => fetch(`${base}${path}`, {
  method,
  headers: { 'x-role': role, 'content-type': 'application/json' },
  body: method === 'GET' ? undefined : '{}'
});

const WRITES = [
  ['POST', '/broadcasts'],
  // not writes, but owner / superadmin only all the same: the skipped list names customers
  ['POST', '/broadcasts/audience-summary'],
  ['POST', '/broadcasts/audience-skipped'],
  ['POST', '/broadcasts/x/send'],
  ['POST', '/message-templates'],
  ['POST', '/message-templates/sync'],
  ['PUT', '/message-templates/x/header-media'],
  ['PUT', '/message-templates/x/button-actions'],
  ['POST', '/message-templates/upload-header-image'],
  ['POST', '/message-templates/x/submit'],
  ['DELETE', '/message-templates/x']
];
const READS = [
  ['GET', '/broadcasts'],
  ['GET', '/broadcasts/x'],
  ['GET', '/broadcasts/x/recipients-preview'],
  ['POST', '/broadcasts/audience-count'],
  ['GET', '/message-templates']
];

test('staff get 403 on broadcast / template writes', async () => {
  for (const [method, path] of WRITES) {
    const res = await call(method, path, 'staff');
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test('owner and superadmin reach the write handlers', async () => {
  for (const role of ['owner', 'superadmin']) {
    for (const [method, path] of WRITES) {
      const res = await call(method, path, role);
      assert.equal(res.status, 200, `${role} ${method} ${path}`);
    }
  }
});

test('staff keep read access', async () => {
  for (const [method, path] of READS) {
    const res = await call(method, path, 'staff');
    assert.equal(res.status, 200, `${method} ${path}`);
  }
});
