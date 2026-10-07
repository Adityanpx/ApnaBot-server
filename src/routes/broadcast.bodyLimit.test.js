// Run: node --test src/routes/broadcast.bodyLimit.test.js
// /api/broadcasts takes JSON bodies up to 1 MB (2,000 customer ids is ~80 KB,
// over express.json()'s 100 KB default); every other route keeps the default.
// The first test builds the same two-parser setup app.js uses; the second
// checks app.js itself still mounts them in that order (the broadcast parser
// has to come first, the global one skips a body that was already read).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

let server; let base;
test.before(async () => {
  const app = express();
  app.use('/api/broadcasts', express.json({ limit: '1mb' }));
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.post('/api/broadcasts/x', (req, res) => res.json({ n: req.body.ids.length }));
  app.post('/api/other', (req, res) => res.json({ n: req.body.ids.length }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.type || err.message }));
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

const post = (p, ids) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids })
});
const uuids = (n) => Array.from({ length: n }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`);

test('a 2,000-id (~80 KB) and a 20,000-id (~800 KB) body are accepted on /api/broadcasts', async () => {
  for (const n of [2000, 20000]) {
    const res = await post('/broadcasts/x', uuids(n));
    assert.equal(res.status, 200, `${n} ids`);
    assert.equal((await res.json()).n, n);
  }
});

test('a body over 1 MB is refused on /api/broadcasts (413)', async () => {
  assert.equal((await post('/broadcasts/x', uuids(30000))).status, 413);
});

test('other routes keep the 100 KB default', async () => {
  assert.equal((await post('/other', uuids(2000))).status, 200); // ~80 KB
  assert.equal((await post('/other', uuids(3000))).status, 413); // ~120 KB
});

test('app.js mounts the broadcast parser before the global one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const broadcastParser = src.indexOf("app.use('/api/broadcasts', express.json({ limit: '1mb' }));");
  const globalParser = src.indexOf('app.use(express.json({');
  assert.ok(broadcastParser > 0, 'broadcast parser missing');
  assert.ok(globalParser > broadcastParser, 'global parser must come after the broadcast one');
  assert.equal(src.split("express.json({ limit: '1mb' })").length - 1, 1, 'the 1 MB limit must apply to /api/broadcasts only');
});
