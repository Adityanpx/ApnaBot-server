// Run: node --test src/routes/public.help.routes.test.js
// Help Center endpoints on the real public.routes.js: GET /app-config's
// shape + Cache-Control, POST /help-feedback's validation, and that
// helpFeedbackLimiter is wired on that route (11th vote in a minute → 429,
// and invalid bodies count too). config / supabase / the service-form
// controller are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const config = { FRONTEND_URL: 'https://app.example.com/', HELP_BASE_URL: undefined };
stub('../config/env', config);
const inserts = [];
let insertError = null;
stub('../config/supabase', {
  from: (table) => ({ insert: async (row) => { inserts.push({ table, row }); return { error: insertError }; } })
});
stub('../controllers/publicServiceForm.controller', new Proxy({}, { get: () => (req, res) => res.end() }));
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const { helpFeedbackLimiter } = require('../middleware/rateLimiter.middleware');
const app = express();
app.use(express.json());
app.use('/api/public', require('./public.routes'));

let server; let base;
test.before(async () => {
  // Bind IPv4 so req.ip (the limiter's key) is exactly '127.0.0.1'.
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/public`;
});
test.after(() => server.close());
test.beforeEach(async () => {
  inserts.length = 0;
  insertError = null;
  await helpFeedbackLimiter.resetKey('127.0.0.1');
});

const vote = (body) => fetch(`${base}/help-feedback`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
const valid = { slug: 'getting-started/connect-whatsapp', locale: 'en', helpful: true };

test('app-config: default helpBaseUrl is FRONTEND_URL/help, cacheable', async () => {
  const res = await fetch(`${base}/app-config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual((await res.json()).data, { helpBaseUrl: 'https://app.example.com/help', helpLanguages: ['en'] });
});

test('app-config: HELP_BASE_URL overrides the default', async () => {
  config.HELP_BASE_URL = 'https://help.example.com';
  try {
    const res = await fetch(`${base}/app-config`);
    assert.equal((await res.json()).data.helpBaseUrl, 'https://help.example.com');
  } finally {
    config.HELP_BASE_URL = undefined;
  }
});

test('help-feedback: valid vote → 204 and one insert', async () => {
  const res = await vote(valid);
  assert.equal(res.status, 204);
  assert.deepEqual(inserts, [{ table: 'help_feedback', row: valid }]);
});

test('help-feedback: 3-segment slug, hi/mr locales, helpful false are accepted', async () => {
  assert.equal((await vote({ slug: 'a/b-2/c', locale: 'hi', helpful: false })).status, 204);
  assert.equal((await vote({ ...valid, locale: 'mr' })).status, 204);
});

test('help-feedback: bad slugs → 400', async () => {
  for (const slug of [
    'single', 'a/b/c/d', 'Upper/case', 'a//b', '/a/b', 'a/b/', 'a/b c', '../etc/passwd',
    `a/${'x'.repeat(119)}`, // 121 chars, otherwise valid
    123, undefined
  ]) {
    const res = await vote({ ...valid, slug });
    assert.equal(res.status, 400, `slug ${JSON.stringify(slug)}`);
    await helpFeedbackLimiter.resetKey('127.0.0.1');
  }
  assert.equal(inserts.length, 0);
});

test('help-feedback: slug at exactly 120 chars is accepted', async () => {
  assert.equal((await vote({ ...valid, slug: `a/${'x'.repeat(118)}` })).status, 204);
});

test('help-feedback: bad locale / non-boolean helpful → 400', async () => {
  assert.equal((await vote({ ...valid, locale: 'fr' })).status, 400);
  assert.equal((await vote({ ...valid, locale: 'EN' })).status, 400);
  assert.equal((await vote({ ...valid, helpful: 'true' })).status, 400);
  assert.equal((await vote({ ...valid, helpful: 1 })).status, 400);
  assert.equal((await vote({ slug: valid.slug, locale: 'en' })).status, 400);
  assert.equal(inserts.length, 0);
});

test('help-feedback: DB error → 500', async () => {
  insertError = { message: 'boom' };
  assert.equal((await vote(valid)).status, 500);
});

test('help-feedback: 10/min per IP, the 11th → 429 (invalid bodies count too)', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await vote(valid)).status, 204);
  for (let i = 0; i < 5; i++) assert.equal((await vote({})).status, 400);
  const res = await vote(valid);
  assert.equal(res.status, 429);
  assert.equal(inserts.length, 5);
});

test('help-feedback limiter does not touch app-config', async () => {
  for (let i = 0; i < 10; i++) await vote(valid);
  assert.equal((await vote(valid)).status, 429);
  assert.equal((await fetch(`${base}/app-config`)).status, 200);
});
