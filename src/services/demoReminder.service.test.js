// Run: node --test src/services/demoReminder.service.test.js
// setDemoTime / runReminder against in-memory stand-ins for Supabase, the
// queues and WhatsApp — nothing is written or sent.
const test = require('node:test');
const assert = require('node:assert/strict');

const HOUR = 60 * 60 * 1000;
let db; let sent; let scheduled; let removed; let debits; let billing;

const reset = () => {
  db = {
    bookings: [
      { id: 'bk1', business_id: 'b', customer_id: 'c1', customer_number: '911', booking_code: 'BK1', form_key: 'demo', status: 'pending', fields: { studentName: 'Aarav', course: 'Abacus' } },
      { id: 'bk2', business_id: 'b', customer_id: 'c1', customer_number: '911', booking_code: 'BK2', form_key: 'admission', status: 'pending', fields: {} }
    ],
    customers: [{ id: 'c1', business_id: 'b', is_blocked: false, last_message_at: new Date(Date.now() - HOUR).toISOString() }],
    business_bot_settings: [{ business_id: 'b', published_at: '2026-10-01', published_settings: { settings: { demoForm: { enabled: true, fields: [], reminder: '2h' } } } }],
    messages: []
  };
  sent = []; scheduled = []; removed = []; debits = []; billing = false;
};

// Minimal chainable query: eq filters, select/insert/update, maybeSingle/single/await.
const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => db[table].filter(r => filters.every(([c, v]) => r[c] === v));
  const run = () => {
    if (op === 'insert') { const row = { id: `m${db[table].length + 1}`, ...payload }; db[table].push(row); return [row]; }
    if (op === 'update') { const hit = rows(); hit.forEach(r => Object.assign(r, payload)); return hit; }
    return rows();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: { ...run()[0] }, error: null }),
    then: (resolve) => resolve({ data: run(), error: null })
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../config/env', { get WALLET_BILLING_ENABLED() { return billing; } });
stub('./business.service', { getBusinessById: async () => ({ id: 'b', name: 'Bright Minds', isWhatsappConnected: true, phoneNumberId: 'pn', accessToken: 'enc' }) });
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./wallet.service', { debitWallet: async (b, amt) => debits.push(amt), refundToWallet: async (b, amt) => debits.push(-amt) });
stub('./rateCard.service', { getRateForMessage: async () => 12 });
stub('./customerPipeline.service', { advancePipelineStage: async () => {} });
stub('./whatsapp.service', { sendTemplateMessage: async (pn, tok, to, name, lang, components) => sent.push({ via: 'template', to, name, params: components[0].parameters.map(p => p.text) }) });
let template = null;
stub('./demoReminderTemplate.service', { getReminderTemplate: async () => template });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => sent.push({ via: 'text', to: job.to, text: job.message }) });
stub('../queues/demoReminder.queue', {
  scheduleDemoReminder: async (data, at) => scheduled.push({ data, at: new Date(at).toISOString() }),
  removeDemoReminder: async (id) => removed.push(id)
});
const { setDemoTime, runReminder } = require('./demoReminder.service');

const inDays = (d) => new Date(Date.now() + d * 24 * HOUR).toISOString();

test('fixing a demo: saved as "Demo fixed", parent told as text, reminder planned 2h before', async () => {
  reset();
  const at = inDays(3);
  const r = await setDemoTime('b', 'bk1', at);
  assert.equal(r.booking.status, 'confirmed');
  assert.equal(r.booking.scheduledFor, at);
  assert.equal(r.booking.reminderStatus, 'scheduled');
  assert.deepEqual(r.confirmation, { sent: 'text' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^✅ Aarav's free demo class for Abacus is fixed for /);
  assert.equal(db.messages.length, 1);
  assert.equal(scheduled[0].at, new Date(new Date(at).getTime() - 2 * HOUR).toISOString());
  assert.deepEqual(scheduled[0].data, { bookingId: 'bk1', businessId: 'b', scheduledFor: at });
});

test('refused: not a demo request, past time, closed request, bad input', async () => {
  reset();
  assert.equal((await setDemoTime('b', 'bk2', inDays(1))).status, 400);
  assert.equal((await setDemoTime('b', 'bk1', inDays(-1))).status, 400);
  assert.equal((await setDemoTime('b', 'bk1', inDays(100))).status, 400);
  assert.equal((await setDemoTime('b', 'bk1', 'tomorrow')).status, 400);
  assert.equal((await setDemoTime('b', 'nope', inDays(1))).status, 404);
  db.bookings[0].status = 'cancelled';
  assert.equal((await setDemoTime('b', 'bk1', inDays(1))).status, 400);
  assert.equal(sent.length, 0);
});

test('reminder off, or too late for one: no job, old job dropped', async () => {
  reset();
  db.business_bot_settings[0].published_settings.settings.demoForm.reminder = 'off';
  let r = await setDemoTime('b', 'bk1', inDays(1));
  assert.deepEqual(r.reminder, { off: true });
  assert.equal(r.booking.reminderStatus, null);
  db.business_bot_settings[0].published_settings.settings.demoForm.reminder = '2h';
  r = await setDemoTime('b', 'bk1', new Date(Date.now() + HOUR).toISOString());
  assert.deepEqual(r.reminder, { tooLate: true });
  assert.equal(scheduled.length, 0);
  assert.deepEqual(removed, ['bk1', 'bk1']);
});

test('window closed: approved template (wallet-charged), else not sent with a reason', async () => {
  reset();
  db.customers[0].last_message_at = new Date(Date.now() - 30 * HOUR).toISOString();
  template = null;
  let r = await setDemoTime('b', 'bk1', inDays(2));
  assert.equal(r.confirmation.sent, false);
  assert.match(r.confirmation.reason, /hasn't approved/);
  assert.equal(sent.length, 0);

  template = { name: 'apnabot_demo_class', language: 'en_US', category: 'UTILITY', status: 'approved' };
  billing = true;
  r = await setDemoTime('b', 'bk1', inDays(2));
  assert.deepEqual(r.confirmation, { sent: 'template' });
  assert.equal(sent[0].name, 'apnabot_demo_class');
  assert.deepEqual(sent[0].params.slice(0, 3), ['Aarav', 'Abacus', 'Bright Minds']);
  assert.deepEqual(debits, [12]);
  assert.match(db.messages[0].content, /^Hi! Aarav's free demo class/);
  template = null;
});

test('reminder job: sends, and does nothing when stale / closed / switched off', async () => {
  reset();
  const at = inDays(1);
  await setDemoTime('b', 'bk1', at);
  sent = [];

  assert.equal(await runReminder({ bookingId: 'bk1', businessId: 'b', scheduledFor: inDays(2) }), 'stale');
  assert.equal(sent.length, 0);

  assert.equal(await runReminder({ bookingId: 'bk1', businessId: 'b', scheduledFor: at }), 'sent');
  assert.match(sent[0].text, /^⏰ Reminder: Aarav's free demo class for Abacus at Bright Minds is on /);
  assert.equal(db.bookings[0].reminder_status, 'sent');

  db.business_bot_settings[0].published_settings.settings.demoForm.reminder = 'off';
  assert.equal(await runReminder({ bookingId: 'bk1', businessId: 'b', scheduledFor: at }), 'off');
  assert.equal(db.bookings[0].reminder_status, 'skipped');

  db.bookings[0].status = 'cancelled';
  assert.equal(await runReminder({ bookingId: 'bk1', businessId: 'b', scheduledFor: at }), 'closed');
  assert.equal(db.bookings[0].reminder_note, 'The request was closed.');
  assert.equal(sent.length, 1);
});
