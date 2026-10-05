// Run: node --test src/services/windowAwareSend.metaId.test.js
// A template sent outside the 24h window goes straight to Meta (not through the
// queue): the wamid from Meta's response must end up on the chat row, or
// Meta's delivered / read webhooks never find it. Supabase, wallet and
// WhatsApp are in-memory stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let rows; let sendImpl; let failUpdates;

const from = () => {
  const filters = []; let op = 'select'; let payload; let ids = null; let single = false;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `m${rows.length + 1}`, ...payload }; rows.push(row); return { data: row, error: null }; }
    if (op === 'update') {
      if (failUpdates) return { data: null, error: { code: '500', message: 'boom' } };
      const target = match();
      if (payload.meta_message_id !== undefined && rows.some(r => !target.includes(r) && r.business_id === 'b' && r.meta_message_id === payload.meta_message_id)) {
        return { data: null, error: { code: '23505', message: 'dup' } };
      }
      target.forEach(r => Object.assign(r, payload));
      return { data: target, error: null };
    }
    if (op === 'delete') { rows = rows.filter(r => !ids.includes(r.id)); return { data: null, error: null }; }
    return { data: match().map(r => ({ ...r })), error: null };
  };
  const q = {
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    delete: () => { op = 'delete'; return q; },
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { ids = vs; return q; },
    single: async () => run(),
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../config/env', { WALLET_BILLING_ENABLED: false });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./rateCard.service', { getRateForMessage: async () => 0 });
stub('./wallet.service', { debitWallet: async () => {}, refundToWallet: async () => {} });
stub('./whatsapp.service', { sendTemplateMessage: async () => sendImpl() });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { sendWindowAwareMessage } = require('./windowAwareSend.service');

const business = { id: 'b', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' };
const closedCustomer = () => ({ id: 'c1', business_id: 'b', whatsapp_number: '919800000001', is_blocked: false, last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() });
const tpl = { name: 'pay_now', language: 'en_US', category: 'UTILITY', status: 'approved', send_support: 'ok', body_text: 'Hi {{1}}' };
const opts = { textFor: () => 'text', template: tpl, templateParams: ['Asha'], templateText: 'Hi Asha', billing: { referenceId: 'r', notes: 'n', refundNotes: 'rn' } };

test.beforeEach(() => { rows = []; failUpdates = false; sendImpl = () => ({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.TPL1' }] }); });

test('a template sent outside the window: Meta\'s wamid is saved on the chat row', async () => {
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts);
  assert.equal(r.sent, 'template');
  assert.equal(rows[0].meta_message_id, 'wamid.TPL1');
  assert.equal(rows[0].sender_type, 'bot');
});

test('a response without an id leaves the row as before', async () => {
  sendImpl = () => undefined;
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts);
  assert.equal(r.sent, 'template');
  assert.equal(rows[0].meta_message_id, undefined);
});

test('an echo row already holding the wamid is removed; the send result is unchanged', async () => {
  rows.push({ id: 'echo1', business_id: 'b', sender_type: 'phone_app', direction: 'outbound', meta_message_id: 'wamid.TPL1' });
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts);
  assert.equal(r.sent, 'template');
  assert.deepEqual(rows.map(x => x.sender_type), ['bot']);
  assert.equal(rows[0].meta_message_id, 'wamid.TPL1');
});

test('a failure saving the id never fails the send', async () => {
  failUpdates = true;
  const r = await sendWindowAwareMessage(business, closedCustomer(), opts);
  assert.equal(r.sent, 'template');
  assert.equal(rows.length, 1);
});
