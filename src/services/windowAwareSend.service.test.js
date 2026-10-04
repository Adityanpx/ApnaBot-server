// Run: node --test src/services/windowAwareSend.service.test.js
// sendWindowAwareMessage against in-memory stand-ins for Supabase, the
// wallet, the rate card and WhatsApp — nothing is written or sent.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let messages; let sent; let wallet; let billing; let balance; let metaRejects; let refundFails;

const reset = () => {
  messages = []; sent = []; wallet = []; billing = true; balance = 1000; metaRejects = false; refundFails = false;
};

const from = (table) => {
  let payload;
  const q = {
    insert: (p) => { payload = p; return q; },
    select: () => q,
    single: async () => {
      const row = { id: `m${messages.length + 1}`, created_at: '2026-10-03T00:00:00Z', ...payload };
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
stub('../config/env', { get WALLET_BILLING_ENABLED() { return billing; } });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./rateCard.service', { getRateForMessage: async (country, category) => (category === 'utility' ? 12 : 80) });
stub('./wallet.service', {
  debitWallet: async (b, amt, ref, notes) => {
    if (amt > balance) throw new Error('Insufficient wallet balance');
    balance -= amt; wallet.push({ type: 'debit', amt, ref, notes });
  },
  refundToWallet: async (b, amt, ref, notes) => {
    if (refundFails) throw new Error('db down');
    balance += amt; wallet.push({ type: 'refund', amt, ref, notes });
  }
});
stub('./whatsapp.service', {
  sendTemplateMessage: async (pn, tok, to, name, lang, components) => {
    if (metaRejects) throw new Error('(#131026) Message undeliverable');
    sent.push({ via: 'template', to, name, lang, params: (components[0] ? components[0].parameters : []).map(p => p.text) });
  }
});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => sent.push({ via: 'text', to: job.to, text: job.message, messageId: job.messageId }) });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });

const { sendWindowAwareMessage, recordOutbound, isWindowOpen } = require('./windowAwareSend.service');

const business = { id: 'b', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' };
const customer = (over = {}) => ({
  id: 'c1', business_id: 'b', whatsapp_number: '919800000001', is_blocked: false, preferred_language: 'hi',
  last_message_at: new Date(Date.now() - HOUR).toISOString(), ...over
});
const approved = { name: 'apnabot_followup', language: 'en_US', category: 'UTILITY', status: 'approved' };
const opts = (over = {}) => ({
  textFor: (lang) => `text in ${lang}`,
  template: approved,
  templateParams: ['Asha', 'BK1'],
  templateText: 'Hi Asha, about BK1',
  billing: { referenceId: 'ref-1', notes: 'Follow-up message', refundNotes: 'Refund: follow-up not sent' },
  ...over
});

test('window open: free-form text in the customer\'s language, recorded in the chat, no charge', async () => {
  reset();
  const r = await sendWindowAwareMessage(business, customer(), opts());
  assert.deepEqual(r, { sent: 'text', messageId: 'm1', costPaise: 0 });
  assert.deepEqual(sent, [{ via: 'text', to: '919800000001', text: 'text in hi', messageId: 'm1' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].customer_id, 'c1');
  assert.equal(messages[0].customer_number, '919800000001');
  assert.equal(messages[0].sender_type, 'bot');
  assert.equal(wallet.length, 0);
});

test('window open: a template loader is never called', async () => {
  reset();
  let loaded = false;
  const r = await sendWindowAwareMessage(business, customer(), opts({ template: async () => { loaded = true; return approved; } }));
  assert.equal(r.sent, 'text');
  assert.equal(loaded, false);
});

test('window closed + approved template: template sent, wallet debited at the category rate', async () => {
  reset();
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() }), opts());
  assert.deepEqual(r, { sent: 'template', messageId: 'm1', costPaise: 12 });
  assert.equal(r.messageId, messages[0].id); // the chat row for the template
  assert.deepEqual(sent, [{ via: 'template', to: '919800000001', name: 'apnabot_followup', lang: 'en_US', params: ['Asha', 'BK1'] }]);
  assert.deepEqual(wallet, [{ type: 'debit', amt: 12, ref: 'ref-1', notes: 'Follow-up message' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Hi Asha, about BK1');
});

test('window closed, billing off: template sent with no wallet transaction', async () => {
  reset(); billing = false;
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: null }), opts({ template: async () => approved }));
  assert.equal(r.sent, 'template');
  assert.equal(typeof r.messageId, 'string');
  assert.equal(r.costPaise, 0); // nothing debited
  assert.equal(wallet.length, 0);
});

