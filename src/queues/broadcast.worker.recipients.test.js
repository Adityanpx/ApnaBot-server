// Run: node --test src/queues/broadcast.worker.recipients.test.js
// The broadcast worker records each recipient's outcome on its broadcast_recipients
// row: the wamid and sent_at on success (so Meta's status webhooks can find it),
// Meta's rejection (code, title, details) on failure. A broadcast with no rows
// (sent before delivery tracking) behaves as before. BullMQ, Meta, Supabase stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let processor; let rows; let rpcCalls; let sendImpl; let failTable; let notified;
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test', WALLET_BILLING_ENABLED: false });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/wallet.service', { refundToWallet: async () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: (...a) => { notified.push(a); } });
stub('../config/supabase', {
  rpc: async (name, args) => { rpcCalls.push([name, args]); return { error: null }; },
  from: (table) => {
    const filters = []; let patch;
    const q = {
      update: (p) => { patch = p; return q; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      then: (resolve) => {
        if (failTable === table) return resolve({ error: { message: 'db down' } });
        rows.filter((r) => filters.every((f) => f(r))).forEach((r) => Object.assign(r, patch));
        return resolve({ error: null });
      }
    };
    return q;
  }
});
stub('../services/whatsapp.service', { sendTemplateMessage: async (...a) => sendImpl(...a) });

require('./broadcast.worker');

const row = (n, extra = {}) => ({ broadcast_id: 'bc', whatsapp_number: n, status: 'queued', ...extra });
const run = (numbers, extra = {}) => processor({
  data: {
    broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't', templateName: 'promo', language: 'en',
    components: [], variableMapping: null, ratePerMessage: 0,
    recipients: numbers.map((n) => ({ whatsappNumber: n, customerId: `c${n}` })), ...extra
  }
});
const byNumber = (n) => rows.find((r) => r.whatsapp_number === n);
const metaReject = (code, message, details) => Object.assign(new Error('Request failed with status code 400'), { response: { data: { error: { code, message, type: 'OAuthException', error_data: { details } } } } });

test.beforeEach(() => { rows = [row('911'), row('912'), row('913')]; rpcCalls = []; notified = []; failTable = null; sendImpl = async (pn, tok, to) => ({ messages: [{ id: `wamid.${to}` }] }); });

test('a send saves the wamid and sent_at on the recipient row', async () => {
  const result = await run(['911']);
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(byNumber('911').status, 'sent');
  assert.equal(byNumber('911').meta_message_id, 'wamid.911');
  assert.ok(!Number.isNaN(Date.parse(byNumber('911').sent_at)));
  assert.equal(byNumber('912').status, 'queued'); // untouched
});

test("Meta's rejection is stored on the row: code, title, details, failed_at", async () => {
  sendImpl = async () => { throw metaReject(131026, 'Message undeliverable', 'Not on WhatsApp'); };
  const result = await run(['912']);
  assert.deepEqual(result, { sent: 0, failed: 1 });
  const r = byNumber('912');
  assert.deepEqual([r.status, r.error_code, r.error_title, r.error_details], ['failed', 131026, 'Message undeliverable', 'Not on WhatsApp']);
  assert.ok(!Number.isNaN(Date.parse(r.failed_at)));
  assert.equal(r.meta_message_id, undefined);
});

test('our own check failing (no name on file) is stored without a Meta code', async () => {
  const result = await run(['913'], { variableMapping: [{ position: 1, source: 'customer.name' }], recipients: [{ whatsappNumber: '913', customer: { name: '' } }] });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.deepEqual([byNumber('913').status, byNumber('913').error_code, byNumber('913').error_title], ['failed', null, 'recipient has no name on file']);
});

test('a mixed batch: each recipient gets its own result, counters unchanged', async () => {
  sendImpl = async (pn, tok, to) => { if (to === '912') throw metaReject(131049, 'Healthy ecosystem', 'd'); return { messages: [{ id: `wamid.${to}` }] }; };
  await run(['911', '912', '913']);
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'failed', 'sent']);
  assert.deepEqual(rpcCalls, [['increment_broadcast_progress', { p_broadcast_id: 'bc', p_sent_delta: 2, p_failed_delta: 1 }]]);
});

test('only a queued row is written: a row already settled is never overwritten', async () => {
  rows = [row('911', { status: 'delivered', meta_message_id: 'wamid.old' })];
  await run(['911']);
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['delivered', 'wamid.old']);
});

test('a broadcast with no recipient rows (sent before tracking) just sends and counts', async () => {
  rows = [];
  assert.deepEqual(await run(['911', '912']), { sent: 2, failed: 0 });
  assert.equal(rpcCalls[0][1].p_sent_delta, 2);
});

test('a database error while recording does not fail the send or the counts', async () => {
  failTable = 'broadcast_recipients';
  assert.deepEqual(await run(['911', '912']), { sent: 2, failed: 0 });
  assert.equal(rpcCalls[0][1].p_sent_delta, 2);
});

test('a send response without an id still marks the recipient sent', async () => {
  sendImpl = async () => ({ messaging_product: 'whatsapp' });
  await run(['911']);
  assert.deepEqual([byNumber('911').status, byNumber('911').meta_message_id], ['sent', null]);
});

test('the dashboard is told once per batch, after the counters are updated', async () => {
  await run(['911', '912', '913']);
  assert.deepEqual(notified, [['b', 'bc']]);
});
