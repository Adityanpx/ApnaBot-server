// Run: node --test src/queues/broadcast.worker.quickReply.test.js
// #6 Phase 4b: a broadcast with a variable mapping rebuilds components per
// recipient (no template row there) - the quick-reply payload components the
// controller put in the job data must still be sent.
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
stub('../services/whatsapp.service', { sendTemplateMessage: async (pn, token, to, name, lang, components) => { sent.push({ to, components }); } });
stub('../services/wallet.service', { refundToWallet: async () => {} });
require('./broadcast.worker');

const run = (data) => processor({
  data: {
    broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't', templateName: 'promo', language: 'en_US',
    components: [], variableMapping: null, ratePerMessage: 0, billed: false, ...data
  }
});
const text = (t) => ({ type: 'text', text: t });
const qr = (index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: `tpl:T:${index}` }] });

test.beforeEach(() => { sent.length = 0; });

test('mapped broadcast: quick-reply payloads follow the body, merged with a URL button in index order', async () => {
  await run({
    variableMapping: [{ position: 1, source: 'customer.name' }, { target: 'button', buttonIndex: 1, source: 'static', value: 'abc' }],
    quickReplyComponents: [qr(0), qr(2)],
    recipients: [{ whatsappNumber: '911', customer: { name: 'Asha' } }]
  });
  assert.deepEqual(sent[0].components, [
    { type: 'body', parameters: [text('Asha')] },
    qr(0),
    { type: 'button', sub_type: 'url', index: '1', parameters: [text('abc')] },
    qr(2)
  ]);
});

test('a job queued before quickReplyComponents existed sends exactly what it did before', async () => {
  await run({
    variableMapping: [{ position: 1, source: 'customer.name' }],
    recipients: [{ whatsappNumber: '911', customer: { name: 'Asha' } }]
  });
  assert.deepEqual(sent[0].components, [{ type: 'body', parameters: [text('Asha')] }]);
});

test('unmapped broadcast: the shared components (already holding the payloads) go out unchanged', async () => {
  const components = [{ type: 'body', parameters: [text('x')] }, qr(0)];
  await run({ components, recipients: [{ whatsappNumber: '911', customer: { name: 'Asha' } }] });
  assert.deepEqual(sent[0].components, components);
});
