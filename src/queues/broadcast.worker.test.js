// Run: node --test src/queues/broadcast.worker.test.js
// A failed broadcast send is refunded only when broadcast.controller.js
// actually debited the wallet (job.data.billed). Jobs queued before `billed`
// existed fall back to WALLET_BILLING_ENABLED. BullMQ is stubbed so the
// worker's processor can be called directly.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let processor;
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
let billing = false;
const sentComponents = [];
stub('../config/env', { QUEUE_NAMESPACE: 'test', get WALLET_BILLING_ENABLED() { return billing; } });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../config/supabase', { rpc: async () => ({ error: null }) });
stub('../services/whatsapp.service', {
  sendTemplateMessage: async (phoneNumberId, token, to, name, lang, components) => {
    sentComponents.push({ to, components });
    if (to === 'bad') throw new Error('invalid number');
  }
});
const refunds = [];
stub('../services/wallet.service', {
  refundToWallet: async (businessId, paise) => { refunds.push(paise); }
});

stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
require('./broadcast.worker');

const run = (data) => processor({
  data: {
    broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't',
    templateName: 'promo', language: 'en_US', components: [], variableMapping: null,
    ratePerMessage: 80,
    recipients: [{ whatsappNumber: 'good' }, { whatsappNumber: 'bad' }],
    ...data
  }
});

test.beforeEach(() => { refunds.length = 0; sentComponents.length = 0; billing = false; });

// Step A (#6 Phase 2): components on the wire must match what the worker built before.
test('mapped variables: header passthrough + per-recipient body, values cleaned for Meta', async () => {
  const header = { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/a.jpg' } }] };
  await run({
    components: [header, { type: 'body', parameters: [{ type: 'text', text: 'ignored' }] }],
    variableMapping: [{ position: 2, source: 'static', value: 'SALE' }, { position: 1, source: 'customer.name' }],
    recipients: [{ whatsappNumber: 'good', customer: { name: ' Ravi ' } }]
  });
  assert.equal(JSON.stringify(sentComponents[0].components), JSON.stringify([
    header,
    { type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'SALE' }] }
  ]));
});

test('mapped variables, no header: body only; no mapping: components passed through untouched', async () => {
  await run({
    variableMapping: [{ position: 1, source: 'static', value: 'X' }],
    recipients: [{ whatsappNumber: 'good', customer: {} }]
  });
  assert.equal(JSON.stringify(sentComponents[0].components), JSON.stringify([{ type: 'body', parameters: [{ type: 'text', text: 'X' }] }]));
  sentComponents.length = 0;
  const shared = [{ type: 'body', parameters: [{ type: 'text', text: 'Hi' }] }];
  await run({ components: shared, recipients: [{ whatsappNumber: 'good' }] });
  assert.equal(sentComponents[0].components, shared);
});

test('billed: a failed send is refunded', async () => {
  const result = await run({ billed: true });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(refunds, [80]);
});

test('not billed (billing off): no refund even though a rate exists', async () => {
  const result = await run({ billed: false });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(refunds, []);
});

test('not billed with billing switched on since: still no refund', async () => {
  billing = true;
  await run({ billed: false });
  assert.deepEqual(refunds, []);
});

test('old job without `billed`: follows WALLET_BILLING_ENABLED', async () => {
  billing = false;
  await run({ billed: undefined });
  assert.deepEqual(refunds, []);
  billing = true;
  await run({ billed: undefined });
  assert.deepEqual(refunds, [80]);
});

test('rate 0: never refunds', async () => {
  billing = true;
  await run({ billed: true, ratePerMessage: 0 });
  await run({ billed: undefined, ratePerMessage: 0 });
  assert.deepEqual(refunds, []);
});
