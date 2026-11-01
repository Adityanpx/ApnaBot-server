// Run: node --test src/controllers/flowGraphPreview.quote.test.js
// The canvas "Test" simulator never runs the quote step (it would price and save a real quote and may raise
// a handoff): it answers "Quote step (not simulated)" and ends the simulated conversation. Other results
// are unchanged. The booking engine is stubbed; no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let advanceImpl;
stub('../config/env', { META_APP_SECRET: 's', FRONTEND_URL: 'https://app.test', STATUS_RETRY_DELAY_MS: 30 });
stub('../config/supabase', { from: () => { throw new Error('no database in this test'); }, rpc: async () => ({ data: null, error: null }) });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', { get: async () => null, set: async () => 'OK', del: async () => 0, incr: async () => 1, expire: async () => 1 });
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {}, addToWhatsappQueueAndWait: async () => {} });
stub('../queues/handoffReminder.queue', { scheduleHandoffReminder: async () => {}, cancelHandoffReminder: async () => {} });
stub('../queues/sessionTimeout.queue', { scheduleSessionTimeout: async () => {}, cancelSessionTimeout: async () => {} });
stub('../services/socket.service', { emitToBusiness: () => {} });
stub('../services/broadcastProgress.service', { notifyBroadcastProgress: () => {} });
stub('../services/tenant.service', { invalidateTenantCache: async () => {}, resolveBusinessByPhoneNumberId: async () => null });
stub('../services/usage.service', { checkUsageLimit: async () => ({ allowed: true }), recordOutbound: async () => {} });
stub('../services/smartFallback.service', { getSmartFallbackReply: async () => null });
stub('../services/business.service', { getBusinessById: async () => ({ id: 'b1', businessCategory: 'travels', enabledLanguages: ['en'] }) });
stub('../services/booking.service', {
  getBookingSession: async () => null, deleteBookingSession: async () => {}, saveBookingSession: async () => {}, recordBookingLead: async () => {},
  finalizeGraphBooking: async () => { throw new Error('the simulator must never finalize a booking'); },
  buildBookingSummaryBody: () => 'summary', normalizeOption: (o) => o
});
stub('../services/bookingGraph.service', {
  getCurrentNodeField: async () => null,
  advanceGraphSession: async (args) => advanceImpl(args),
  startGraphSession: async () => { throw new Error('unexpected'); },
  startGraphSessionAtNode: async () => { throw new Error('unexpected'); }
});
stub('../services/quoteFlow.service', { handleTap: async () => ({}), handleStaleTap: async () => {}, handleResult: async () => { throw new Error('the simulator must never run the quote step'); } });
stub('../services/chatbot.service', { findMatchingRule: async () => null, resolveTappedEdge: async () => null, getOutgoingEdges: async () => [] });
stub('../services/r2.service', {});
stub('../services/whatsapp.service', {});
stub('../services/handoff.service', { getActiveSettings: async () => null, getSettings: async () => null });

const { previewMessage } = require('./flowGraphPreview.controller');

const call = async (body) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await previewMessage({ body, user: { businessId: 'b1' } }, res, (err) => { throw err; });
  return out;
};
const session = { currentNodeId: 'n', collected: {}, answeredFields: [] };

test('a quote result ends the simulated conversation with "Quote step (not simulated)"', async () => {
  for (const action of ['send', 'no_vehicle', 'handoff']) {
    advanceImpl = async () => ({ session, result: { quote: { action, reason: null } } });
    const { status, body } = await call({ message: '10:00 PM', session });
    assert.equal(status, 200);
    assert.deepEqual(body.data, { replyText: 'Quote step (not simulated)', buttons: [], listOptions: [], session: null }, action);
  }
});

test('other results are unchanged: a re-prompt string and the done summary', async () => {
  advanceImpl = async () => ({ session, result: 'Please choose one of: A, B' });
  let { body } = await call({ message: 'x', session });
  assert.equal(body.data.replyText, 'Please choose one of: A, B');

  advanceImpl = async () => ({ session: { ...session, answeredFields: [] }, result: { done: true, collected: {} } });
  ({ body } = await call({ message: 'x', session }));
  assert.match(body.data.replyText, /This is where a real booking would be created/);
  assert.equal(body.data.session, null);
});
