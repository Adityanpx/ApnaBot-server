// Run: node --test src/services/deliverySignals.service.test.js
// What failed / delivered messages tell us about the account and the customer. accountHealth is
// stubbed so this checks only who gets called, with what, and that nothing throws.
const test = require('node:test');
const assert = require('node:assert/strict');

let calls; let throwOn;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./marketingBlock.service', {
  isMarketingStoppedCode: (c) => Number(c) === 131050,
  blockMarketing: async (...a) => { if (throwOn === 'block') throw new Error('boom'); calls.push(['block', ...a]); }
});
stub('./accountHealth.service', {
  isPaymentIssueCode: (c) => Number(c) === 131042,
  recordPaymentIssue: async (...a) => { if (throwOn === 'record') throw new Error('boom'); calls.push(['record', ...a]); },
  clearPaymentIssueIfSentAfter: async (...a) => { calls.push(['clear', ...a]); }
});

const { noteSendFailure, noteStatusChanges } = require('./deliverySignals.service');

test.beforeEach(() => { calls = []; throwOn = null; });

test('a 131042 send failure records the payment issue for that business', async () => {
  await noteSendFailure({ businessId: 'b1', errorCode: 131042 });
  assert.deepEqual(calls, [['record', 'b1', undefined]]);
});

test('any other code, or no code, records nothing', async () => {
  await noteSendFailure({ businessId: 'b1', errorCode: 131026 });
  await noteSendFailure({ businessId: 'b1', errorCode: null });
  assert.deepEqual(calls, []);
});

test('noteSendFailure never throws', async () => {
  throwOn = 'record';
  await noteSendFailure({ businessId: 'b1', errorCode: 131042 });
});

test('failed rows (chat and broadcast) with 131042 record it for the row\'s own business', async () => {
  await noteStatusChanges(
    [{ business_id: 'b1', status: 'failed', error_code: 131042, failed_at: '2026-10-10T10:00:00Z' }],
    [{ business_id: 'b2', status: 'failed', error_code: 131042, failed_at: '2026-10-10T11:00:00Z' }]
  );
  assert.deepEqual(calls, [['record', 'b1', '2026-10-10T10:00:00Z'], ['record', 'b2', '2026-10-10T11:00:00Z']]);
});

test('failed rows with other codes, and non-failed chat rows, record nothing and clear nothing', async () => {
  await noteStatusChanges(
    [{ business_id: 'b1', status: 'failed', error_code: 131026 }, { business_id: 'b1', status: 'delivered', error_code: null, sent_at: '2026-10-10T10:00:00Z' }],
    []
  );
  assert.deepEqual(calls, []);
});

test('delivered / read broadcast recipients clear once per business, using the latest send', async () => {
  await noteStatusChanges([], [
    { business_id: 'b1', status: 'delivered', sent_at: '2026-10-10T10:00:00Z' },
    { business_id: 'b1', status: 'read', sent_at: '2026-10-10T10:05:00Z' },
    { business_id: 'b1', status: 'delivered', sent_at: '2026-10-10T10:01:00Z' },
    { business_id: 'b2', status: 'delivered', sent_at: '2026-10-10T09:00:00Z' }
  ]);
  assert.deepEqual(calls.map(([k, b, t]) => [k, b, t.toISOString()]), [
    ['clear', 'b1', '2026-10-10T10:05:00.000Z'],
    ['clear', 'b2', '2026-10-10T09:00:00.000Z']
  ]);
});

test('a recipient with no send time cannot clear anything', async () => {
  await noteStatusChanges([], [{ business_id: 'b1', status: 'delivered', sent_at: null }]);
  assert.deepEqual(calls, []);
});

test('missing / null lists are fine', async () => {
  await noteStatusChanges(undefined, null);
  assert.deepEqual(calls, []);
});

test('a 131050 send failure blocks marketing for that customer of that business, by id or by number', async () => {
  await noteSendFailure({ businessId: 'b1', errorCode: 131050, customerId: 'c1', whatsappNumber: '911' });
  await noteSendFailure({ businessId: 'b1', errorCode: 131050, whatsappNumber: '912' });
  assert.deepEqual(calls, [
    ['block', { businessId: 'b1', customerId: 'c1', whatsappNumber: '911', at: undefined }],
    ['block', { businessId: 'b1', customerId: null, whatsappNumber: '912', at: undefined }]
  ]);
});

test('131050 never records a payment issue and 131042 never blocks marketing', async () => {
  await noteSendFailure({ businessId: 'b1', errorCode: 131050, customerId: 'c1' });
  await noteSendFailure({ businessId: 'b1', errorCode: 131042, customerId: 'c1' });
  assert.deepEqual(calls.map((c) => c[0]), ['block', 'record']);
});

test('failed rows with 131050 block the customer of that same row, at the failure time', async () => {
  await noteStatusChanges(
    [{ business_id: 'b1', customer_id: 'c1', customer_number: '911', status: 'failed', error_code: 131050, failed_at: '2026-10-10T10:00:00Z' }],
    [{ business_id: 'b2', customer_id: null, whatsapp_number: '912', status: 'failed', error_code: 131050, failed_at: '2026-10-10T11:00:00Z' }]
  );
  assert.deepEqual(calls, [
    ['block', { businessId: 'b1', customerId: 'c1', whatsappNumber: '911', at: '2026-10-10T10:00:00Z' }],
    ['block', { businessId: 'b2', customerId: null, whatsappNumber: '912', at: '2026-10-10T11:00:00Z' }]
  ]);
});

test('a block error never escapes', async () => {
  throwOn = 'block';
  await noteSendFailure({ businessId: 'b1', errorCode: 131050, customerId: 'c1' });
  await noteStatusChanges([{ business_id: 'b1', customer_id: 'c1', status: 'failed', error_code: 131050 }], []);
});
