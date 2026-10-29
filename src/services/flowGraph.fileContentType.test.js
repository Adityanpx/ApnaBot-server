// Run: node --test src/services/flowGraph.fileContentType.test.js
// 'file' is a question-node content type only: a reply node can never be one.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const { VALID_CONTENT_TYPES, VALID_QUESTION_CONTENT_TYPES } = require('./flowGraph.service');

test('file is accepted for a question node and refused for a reply node', () => {
  assert.ok(VALID_QUESTION_CONTENT_TYPES.includes('file'));
  assert.equal(VALID_CONTENT_TYPES.includes('file'), false);
  assert.equal(VALID_QUESTION_CONTENT_TYPES.includes('carousel'), false);
  for (const t of ['text', 'buttons', 'list', 'location', 'location_request']) assert.ok(VALID_QUESTION_CONTENT_TYPES.includes(t), t);
});
