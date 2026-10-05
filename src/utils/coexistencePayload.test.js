// Run: node --test src/utils/coexistencePayload.test.js
// Parsing of Meta's coexistence webhook payloads (shapes from Meta's webhook
// reference): echoes, history chunks, contact sync, account_update events.
const test = require('node:test');
const assert = require('node:assert/strict');
const { digits, parseEcho, parseHistoryEntry, parseStateSync, historyStatus, accountUpdateAction, isBulkSyncBody } = require('./coexistencePayload');

const BIZ = '919607024225';

test('digits: formatting is ignored', () => {
  assert.equal(digits('+91 96070 24225'), '919607024225');
  assert.equal(digits(undefined), '');
  assert.equal(digits(null), '');
});

test('parseEcho: a text echo to a customer', () => {
  const r = parseEcho({ from: BIZ, to: '919800000001', id: 'wamid.E1', timestamp: '1760000000', type: 'text', text: { body: 'On my way' } }, BIZ);
  assert.deepEqual(r.row, { metaId: 'wamid.E1', customerNumber: '919800000001', type: 'text', content: 'On my way', createdAt: '2025-10-09T08:53:20.000Z' });
});

test('parseEcho: media echoes get the inbox label; unknown types a quiet label', () => {
  assert.equal(parseEcho({ id: 'a', to: '919800000001', type: 'image', image: { caption: 'Receipt' } }, BIZ).row.content, '📷 Photo: Receipt');
  assert.equal(parseEcho({ id: 'a', to: '919800000001', type: 'document', document: { filename: 'x.pdf' } }, BIZ).row.content, '📄 x.pdf');
  const odd = parseEcho({ id: 'a', to: '919800000001', type: 'poll' }, BIZ).row;
  assert.equal(odd.type, 'unsupported');
  assert.equal(odd.content, '[Message type not supported]');
  assert.ok(!/resend/.test(odd.content));
});

test('parseEcho: revoke and edit are skipped, as are echoes with no id, no recipient or to the business itself', () => {
  assert.equal(parseEcho({ id: 'a', to: '919800000001', type: 'revoke', revoke: { original_message_id: 'x' } }, BIZ).skip, 'revoke');
  assert.equal(parseEcho({ id: 'a', to: '919800000001', type: 'edit', edit: {} }, BIZ).skip, 'edit');
  assert.equal(parseEcho({ to: '919800000001', type: 'text' }, BIZ).skip, 'no message id');
  assert.equal(parseEcho({ id: 'a', type: 'text' }, BIZ).skip, 'no recipient');
  assert.equal(parseEcho({ id: 'a', to: '+91 96070 24225', type: 'text' }, BIZ).skip, 'sent to the business number itself');
  assert.ok(parseEcho({ id: 'a', to: '919800000001', type: 'text', text: { body: 'x' } }, BIZ).row.createdAt === null);
});

const history = (messages, id = '919800000001', meta = { phase: 0, chunk_order: 1, progress: 55 }) =>
  ({ metadata: meta, threads: [{ id, messages }] });

test('parseHistoryEntry: direction from `from` - business number out, customer number in; both compared as digits', () => {
  const r = parseHistoryEntry(history([
    { from: '+91 96070 24225', to: '919800000001', id: 'm1', timestamp: '1760000000', type: 'text', text: { body: 'hello' }, history_context: { status: 'READ' } },
    { from: '919800000001', to: '919607024225', id: 'm2', timestamp: '1760000100', type: 'text', text: { body: 'hi' }, history_context: { status: 'DELIVERED' } }
  ]), BIZ);
  assert.deepEqual(r.messages.map(m => [m.metaId, m.direction, m.customerNumber, m.content]), [
    ['m1', 'outbound', '919800000001', 'hello'],
    ['m2', 'inbound', '919800000001', 'hi']
  ]);
  assert.deepEqual(r.meta, { phase: 0, chunk_order: 1, progress: 55 });
  assert.equal(r.threads, 1);
  assert.equal(r.unmatched, 0);
});

test('parseHistoryEntry: statuses - ERROR is failed, everything else delivered', () => {
  assert.equal(historyStatus('ERROR'), 'failed');
  assert.equal(historyStatus('error'), 'failed');
  for (const s of ['READ', 'DELIVERED', 'SENT', 'PLAYED', 'PENDING', undefined]) assert.equal(historyStatus(s), 'delivered', String(s));
});

