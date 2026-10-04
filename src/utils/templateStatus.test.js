// Run: node --test src/utils/templateStatus.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { templateStatusForEvent } = require('./templateStatus');

test('Meta template events map to message_templates.status', () => {
  assert.equal(templateStatusForEvent('APPROVED'), 'approved');
  assert.equal(templateStatusForEvent('REJECTED'), 'rejected');
  assert.equal(templateStatusForEvent('PAUSED'), 'paused');
  assert.equal(templateStatusForEvent('DISABLED'), 'disabled');
  assert.equal(templateStatusForEvent('REINSTATED'), 'approved'); // un-paused
});

test('events we don\'t track are skipped (null)', () => {
  for (const e of ['FLAGGED', 'IN_APPEAL', 'PENDING_DELETION', 'approved', undefined, null, 'toString']) {
    assert.equal(templateStatusForEvent(e), null, String(e));
  }
});
