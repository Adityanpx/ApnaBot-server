// Run: node --test src/controllers/webhook.controller.test.js
// upsertCustomerForInboundMessage: if a contact import (or the customer's own
// concurrent message) inserts the same number between the read and the
// insert, the insert's unique violation (23505) is recovered by re-reading
// the row and bumping it — the inbound message is still processed. In-memory
// Supabase; Redis / queues are stubbed so nothing connects.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let insertError; let onInsert; let calls;
const from = (table) => {
  assert.equal(table, 'customers');
  const filters = []; let op = 'select'; let payload;
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    maybeSingle: async () => { calls.push('select'); return { data: rows.find(r => filters.every(f => f(r))) || null, error: null }; },
    single: async () => {
      calls.push(op);
      if (op === 'insert') {
        if (onInsert) onInsert();
        if (insertError) return { data: null, error: insertError };
        const row = { id: `c${rows.length + 1}`, ...payload };
        rows.push(row);
        return { data: row, error: null };
      }
      const row = rows.find(r => filters.every(f => f(r)));
      Object.assign(row, payload);
      return { data: row, error: null };
    }
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {}, addToWhatsappQueueAndWait: async () => {} });
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
const { upsertCustomerForInboundMessage } = require('./webhook.controller');

const imported = () => ({ id: 'imp', business_id: 'b', whatsapp_number: '919800000001', name: null, total_messages: 0, opted_in: true });

test.beforeEach(() => { rows = []; insertError = null; onInsert = null; calls = []; });

test('new customer: inserted with one message', async () => {
  const c = await upsertCustomerForInboundMessage('b', '919800000001', 'Ravi');
  assert.equal(c.name, 'Ravi');
  assert.equal(c.totalMessages, 1);
  assert.ok(c.lastActivityAt);
  assert.equal(c.lastActivityAt, c.lastMessageAt);
  assert.deepEqual(calls, ['select', 'insert']);
});

test('existing customer: bumped, an owner-set name is kept', async () => {
  rows = [{ ...imported(), name: 'Ravi (owner)', total_messages: 4 }];
  const c = await upsertCustomerForInboundMessage('b', '919800000001', 'Ravi WA');
  assert.equal(c.totalMessages, 5);
  assert.equal(c.name, 'Ravi (owner)');
  assert.ok(c.lastActivityAt);
  assert.equal(c.lastActivityAt, c.lastMessageAt);
  assert.deepEqual(calls, ['select', 'update']);
});

test('insert loses the race (23505): re-read, bumped, imported fields kept', async () => {
  // The import lands between our read and our insert.
  onInsert = () => rows.push(imported());
  insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
  const c = await upsertCustomerForInboundMessage('b', '919800000001', 'Ravi');
  assert.equal(c.id, 'imp');
  assert.equal(c.totalMessages, 1);
  assert.equal(c.name, 'Ravi'); // empty name backfilled from WhatsApp, as for any existing row
  assert.equal(c.optedIn, true);
  assert.ok(c.lastMessageAt);
  assert.deepEqual(calls, ['select', 'insert', 'select', 'update']);
});

test('23505 but the row still is not there: the error is thrown', async () => {
  insertError = { code: '23505', message: 'duplicate key' };
  await assert.rejects(upsertCustomerForInboundMessage('b', '919800000001', 'Ravi'), (e) => e.code === '23505');
});

test('any other insert error is thrown, no re-read', async () => {
  insertError = { code: '23502', message: 'null value' };
  await assert.rejects(upsertCustomerForInboundMessage('b', '919800000001', 'Ravi'), (e) => e.code === '23502');
  assert.deepEqual(calls, ['select', 'insert']);
});
