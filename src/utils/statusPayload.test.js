// Run: node --test src/utils/statusPayload.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatusEvents, statusOnlySummary } = require('./statusPayload');

test('events: only statuses that can change a row, with Meta\'s timestamp as an integer', () => {
  const { events, ignored } = buildStatusEvents([
    { id: 'w1', status: 'sent', timestamp: '1' },
    { id: 'w1', status: 'delivered', timestamp: '1767261600' },
    { id: 'w1', status: 'read' },
    { id: 'w2', status: 'failed', timestamp: '1767261601', errors: [{ code: 131026, title: 'T', error_data: { details: 'D' } }] },
    { id: 'w3', status: 'deleted' },
    { status: 'delivered' },
    null
  ]);
  assert.deepEqual(events, [
    { wamid: 'w1', status: 'delivered', ts: 1767261600, error_code: null, error_title: null, error_details: null },
    { wamid: 'w1', status: 'read', ts: null, error_code: null, error_title: null, error_details: null },
    { wamid: 'w2', status: 'failed', ts: 1767261601, error_code: 131026, error_title: 'T', error_details: 'D' }
  ]);
  assert.deepEqual(ignored.map((s) => s.status), ['deleted']);
});

test('errors are only read for failed statuses; garbage input is empty', () => {
  const { events } = buildStatusEvents([{ id: 'w', status: 'delivered', errors: [{ code: 5 }] }]);
  assert.equal(events[0].error_code, null);
  assert.deepEqual(buildStatusEvents(undefined), { events: [], ignored: [] });
});

const status = (list, extra = {}) => ({ entry: [{ changes: [{ value: { statuses: list, ...extra } }] }] });

test('summary: counts per status, failed codes, no phone numbers', () => {
  const line = statusOnlySummary(status([
    { status: 'delivered', recipient_id: '919800000001' }, { status: 'delivered' }, { status: 'read' },
    { status: 'failed', errors: [{ code: 131026 }] }, { status: 'failed', errors: [{ code: 131026 }] }, { status: 'failed', errors: [{ code: 130429 }] }
  ]));
  assert.equal(line, 'WEBHOOK POST received (statuses only): 6 - delivered x2, read x1, failed x3 [131026, 130429]');
  assert.ok(!line.includes('9198'));
});

test('summary is null for anything that is not status-only', () => {
  assert.equal(statusOnlySummary(status([{ status: 'read' }], { messages: [{ id: 'm' }] })), null);
  assert.equal(statusOnlySummary({ entry: [{ changes: [{ value: { messages: [{}] } }] }] }), null);
  assert.equal(statusOnlySummary({ entry: [{ changes: [{ field: 'history', value: {} }] }] }), null);
  assert.equal(statusOnlySummary(status([])), null);
  assert.equal(statusOnlySummary(undefined), null);
  assert.equal(statusOnlySummary({ entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }, { value: { messages: [{}] } }] }] }), null);
});