test('parseHistoryEntry: a message from neither side, or with no id, is counted as unmatched; a thread that is the business itself is dropped', () => {
  const r = parseHistoryEntry(history([
    { from: '911111111111', to: BIZ, id: 'x1', type: 'text' },
    { from: BIZ, to: '919800000001', type: 'text' },
    { from: BIZ, to: '919800000001', id: 'ok', type: 'text', text: { body: 'fine' } }
  ]), BIZ);
  assert.deepEqual(r.messages.map(m => m.metaId), ['ok']);
  assert.equal(r.unmatched, 2);

  const self = parseHistoryEntry(history([{ from: BIZ, to: BIZ, id: 'y', type: 'text' }], BIZ), BIZ);
  assert.deepEqual(self.messages, []);
  assert.equal(self.unmatched, 1);
});

test('parseHistoryEntry: media without ids still gets a label; unknown types a quiet one', () => {
  const r = parseHistoryEntry(history([
    { from: '919800000001', id: 'p', type: 'image', image: { caption: 'x' } },
    { from: '919800000001', id: 'q', type: 'something_new' }
  ]), BIZ);
  assert.equal(r.messages[0].content, '📷 Photo: x');
  assert.deepEqual([r.messages[1].type, r.messages[1].content], ['unsupported', '[Message type not supported]']);
});

test('parseHistoryEntry: the history-declined error (2593109) comes back as errors with no messages', () => {
  const r = parseHistoryEntry({ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App' }] }, BIZ);
  assert.deepEqual(r.errors.map(e => e.code), [2593109]);
  assert.deepEqual(r.messages, []);
});

test('parseHistoryEntry: without a business number in the payload, direction still follows the thread', () => {
  const r = parseHistoryEntry(history([{ from: '919607024225', id: 'a', type: 'text' }, { from: '919800000001', id: 'b', type: 'text' }]), '');
  assert.deepEqual(r.messages.map(m => m.direction), ['outbound', 'inbound']);
});

test('parseStateSync: adds with names, removes counted, bad numbers and shapes invalid; repeats merged', () => {
  const r = parseStateSync([
    { type: 'contact', action: 'add', contact: { full_name: 'Ravi Kumar', first_name: 'Ravi', phone_number: '+91 98000 00001' } },
    { type: 'contact', action: 'add', contact: { first_name: 'Sita', phone_number: '919800000002' } },
    { type: 'contact', action: 'add', contact: { full_name: 'Ravi K.', phone_number: '919800000001' } },
    { type: 'contact', action: 'add', contact: { phone_number: '919800000003' } },
    { type: 'contact', action: 'remove', contact: { phone_number: '919800000004' } },
    { type: 'contact', action: 'add', contact: { full_name: 'Bad', phone_number: '123' } },
    { type: 'other', action: 'add', contact: {} },
    null
  ]);
  assert.deepEqual(r.adds, [
    { phone: '919800000001', name: 'Ravi K.' },
    { phone: '919800000002', name: 'Sita' },
    { phone: '919800000003', name: null }
  ]);
  assert.equal(r.removes, 1);
  assert.equal(r.invalid, 3);
  assert.deepEqual(parseStateSync(undefined), { adds: [], removes: 0, invalid: 0 });
});

test('accountUpdateAction: disconnect events, reconnect, everything else just logged', () => {
  for (const e of ['PARTNER_REMOVED', 'ACCOUNT_DELETED', 'ACCOUNT_OFFBOARDED']) assert.equal(accountUpdateAction(e), 'disconnect', e);
  assert.equal(accountUpdateAction('ACCOUNT_RECONNECTED'), 'reconnect');
  for (const e of ['PARTNER_ADDED', 'DISABLED_UPDATE', 'ACCOUNT_VIOLATION', 'PARTNER_APP_UNINSTALLED', 'SOMETHING_NEW', undefined]) assert.equal(accountUpdateAction(e), 'log', String(e));
});

test('isBulkSyncBody: only history / contact-sync bodies skip the full-body log', () => {
  const body = (field) => ({ entry: [{ changes: [{ field }] }] });
  assert.equal(isBulkSyncBody(body('history')), true);
  assert.equal(isBulkSyncBody(body('smb_app_state_sync')), true);
  assert.equal(isBulkSyncBody({ entry: [{ changes: [{ field: 'messages' }, { field: 'history' }] }] }), true);
  for (const f of ['messages', 'smb_message_echoes', 'account_update']) assert.equal(isBulkSyncBody(body(f)), false, f);
  for (const b of [undefined, {}, { entry: 'x' }, { entry: [{}] }]) assert.equal(isBulkSyncBody(b), false);
});
