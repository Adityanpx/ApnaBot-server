// Run: node --test src/services/windowAwareSend.signals.test.js
// A template Meta refuses still returns { sent: false, code: 'rejected' } and refunds,
// and also tells the delivery signals which business it failed for. Supabase,
// wallet, WhatsApp and the signals are in-memory stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let sendImpl; let signals; let refunds;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', {});
stub('../config/env', { WALLET_BILLING_ENABLED: true });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./rateCard.service', { getRateForMessage: async () => 100 });
stub('./wallet.service', { debitWallet: async () => {}, refundToWallet: async (...a) => { refunds.push(a); } });
stub('./whatsapp.service', { sendTemplateMessage: async () => sendImpl() });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('./deliverySignals.service', { noteSendFailure: async (f) => { signals.push(f); } });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { sendWindowAwareMessage } = require('./windowAwareSend.service');

const business = { id: 'b', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' };
const closedCustomer = { id: 'c1', business_id: 'b', whatsapp_number: '919800000001', is_blocked: false, last_message_at: new Date(Date.now() - 25 * HOUR).toISOString() };
const tpl = { name: 'pay_now', language: 'en_US', category: 'UTILITY', status: 'approved', send_support: 'ok', body_text: 'Hi {{1}}' };
const opts = { textFor: () => 'text', template: tpl, templateParams: ['Asha'], templateText: 'Hi Asha', billing: { referenceId: 'r', notes: 'n', refundNotes: 'rn' } };
const metaReject = (code) => Object.assign(new Error('400'), { response: { data: { error: { code, message: 'm' } } } });

test.beforeEach(() => { signals = []; refunds = []; });

test('a 131042 rejection is reported for the business, and the result and refund are unchanged', async () => {
  sendImpl = () => { throw metaReject(131042); };
  const r = await sendWindowAwareMessage(business, closedCustomer, opts);
  assert.deepEqual(r, { sent: false, code: 'rejected' });
  assert.deepEqual(signals, [{ businessId: 'b', errorCode: 131042, customerId: 'c1' }]);
  assert.equal(refunds.length, 1);
});

test('a rejection without a Meta code is still just rejected', async () => {
  sendImpl = () => { throw new Error('socket hang up'); };
  const r = await sendWindowAwareMessage(business, closedCustomer, opts);
  assert.deepEqual(r, { sent: false, code: 'rejected' });
  assert.deepEqual(signals, [{ businessId: 'b', errorCode: null, customerId: 'c1' }]);
});
