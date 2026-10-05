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

const { templateStatusFromMeta, isSendSupported, isTemplateUsable, sendSupportBlockReason } = require('./templateStatus');

test('Meta listing statuses map to message_templates.status (the mapping table)', () => {
  const table = {
    APPROVED: 'approved',
    FLAGGED: 'approved', // still sends; Meta only warns
    PENDING: 'pending',
    IN_APPEAL: 'pending',
    REJECTED: 'rejected',
    PAUSED: 'paused',
    DISABLED: 'disabled',
    PENDING_DELETION: 'deleted',
    DELETED: 'deleted'
  };
  for (const [meta, ours] of Object.entries(table)) assert.equal(templateStatusFromMeta(meta), ours, meta);
});

test('listing statuses we don\'t map are null', () => {
  for (const s of ['ARCHIVED', 'REINSTATED', 'approved', undefined, null, 'toString']) {
    assert.equal(templateStatusFromMeta(s), null, String(s));
  }
});

test('usable = approved AND send_support ok', () => {
  assert.equal(isTemplateUsable({ status: 'approved', send_support: 'ok' }), true);
  assert.equal(isTemplateUsable({ status: 'approved' }), true); // column not selected = DB default 'ok'
  for (const send_support of ['needs_header_media', 'unsupported_named_params', 'unsupported_component', null]) {
    assert.equal(isTemplateUsable({ status: 'approved', send_support }), false, String(send_support));
  }
  for (const status of ['draft', 'pending', 'rejected', 'paused', 'disabled', 'deleted']) {
    assert.equal(isTemplateUsable({ status, send_support: 'ok' }), false, status);
  }
  assert.equal(isTemplateUsable(null), false);
  assert.equal(isSendSupported({ send_support: 'ok' }), true);
  assert.equal(sendSupportBlockReason({ send_support: 'ok' }), null);
  assert.match(sendSupportBlockReason({ send_support: 'unsupported_component' }), /buttons/);
});
