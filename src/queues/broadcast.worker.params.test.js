// Run: node --test src/queues/broadcast.worker.params.test.js
// #6 Phase 2: the components the worker sends per recipient for a TEXT-header
// variable and dynamic URL buttons (mapping targets 'header' / 'button'),
// alongside the shared media header and the body. BullMQ is stubbed so the
// processor can be called directly.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let processor;
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test', WALLET_BILLING_ENABLED: false });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../config/supabase', { rpc: async () => ({ error: null }) });
const sent = [];
stub('../services/whatsapp.service', {
  sendTemplateMessage: async (pn, token, to, name, lang, components) => { sent.push({ to, components }); }
});
stub('../services/wallet.service', { refundToWallet: async () => {} });

require('./broadcast.worker');

const run = (data) => processor({
  data: {
    broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't', templateName: 'promo', language: 'en_US',
    components: [], variableMapping: null, ratePerMessage: 0, billed: false, ...data
  }
});
const text = (t) => ({ type: 'text', text: t });

test.beforeEach(() => { sent.length = 0; });

test('TEXT header variable + body + dynamic URL button, per recipient, in header / body / button order', async () => {
  const result = await run({
    variableMapping: [
      { position: 1, source: 'static', value: 'the course' },
      { target: 'header', source: 'customer.name' },
      { target: 'button', buttonIndex: 1, source: 'static', value: 'abc123' }
    ],
    recipients: [{ whatsappNumber: '911', customer: { name: 'Asha' } }, { whatsappNumber: '912', customer: { name: 'Ravi' } }]
  });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(sent[0].components, [
    { type: 'header', parameters: [text('Asha')] },
    { type: 'body', parameters: [text('the course')] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [text('abc123')] }
  ]);
  assert.deepEqual(sent[1].components[0], { type: 'header', parameters: [text('Ravi')] });
});

test('shared media header passes through ahead of the per-recipient body and button', async () => {
  const mediaHeader = { type: 'header', parameters: [{ type: 'video', video: { link: 'https://r2/x.mp4' } }] };
  await run({
    components: [mediaHeader],
    variableMapping: [{ position: 1, source: 'customer.name' }, { target: 'button', buttonIndex: 0, source: 'static', value: 'z' }],
    recipients: [{ whatsappNumber: '911', customer: { name: 'Asha' } }]
  });
  assert.deepEqual(sent[0].components, [
    mediaHeader,
    { type: 'body', parameters: [text('Asha')] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [text('z')] }
  ]);
});

test('a recipient with no name fails on a customer.name header variable (counted as failed, others still sent)', async () => {
  const result = await run({
    variableMapping: [{ target: 'header', source: 'customer.name' }],
    recipients: [{ whatsappNumber: '911', customer: { name: '  ' } }, { whatsappNumber: '912', customer: { name: 'Ravi' } }]
  });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  assert.deepEqual(sent.map(s => s.to), ['912']);
});

test('an empty static button value fails the recipient instead of sending an empty parameter', async () => {
  const result = await run({
    variableMapping: [{ target: 'button', buttonIndex: 0, source: 'static', value: ' ' }],
    recipients: [{ whatsappNumber: '911', customer: {} }]
  });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.equal(sent.length, 0);
});

test('a mapping of body entries only builds just the body, as before', async () => {
  await run({
    variableMapping: [{ position: 2, source: 'static', value: 'B' }, { position: 1, source: 'static', value: 'A' }],
    recipients: [{ whatsappNumber: '911', customer: {} }]
  });
  assert.deepEqual(sent[0].components, [{ type: 'body', parameters: [text('A'), text('B')] }]);
});
