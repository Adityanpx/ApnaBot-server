// Run: node --test src/services/windowAwareSend.phase2.test.js
// #6 Phase 2: a template send with a media header, a TEXT-header variable and
// URL / phone buttons — the components Meta gets, what the chat shows (media +
// button labels), and the send-time re-check. Supabase, the wallet and
// WhatsApp are in-memory stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let messages; let sent; let wallet;

const from = (table) => {
  let payload;
  const q = {
    insert: (p) => { payload = p; return q; },
    select: () => q,
    single: async () => {
      const row = { id: `m${messages.length + 1}`, ...payload };
      if (table === 'messages') messages.push(row);
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
stub('../config/env', { WALLET_BILLING_ENABLED: true });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./rateCard.service', { getRateForMessage: async () => 12 });
stub('./wallet.service', {
  debitWallet: async (b, amt) => { wallet.push({ type: 'debit', amt }); },
  refundToWallet: async (b, amt) => { wallet.push({ type: 'refund', amt }); }
});
stub('./whatsapp.service', { sendTemplateMessage: async (pn, tok, to, name, lang, components) => { sent.push({ to, name, components }); } });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });

const { sendWindowAwareMessage } = require('./windowAwareSend.service');

const business = { id: 'b', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' };
const closedCustomer = () => ({ id: 'c1', business_id: 'b', whatsapp_number: '919800000001', is_blocked: false, last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() });
const base = { name: 'pay_now', language: 'en_US', category: 'UTILITY', status: 'approved', send_support: 'ok', body_text: 'Hi {{1}}' };
const opts = (template, over = {}) => ({
  textFor: () => 'text', template, templateParams: ['Asha'], templateText: 'Hi Asha',
  billing: { referenceId: 'r', notes: 'n', refundNotes: 'rn' }, ...over
});

test.beforeEach(() => { messages = []; sent = []; wallet = []; });

test('IMAGE header: sent as header + body, recorded as an image message with the text as caption', async () => {
  const tpl = { ...base, header_type: 'IMAGE', header_media_url: 'https://r2/x.jpeg' };
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts(tpl));
  assert.equal(r.sent, 'template');
  assert.deepEqual(sent[0].components, [
    { type: 'header', parameters: [{ type: 'image', image: { link: 'https://r2/x.jpeg' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }
  ]);
  assert.equal(messages[0].type, 'image');
  assert.equal(messages[0].media_url, 'https://r2/x.jpeg');
  assert.equal(messages[0].content, 'Hi Asha');
});

test('VIDEO and DOCUMENT headers are recorded as video / document messages', async () => {
  await sendWindowAwareMessage(business, closedCustomer(), opts({ ...base, header_type: 'VIDEO', header_media_url: 'https://r2/x.mp4' }));
  await sendWindowAwareMessage(business, closedCustomer(), opts({ ...base, header_type: 'DOCUMENT', header_media_url: 'https://r2/x.pdf', header_media_filename: 'Fees.pdf' }));
  assert.deepEqual(messages.map(m => [m.type, m.media_url]), [['video', 'https://r2/x.mp4'], ['document', 'https://r2/x.pdf']]);
  assert.deepEqual(sent[1].components[0], { type: 'header', parameters: [{ type: 'document', document: { link: 'https://r2/x.pdf', filename: 'Fees.pdf' } }] });
});

test('buttons: URL and phone labels are appended to the chat text; only the dynamic URL gets a component', async () => {
  const tpl = {
    ...base, header_type: 'TEXT',
    meta_components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
      { type: 'BODY', text: 'Hi {{1}}' },
      { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call us', phone_number: '+91' }, { type: 'URL', text: 'Pay now', url: 'https://x.com/{{1}}' }] }
    ]
  };
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts(tpl, { templateHeader: ['Asha'], templateButtons: { 1: 'SG-1042' } }));
  assert.equal(r.sent, 'template');
  assert.deepEqual(sent[0].components, [
    { type: 'header', parameters: [{ type: 'text', text: 'Asha' }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'SG-1042' }] }
  ]);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].content, 'Hi Asha\n\n[Call us]\n[Pay now]');
  assert.equal(messages[0].media_url, undefined);
});

test('a plain body-only template is recorded exactly as before (text, no media_url, no labels)', async () => {
  await sendWindowAwareMessage(business, closedCustomer(), opts({ ...base, header_type: 'NONE' }));
  assert.deepEqual(sent[0].components, [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }]);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].content, 'Hi Asha');
  assert.equal('media_url' in messages[0], false);
});

test('send-time re-check: a media template whose media is gone is not sent and not charged, even if send_support says ok', async () => {
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts({ ...base, header_type: 'VIDEO', header_media_url: null }));
  assert.deepEqual(r, { sent: false, code: 'no_template' });
  assert.equal(sent.length + wallet.length + messages.length, 0);
});

test('send-time re-check: a template that gained a quick-reply button is not sent', async () => {
  const tpl = { ...base, header_type: 'NONE', meta_components: [{ type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }] };
  assert.deepEqual(await sendWindowAwareMessage(business, closedCustomer(), opts(tpl)), { sent: false, code: 'no_template' });
  assert.equal(sent.length + wallet.length, 0);
});
