// Run: node --test src/config/graphApiVersion.test.js
// One Graph API version for the whole server: GRAPH_API_VERSION parsing, plus
// a guard that no file hardcodes its own graph.facebook.com/vN.N base again
// (whatsapp.service.js's META_API_BASE is the only one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_GRAPH_API_VERSION, resolveGraphApiVersion } = require('./graphApiVersion');

test('defaults to v25.0 when unset or blank', () => {
  assert.equal(DEFAULT_GRAPH_API_VERSION, 'v25.0');
  assert.equal(resolveGraphApiVersion(undefined), 'v25.0');
  assert.equal(resolveGraphApiVersion(''), 'v25.0');
  assert.equal(resolveGraphApiVersion('   '), 'v25.0');
});

test('uses an explicit version (the rollback path)', () => {
  assert.equal(resolveGraphApiVersion('v21.0'), 'v21.0');
  assert.equal(resolveGraphApiVersion(' v26.0 '), 'v26.0');
});

test('rejects a malformed version', () => {
  for (const bad of ['25.0', 'v25', 'V25.0', 'v25.0/', 'latest']) {
    assert.throws(() => resolveGraphApiVersion(bad), /GRAPH_API_VERSION/, bad);
  }
});

const SRC = path.join(__dirname, '..');
const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return jsFiles(p);
  return e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [p] : [];
});

test('no source file hardcodes a Graph API version', () => {
  const offenders = jsFiles(SRC).filter((f) => /graph\.facebook\.com\/v\d/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(SRC, f)), []);
});

test("whatsapp-connect.html's FB.init uses the default version", () => {
  const html = fs.readFileSync(path.join(SRC, '..', 'public', 'whatsapp-connect.html'), 'utf8');
  const versions = [...html.matchAll(/version:\s*'(v[\d.]+)'/g)].map((m) => m[1]);
  assert.deepEqual(versions, [DEFAULT_GRAPH_API_VERSION]);
});
