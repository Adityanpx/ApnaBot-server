// Run: node --test src/services/storageCleanup.noMeta.test.js
// HARD RULE for storage cleanup: it deletes from R2 and ApnaBot's own database only
// and NEVER calls Meta / WhatsApp. Two guards:
//   1. static  - none of the cleanup code requires a WhatsApp / HTTP / queue module
//   2. runtime - whatsapp.service and axios are replaced by traps that fail the test
//                on any use, then a full cleanup (mark, retention, orphan scan, purge,
//                cancel, export) runs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const touched = [];
const trap = (name) => new Proxy({}, {
  get: (_t, prop) => { touched.push(`${name}.${String(prop)}`); throw new Error(`storage cleanup touched ${name}.${String(prop)}`); }
});
// Installed before anything else is loaded.
const trapModule = (id, name) => {
  const p = require.resolve(id);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: trap(name) };
};
trapModule('./whatsapp.service', 'whatsapp.service');
trapModule('axios', 'axios');
trapModule('./windowAwareSend.service', 'windowAwareSend.service');

const h = require('../test-support/storageHarness');
const cleanup = require('./storageCleanup.service');
const sweeper = require('./storageCleanupSweeper.service');

const SRC = path.join(__dirname, '..');
const FILES = [
  'services/storageCleanup.service.js', 'services/storageCleanupSweeper.service.js', 'services/storageInventory.service.js',
  'services/r2.service.js', 'utils/storageKinds.js', 'utils/r2Key.js',
  'controllers/storageCleanup.controller.js', 'routes/storageCleanup.routes.js', 'scripts/storageCleanup.js'
];
const FORBIDDEN = /whatsapp|axios|windowAwareSend|broadcast|templateSubmit|templateSync|templateWebhook|socket|queue|bullmq|graph\.facebook|META_API/i;

const requireTargets = (source) => [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);

test('static: the cleanup code requires nothing that can reach Meta', () => {
  for (const file of FILES) {
    const targets = requireTargets(fs.readFileSync(path.join(SRC, file), 'utf8'));
    assert.ok(targets.length > 0, `${file} has requires`);
    for (const t of targets) assert.doesNotMatch(t, FORBIDDEN, `${file} requires ${t}`);
  }
});

test('static: no Meta Graph URL or send call appears in the cleanup code', () => {
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.doesNotMatch(source, /graph\.facebook\.com|sendTextMessage|sendImageMessage|downloadMedia|sendWindowAwareMessage|axios\./, file);
  }
});

test('runtime: a full cleanup (mark, retention, orphan scan, cancel, purge, export) never touches the WhatsApp service or axios', async () => {
  const B = h.B1;
  const db = h.reset();
  db.businesses = [{ id: B, name: 'SG Travels', payment_qr_url: null, profile_image: null, require_advance_payment: false, chat_media_retention: null, storage_used_bytes: 0 }];
  db.messages = [];
  const chatKey = h.put(`inbound-media/${B}/${h.uuid(1)}.jpeg`, { age: 60 * 24 * h.HOUR });
  db.messages.push({ id: h.uuid(1), media_url: h.url(chatKey) });
  h.put('template-headers/orphan.png', { age: 100 * h.HOUR });

  await cleanup.preview({ businessId: B });
  const run = await cleanup.createManualRun({ businessId: B }, 'admin');
  await cleanup.cancelRun(run.id, 'admin');
  await cleanup.setPlatformRetentionDays(30);
  const retention = await cleanup.createRetentionRun();
  assert.equal(retention.created, true);
  await cleanup.startOrphanScan({ confirmPhrase: cleanup.ALL_BUSINESSES_PHRASE }, 'admin');
  for (let i = 0; i < 100 && cleanup.orphanScanStatus().status === 'running'; i += 1) await new Promise(r => setImmediate(r));
  await cleanup.exportCsv(run.id);
  await cleanup.summary();

  db.storage_cleanup_items.forEach(i => { i.pending_delete_at = new Date(Date.now() - 1000).toISOString(); });
  db.storage_cleanup_runs.forEach(r => { r.pending_delete_at = new Date(Date.now() - 1000).toISOString(); });
  const res = await sweeper.runTick({ retention: false });
  assert.ok(res.purged >= 1, 'the sweep really ran');
  assert.deepEqual(touched, []);
});
