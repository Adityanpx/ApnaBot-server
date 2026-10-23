// Run: node --test src/queues/broadcast.worker.catalog.test.js
// A catalogue broadcast job (job.catalog) sends each recipient the carousel template of THEIR language with their
// own name and the card pictures / texts / payloads; a failure for one recipient doesn't stop the rest; a job
// without `catalog` is untouched (the other worker tests pin that too).
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
stub('../services/usage.service', { recordOutbound: async () => {} });
const rpcs = [];
const recipientUpdates = [];
stub('../config/supabase', {
  rpc: async (name, args) => { rpcs.push([name, args]); return { error: null }; },
  from: () => {
    const q = { update: (fields) => { recipientUpdates.push(fields); return q; }, eq: () => q, then: (resolve) => resolve({ error: null }) };
    return q;
  }
});
const sent = [];
let failFor = null;
stub('../services/whatsapp.service', {
  sendTemplateMessage: async (pn, token, to, name, lang, components) => {
    if (failFor === to) throw Object.assign(new Error('boom'), { response: { data: { error: { code: 131026, message: 'undeliverable' } } } });
    sent.push({ to, name, lang, components });
    return { messages: [{ id: `wamid.${to}` }] };
  }
});
stub('../services/wallet.service', { refundToWallet: async () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/deliverySignals.service', { noteSendFailure: async () => {} });
require('./broadcast.worker');

const catalog = {
  templates: {
    en: { name: 'apnabot_catalog_v2_2_en_2', language: 'en_US' },
    hi: { name: 'apnabot_catalog_v2_2_hi_2', language: 'hi' }
  },
  cards: [
    { mediaId: 'M1', texts: { en: 'Red Kurta', hi: 'HI Red Kurta' }, payloads: ['cat:c1:p:0:b:bc', 'cat:c1:order:b:bc'] },
    { mediaId: 'M2', texts: { en: 'Blue Saree', hi: 'HI Blue Saree' }, payloads: ['cat:c2:p:0:b:bc', 'cat:c2:order:b:bc'] }
  ]
};
const run = (data) => processor({ data: { broadcastId: 'bc', businessId: 'b', phoneNumberId: 'p', encryptedAccessToken: 't', ratePerMessage: 0, billed: false, ...data } });

test.beforeEach(() => { sent.length = 0; rpcs.length = 0; recipientUpdates.length = 0; failFor = null; });

test('each recipient gets the template and card texts of their language, with their own name', async () => {
  const result = await run({
    catalog,
    recipients: [
      { whatsappNumber: '911', customer: { name: 'Asha' }, templateLang: 'en' },
      { whatsappNumber: '912', customer: { name: 'Rahul' }, templateLang: 'hi' }
    ]
  });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(sent.map(s => [s.to, s.name, s.lang]), [['911', 'apnabot_catalog_v2_2_en_2', 'en_US'], ['912', 'apnabot_catalog_v2_2_hi_2', 'hi']]);
  assert.equal(sent[0].components[0].parameters[0].text, 'Asha');
  assert.equal(sent[1].components[0].parameters[0].text, 'Rahul');
  const cards = (s) => s.components[1].cards;
  assert.deepEqual(cards(sent[0]).map(c => c.components[1].parameters[0].text), ['Red Kurta', 'Blue Saree']);
  assert.deepEqual(cards(sent[1]).map(c => c.components[1].parameters[0].text), ['HI Red Kurta', 'HI Blue Saree']);
  assert.deepEqual(cards(sent[0]).map(c => c.components[0].parameters[0].image.id), ['M1', 'M2']);
  assert.deepEqual(cards(sent[0])[1].components.filter(c => c.type === 'button').map(c => c.parameters[0].payload), ['cat:c2:p:0:b:bc', 'cat:c2:order:b:bc']);
});

test('a recipient with no name gets the fallback, not a failure', async () => {
  const result = await run({ catalog, recipients: [{ whatsappNumber: '911', customer: { name: null }, templateLang: 'en' }] });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sent[0].components[0].parameters[0].text, 'there');
});

test('a card text missing in the language falls back to English', async () => {
  const partial = { ...catalog, cards: [{ ...catalog.cards[0], texts: { en: 'Only English' } }, catalog.cards[1]] };
  await run({ catalog: partial, recipients: [{ whatsappNumber: '912', customer: { name: 'A' }, templateLang: 'hi' }] });
  assert.equal(sent[0].components[1].cards[0].components[1].parameters[0].text, 'Only English');
});

test('one failed recipient and one with no template for their language are counted, the rest still go', async () => {
  failFor = '912';
  const result = await run({
    catalog,
    recipients: [
      { whatsappNumber: '911', customer: { name: 'A' }, templateLang: 'en' },
      { whatsappNumber: '912', customer: { name: 'B' }, templateLang: 'en' },
      { whatsappNumber: '913', customer: { name: 'C' }, templateLang: 'mr' },
      { whatsappNumber: '914', customer: { name: 'D' }, templateLang: 'hi' }
    ]
  });
  assert.deepEqual(result, { sent: 2, failed: 2 });
  assert.deepEqual(sent.map(s => s.to), ['911', '914']);
  assert.deepEqual(rpcs[0][1], { p_broadcast_id: 'bc', p_sent_delta: 2, p_failed_delta: 2 });
  assert.equal(recipientUpdates.filter(f => f.status === 'failed').length, 2);
});

test('a job without `catalog` sends the shared components and template, as before', async () => {
  const components = [{ type: 'body', parameters: [{ type: 'text', text: 'x' }] }];
  await run({ templateName: 'promo', language: 'en_US', components, variableMapping: null, recipients: [{ whatsappNumber: '911', customer: { name: 'A' } }] });
  assert.deepEqual(sent, [{ to: '911', name: 'promo', lang: 'en_US', components }]);
});
