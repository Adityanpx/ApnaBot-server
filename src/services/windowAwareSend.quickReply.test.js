// Run: node --test src/services/windowAwareSend.quickReply.test.js
// #6 Phase 4b: a template with quick-reply buttons is sent by the window-aware
// sender (follow-ups, demo reminders) with the tpl:<id>:<index> payloads, and
// the chat shows the labels.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let messages; let sent;

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
stub('../config/env', { WALLET_BILLING_ENABLED: false });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./rateCard.service', { getRateForMessage: async () => 0 });
stub('./wallet.service', { debitWallet: async () => {}, refundToWallet: async () => {} });
stub('./whatsapp.service', { sendTemplateMessage: async (pn, tok, to, name, lang, components) => { sent.push({ to, name, components }); } });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { sendWindowAwareMessage } = require('./windowAwareSend.service');

const ID = '0b3f6c1e-1111-4222-8333-944455556666';
const business = { id: 'b', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' };
const customer = () => ({ id: 'c1', business_id: 'b', whatsapp_number: '919800000001', is_blocked: false, last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() });
const template = {
  id: ID, name: 'win_back', language: 'en_US', category: 'MARKETING', status: 'approved', send_support: 'ok', header_type: 'NONE', body_text: 'Hi {{1}}',
  meta_components: [{ type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'Stop promotions' }] }]
};

test.beforeEach(() => { messages = []; sent = []; });

test('quick-reply template: body + payload components sent; chat shows the button labels', async () => {
  const r = await sendWindowAwareMessage(business, customer(), {
    textFor: () => 'text', template, templateParams: ['Asha'], templateText: 'Hi Asha', billing: { referenceId: 'r', notes: 'n', refundNotes: 'rn' }
  });
  assert.equal(r.sent, 'template');
  assert.deepEqual(sent[0].components, [
    { type: 'body', parameters: [{ type: 'text', text: 'Asha' }] },
    { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `tpl:${ID}:0` }] },
    { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `tpl:${ID}:1` }] }
  ]);
  assert.equal(messages[0].content, 'Hi Asha\n\n[Yes]\n[Stop promotions]');
});
