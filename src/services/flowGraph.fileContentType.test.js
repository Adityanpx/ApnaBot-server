// Run: node --test src/services/flowGraph.fileContentType.test.js
// 'file' is a question-node content type only: a reply node can never be one.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const { VALID_CONTENT_TYPES, VALID_QUESTION_CONTENT_TYPES } = require('./flowGraph.service');

// A migration that re-creates flow_nodes_content_type_check must keep every value the previous one allowed
// (20261101120000 once dropped 'catalog' and failed on live rows).
test('each migration that redefines flow_nodes_content_type_check keeps all earlier values', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'supabase', 'migrations');
  let previous = null;
  for (const name of fs.readdirSync(dir).sort()) {
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    const m = /add constraint flow_nodes_content_type_check\s+check \(content_type in \(([^)]*)\)\)/.exec(sql);
    if (!m) continue;
    const values = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    if (previous) for (const v of previous.values) assert.ok(values.includes(v), `${name} drops '${v}' that ${previous.name} allowed`);
    previous = { name, values };
  }
  assert.equal(previous.name, '20261101120000_media_reply_and_file_questions.sql');
  for (const v of ['catalog', 'carousel', 'location_request', 'file']) assert.ok(previous.values.includes(v), v);
});

test('file is accepted for a question node and refused for a reply node', () => {
  assert.ok(VALID_QUESTION_CONTENT_TYPES.includes('file'));
  assert.equal(VALID_CONTENT_TYPES.includes('file'), false);
  assert.equal(VALID_QUESTION_CONTENT_TYPES.includes('carousel'), false);
  for (const t of ['text', 'buttons', 'list', 'location', 'location_request']) assert.ok(VALID_QUESTION_CONTENT_TYPES.includes(t), t);
});
