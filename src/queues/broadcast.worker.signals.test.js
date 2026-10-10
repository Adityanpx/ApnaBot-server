// Run: node --test src/queues/broadcast.worker.signals.test.js
// A recipient Meta rejects at send time tells the delivery signals about it: a
// payment-method failure (131042) is noted once per batch, however many
// recipients hit it. BullMQ, Meta, Supabase and the signals are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let processor; let sendImpl; let signals;
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test', WALLET_BILLING_ENABLED: false });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/wallet.service', { refundToWallet: async () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/deliverySignals.service', { noteSendFailure: async (f) => { signals.push(f); } });
stub('../config/supabase', {
  rpc: async () => ({ error: null }),
  from: () => { const q = { update: () => q, eq: () => q, then: (resolve) => resolve({ error: null }) }; return q; }
});
stub('../services/whatsapp.service', { sendTemplateMessage: async (...a) => sendImpl(...a) });

require('./broadcast.worker');

const run = (numbers) => processor({
  data: {
    broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't', templateName: 'promo', language: 'en',
    components: [], variableMapping: null, ratePerMessage: 0,
    recipients: numbers.map((n) => ({ whatsappNumber: n, customerId: `c${n}` }))
  }
});
const metaReject = (code) => Object.assign(new Error('400'), { response: { data: { error: { code, message: 'm', type: 'OAuthException' } } } });

test.beforeEach(() => { signals = []; sendImpl = async () => ({ messages: [{ id: 'wamid.x' }] }); });

test('a payment-method rejection is noted once for the whole batch', async () => {
  sendImpl = async () => { throw metaReject(131042); };
  const result = await run(['911', '912', '913']);
  assert.deepEqual(result, { sent: 0, failed: 3 });
  assert.deepEqual(signals, [{ businessId: 'b', errorCode: 131042, customerId: 'c911', whatsappNumber: '911' }]);
});

test('other rejections are passed on one by one, and a clean send passes nothing', async () => {
  sendImpl = async (pn, tok, to) => { if (to === '912') throw metaReject(131026); return { messages: [{ id: `wamid.${to}` }] }; };
  await run(['911', '912']);
  assert.deepEqual(signals, [{ businessId: 'b', errorCode: 131026, customerId: 'c912', whatsappNumber: '912' }]);
});

test('a local failure (no Meta code) is passed on with no code', async () => {
  sendImpl = async () => { throw new Error('socket hang up'); };
  await run(['911']);
  assert.deepEqual(signals, [{ businessId: 'b', errorCode: null, customerId: 'c911', whatsappNumber: '911' }]);
});

test('a stopped-marketing rejection (131050) is passed on for every customer it hits, not once per batch', async () => {
  sendImpl = async () => { throw metaReject(131050); };
  await run(['911', '912']);
  assert.deepEqual(signals, [
    { businessId: 'b', errorCode: 131050, customerId: 'c911', whatsappNumber: '911' },
    { businessId: 'b', errorCode: 131050, customerId: 'c912', whatsappNumber: '912' }
  ]);
});
