// Run: node --test src/queues/sessionTimeout.worker.test.js
// The session-timeout job: a stale job does nothing; a live one sends the inactivity text (the quote wording for a chat
// in a quote flow, the standard one otherwise) and ends the session. bullmq, Meta and the database are stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

let processor;
const state = { session: null, sent: [], deleted: [], language: 'en', keyword: null, recorded: 0 };
stub('../../node_modules/bullmq', { Worker: class { constructor(_name, fn) { processor = fn; } on() {} } });
stub('../config/env', { QUEUE_NAMESPACE: 'test' });
stub('../config/queueConnection', { workerConnection: {} });
stub('../utils/logger', { info() {}, warn() {}, error() {} });
stub('../services/whatsapp.service', { sendTextMessage: async (...args) => { state.sent.push(args); } });
stub('../services/usage.service', { recordOutbound: () => { state.recorded += 1; } });
stub('../services/booking.service', {
  getBookingSession: async () => state.session,
  deleteBookingSession: async (businessId, number) => { state.deleted.push([businessId, number]); }
});
stub('../config/supabase', {
  from: () => {
    const q = {
      select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: { preferred_language: state.language }, error: null })
    };
    return q;
  }
});
stub('../services/sessionTimeoutText.service', {
  sessionTimeoutText: async (businessId, session, lang) => `TEXT(${businessId},${session.currentNodeId},${lang})`
});

require('./sessionTimeout.worker');

const job = (expectedToken = 't1') => ({ data: { businessId: 'b1', customerNumber: '9190', phoneNumberId: 'pn', encryptedAccessToken: 'tok', expectedToken } });

test.beforeEach(() => Object.assign(state, { session: { currentNodeId: 'n7', timeoutToken: 't1' }, sent: [], deleted: [], language: 'hi', recorded: 0 }));

test('a live session: the text from the session-timeout text service goes to the customer in their language, then the session ends', async () => {
  await processor(job());
  assert.deepEqual(state.sent, [['pn', 'tok', '9190', 'TEXT(b1,n7,hi)']]);
  assert.deepEqual(state.deleted, [['b1', '9190']]);
  assert.equal(state.recorded, 1);
});

test('a stale job (a newer reply rotated the token) or an already-ended session sends nothing', async () => {
  await processor(job('old-token'));
  state.session = null;
  await processor(job());
  assert.deepEqual(state.sent, []);
  assert.deepEqual(state.deleted, []);
});