test('window closed, no approved template: not sent, nothing charged', async () => {
  reset();
  const closed = customer({ last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() });
  assert.deepEqual(await sendWindowAwareMessage(business, closed, opts({ template: null })), { sent: false, code: 'no_template' });
  assert.deepEqual(await sendWindowAwareMessage(business, closed, opts({ template: { ...approved, status: 'pending' } })), { sent: false, code: 'no_template' });
  assert.deepEqual(await sendWindowAwareMessage(business, closed, opts({ template: { ...approved, status: 'paused' } })), { sent: false, code: 'no_template' });
  assert.deepEqual(await sendWindowAwareMessage(business, closed, opts({ template: { ...approved, status: 'disabled' } })), { sent: false, code: 'no_template' });
  assert.equal(sent.length + wallet.length + messages.length, 0);
});

test('low wallet balance: not sent, nothing recorded', async () => {
  reset(); balance = 5;
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: null }), opts());
  assert.deepEqual(r, { sent: false, code: 'low_balance' });
  assert.equal(sent.length + wallet.length + messages.length, 0);
  assert.equal(balance, 5);
});

test('WhatsApp rejects the template: debit refunded, nothing recorded in the chat', async () => {
  reset(); metaRejects = true;
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: null }), opts());
  assert.deepEqual(r, { sent: false, code: 'rejected' });
  assert.deepEqual(wallet.map(w => [w.type, w.amt, w.ref, w.notes]), [
    ['debit', 12, 'ref-1', 'Follow-up message'],
    ['refund', 12, 'ref-1', 'Refund: follow-up not sent']
  ]);
  assert.equal(balance, 1000);
  assert.equal(messages.length, 0);
});

test('WhatsApp rejects and the refund fails: still reported as rejected (refund failure only logged)', async () => {
  reset(); metaRejects = true; refundFails = true;
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: null }), opts());
  assert.deepEqual(r, { sent: false, code: 'rejected' });
});

test('blocked customer: nothing sent or charged, even with the window open', async () => {
  reset();
  const r = await sendWindowAwareMessage(business, customer({ is_blocked: true }), opts());
  assert.deepEqual(r, { sent: false, code: 'blocked' });
  assert.equal(sent.length + wallet.length + messages.length, 0);
});

test('WhatsApp not connected: nothing sent', async () => {
  reset();
  assert.deepEqual(await sendWindowAwareMessage({ ...business, isWhatsappConnected: false }, customer(), opts()), { sent: false, code: 'not_connected' });
  assert.deepEqual(await sendWindowAwareMessage({ ...business, phoneNumberId: null }, customer(), opts()), { sent: false, code: 'not_connected' });
  assert.equal(sent.length + wallet.length + messages.length, 0);
});

test('does not check opt-in / opt-out / bot pause — callers do', async () => {
  reset();
  const r = await sendWindowAwareMessage(business, customer({
    opted_in: false, opted_out_at: new Date().toISOString(), bot_paused_until: new Date(Date.now() + HOUR).toISOString()
  }), opts());
  assert.equal(r.sent, 'text');
});

test('recordOutbound: bot text message from the customer row', async () => {
  reset();
  const m = await recordOutbound(business, customer(), 'hello', 'sent');
  assert.equal(m.customerNumber, '919800000001');
  assert.equal(m.direction, 'outbound');
  assert.equal(m.isRead, true);
});

test('template without variables: no body component sent', async () => {
  reset();
  const r = await sendWindowAwareMessage(business, customer({ last_message_at: null }), opts({ templateParams: [], templateText: 'Hello again!' }));
  assert.equal(r.sent, 'template');
  assert.deepEqual(sent[0].params, []);
});

test('isWindowOpen: open under 24h after the last inbound, closed after or with none', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  assert.equal(isWindowOpen({ last_message_at: '2026-10-02T12:00:01Z' }, now), true);
  assert.equal(isWindowOpen({ last_message_at: '2026-10-02T12:00:00Z' }, now), false);
  assert.equal(isWindowOpen({ last_message_at: null }, now), false);
});
