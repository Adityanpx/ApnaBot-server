// Run: node --test src/utils/whatsappErrors.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeFailure, fromStatusErrors, fromSendError, withFailure, withRecipientFailure, REASONS } = require('./whatsappErrors');

test('recipient failures: Meta code -> plain wording; no code -> "Not sent: ..." (kind local); healthy -> null', () => {
  assert.equal(withRecipientFailure({ id: 1, status: 'read' }).failure, null);
  assert.equal(withRecipientFailure({ id: 1, status: 'queued', errorCode: null }).failure, null);
  const meta = withRecipientFailure({ status: 'failed', errorCode: 131050, errorTitle: 't', errorDetails: 'd' }).failure;
  assert.deepEqual([meta.code, meta.kind, meta.details], [131050, 'recipient', 'd']);
  assert.match(meta.reason, /opted out of marketing/);
  assert.deepEqual(withRecipientFailure({ status: 'failed', errorCode: null, errorTitle: 'recipient has no name on file' }).failure,
    { code: null, title: 'recipient has no name on file', reason: 'Not sent: recipient has no name on file', kind: 'local', details: null });
  assert.equal(withRecipientFailure({ status: 'failed' }).failure.reason, 'Not sent.');
  assert.equal(withRecipientFailure(null), null);
});

test('known codes map to plain wording and a kind; the raw code is kept', () => {
  const d = describeFailure(131050, 'x');
  assert.equal(d.code, 131050);
  assert.equal(d.kind, 'recipient');
  assert.match(d.reason, /opted out of marketing/);
  assert.equal(describeFailure('131047').kind, 'window'); // numeric strings work
  assert.equal(describeFailure(130429).kind, 'limit');
  assert.equal(describeFailure(132015).kind, 'template');
  assert.equal(describeFailure(133010).kind, 'account');
});

test('every mapped reason is non-empty and has a kind', () => {
  for (const [code, v] of Object.entries(REASONS)) {
    assert.ok(v.reason.length > 10, code);
    assert.ok(['recipient', 'window', 'limit', 'template', 'account', 'other'].includes(v.kind), code);
  }
});

test('an unknown code gets a safe default that names the code and Meta\'s title', () => {
  assert.deepEqual(describeFailure(999999, 'Odd thing'), { code: 999999, title: 'Odd thing', reason: "WhatsApp couldn't deliver this message (code 999999): Odd thing", kind: 'other' });
  assert.equal(describeFailure(999999).reason, "WhatsApp couldn't deliver this message (code 999999).");
  assert.equal(describeFailure(null).reason, "WhatsApp couldn't deliver this message.");
  assert.equal(describeFailure('abc').code, null);
});

test('status webhook errors: first entry, details preferred, long text clipped', () => {
  assert.deepEqual(fromStatusErrors([{ code: 131026, title: 'Message undeliverable', message: 'm', error_data: { details: 'd' } }]),
    { errorCode: 131026, errorTitle: 'Message undeliverable', errorDetails: 'd' });
  assert.deepEqual(fromStatusErrors([{ code: 1, message: 'only message' }]), { errorCode: 1, errorTitle: 'only message', errorDetails: 'only message' });
  assert.deepEqual(fromStatusErrors(undefined), { errorCode: null, errorTitle: null, errorDetails: null });
  assert.deepEqual(fromStatusErrors([]), { errorCode: null, errorTitle: null, errorDetails: null });
  assert.equal(fromStatusErrors([{ code: 1, title: 'x'.repeat(900) }]).errorTitle.length, 500);
});

test('a thrown Meta send error keeps its code; any other error keeps just its message', () => {
  const metaErr = { response: { data: { error: { code: 131047, type: 'OAuthException', message: 'Re-engagement message', error_data: { details: 'More than 24 hours' } } } } };
  assert.deepEqual(fromSendError(metaErr), { errorCode: 131047, errorTitle: 'Re-engagement message', errorDetails: 'More than 24 hours' });
  assert.deepEqual(fromSendError(new Error('socket hang up')), { errorCode: null, errorTitle: 'socket hang up', errorDetails: null });
  assert.deepEqual(fromSendError(null), { errorCode: null, errorTitle: null, errorDetails: null });
});

test('withFailure: null for healthy messages, reason for failed ones, old failed rows still get a default', () => {
  assert.equal(withFailure({ id: 1, status: 'read' }).failure, null);
  assert.equal(withFailure({ id: 1, status: 'sent', errorCode: null }).failure, null);
  const f = withFailure({ id: 1, status: 'failed', errorCode: 131026, errorTitle: 'Message undeliverable', errorDetails: 'd' }).failure;
  assert.equal(f.code, 131026);
  assert.equal(f.details, 'd');
  const old = withFailure({ id: 2, status: 'failed' }).failure; // failed before error columns existed
  assert.equal(old.code, null);
  assert.equal(old.reason, "WhatsApp couldn't deliver this message.");
  assert.equal(withFailure(null), null);
});
