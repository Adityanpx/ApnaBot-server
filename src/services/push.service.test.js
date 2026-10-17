// Run: node --test src/services/push.service.test.js
// The FCM transport: a no-op (never a throw) when the credential is missing or
// invalid, batches of 500, and dead tokens deleted. firebase-admin is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');

const warnings = [];
const deleted = [];
let multicastCalls; let respond; let initCalls;
const env = {};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', env);
stub('../utils/logger', { info: () => {}, warn: (m) => warnings.push(m), error: () => {} });
stub('../config/supabase', {
  from: (table) => ({
    delete: () => ({ in: async (col, tokens) => { deleted.push({ table, col, tokens }); return { error: null }; } })
  })
});
stub('firebase-admin/app', {
  initializeApp: (opts, name) => { initCalls.push({ opts, name }); return { name }; },
  cert: (json) => ({ cert: json })
});
stub('firebase-admin/messaging', {
  getMessaging: () => ({
    sendEachForMulticast: async (msg) => { multicastCalls.push(msg); return respond(msg); }
  })
});

const push = require('./push.service');
const credential = (json) => Buffer.from(JSON.stringify(json)).toString('base64');
const allOk = (msg) => ({ successCount: msg.tokens.length, failureCount: 0, responses: msg.tokens.map(() => ({ success: true })) });
const MESSAGE = { notification: { title: 't', body: 'b' }, data: { type: 'booking_new' } };

test.beforeEach(() => {
  warnings.length = 0; deleted.length = 0; multicastCalls = []; initCalls = [];
  respond = allOk;
  delete env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  push.resetForTests();
});

test('no credential: one warning, every send is a no-op that does not throw', async () => {
  assert.equal(push.isPushEnabled(), false);
  const result = await push.sendToDevices(['a', 'b'], MESSAGE);
  await push.sendToDevices(['c'], MESSAGE);
  assert.deepEqual(result, { successCount: 0, failureCount: 0, removedCount: 0 });
  assert.equal(multicastCalls.length, 0);
  assert.equal(initCalls.length, 0);
  assert.equal(warnings.length, 1);
});

test('invalid credential (not base64 JSON): one warning that does not echo the value, no-op', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = 'super-secret-not-json';
  assert.deepEqual(await push.sendToDevices(['a'], MESSAGE), { successCount: 0, failureCount: 0, removedCount: 0 });
  await push.sendToDevices(['a'], MESSAGE);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('super-secret'));
  assert.equal(multicastCalls.length, 0);
});

test('valid credential: initialises once under its own app name and sends', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = credential({ project_id: 'apnabot-8d029' });
  assert.equal(push.isPushEnabled(), true);
  const result = await push.sendToDevices(['a', 'b', 'a', '', null], MESSAGE);
  await push.sendToDevices(['c'], MESSAGE);
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0].name, 'apnabot-push');
  assert.deepEqual(multicastCalls[0].tokens, ['a', 'b']); // de-duplicated, blanks dropped
  assert.deepEqual(multicastCalls[0].notification, MESSAGE.notification);
  assert.deepEqual(result, { successCount: 2, failureCount: 0, removedCount: 0 });
});

test('1,200 tokens go out in batches of 500, 500, 200', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = credential({ project_id: 'x' });
  const tokens = Array.from({ length: 1200 }, (_, i) => `tok${i}`);
  const result = await push.sendToDevices(tokens, MESSAGE);
  assert.deepEqual(multicastCalls.map((c) => c.tokens.length), [500, 500, 200]);
  assert.equal(result.successCount, 1200);
});

test('not-registered and invalid-argument tokens are deleted; other failures are kept', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = credential({ project_id: 'x' });
  respond = (msg) => ({
    successCount: 1,
    failureCount: 3,
    responses: [
      { success: true },
      { success: false, error: { code: 'messaging/registration-token-not-registered' } },
      { success: false, error: { code: 'messaging/invalid-argument' } },
      { success: false, error: { code: 'messaging/internal-error' } }
    ].slice(0, msg.tokens.length)
  });
  const result = await push.sendToDevices(['ok', 'gone', 'bad', 'flaky'], MESSAGE);
  assert.deepEqual(deleted, [{ table: 'device_tokens', col: 'token', tokens: ['gone', 'bad'] }]);
  assert.deepEqual(result, { successCount: 1, failureCount: 3, removedCount: 2 });
});

test('a failing batch is counted and does not stop the next one or throw', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = credential({ project_id: 'x' });
  let n = 0;
  respond = (msg) => { n += 1; if (n === 1) throw new Error('fcm down'); return allOk(msg); };
  const result = await push.sendToDevices(Array.from({ length: 600 }, (_, i) => `t${i}`), MESSAGE);
  assert.equal(result.failureCount, 500);
  assert.equal(result.successCount, 100);
});

test('an empty or missing token list sends nothing and does not even initialise', async () => {
  env.FIREBASE_SERVICE_ACCOUNT_BASE64 = credential({ project_id: 'x' });
  await push.sendToDevices([], MESSAGE);
  await push.sendToDevices(undefined, MESSAGE);
  assert.equal(initCalls.length, 0);
});
