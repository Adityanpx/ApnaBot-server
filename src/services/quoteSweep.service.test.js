// Run: node --test src/services/quoteSweep.service.test.js
// The travel quote sweep (reminder, expiry, overdue advance) with a fake clock: `now` is passed in, so each
// threshold is tested just before and just after. In-memory Supabase; the sender, the business lookup and the
// owner notification are recorders.
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);

const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const state = { sends: [], pushes: [], businesses: {}, sendResult: null };
const HOUR = 3600 * 1000;
stub('./business.service', { getBusinessById: async (id) => state.businesses[id] || null });
stub('./notification.service', { notify: (businessId, type, payload) => { state.pushes.push({ businessId, type, payload }); } });
stub('./windowAwareSend.service', {
  isConnected: (b) => !!(b.isWhatsappConnected && b.phoneNumberId),
  // the real rule: free text only inside 24 hours of the customer's last message
  isWindowOpen: (customerRow, nowMs = Date.now()) => !!(customerRow.last_message_at && nowMs < new Date(customerRow.last_message_at).getTime() + 24 * HOUR),
  sendWindowAwareMessage: async (business, customer, opts) => {
    if (state.throwNext) { state.throwNext = false; throw new Error('queue down'); }
    state.sends.push({ businessId: business.id, customerId: customer.id, text: opts.textFor(customer.preferred_language || null), template: opts.template });
    return state.sendResult || { sent: 'text', messageId: 'm1', costPaise: 0 };
  }
});

const sweep = require('./quoteSweep.service');
const { B1, B2, uuid } = h;

const NOW = new Date('2026-11-10T12:00:00.000Z');
const at = (hoursFromNow) => new Date(NOW.getTime() + hoursFromNow * HOUR);
const iso = (d) => d.toISOString();

let db;
test.beforeEach(() => {
  h.reset();
  h.state.fake = createFakeSupabase();
  db = h.state.fake.db;
  Object.assign(state, { sends: [], pushes: [], sendResult: null });
  state.businesses = {
    [B1]: { id: B1, isActive: true, isWhatsappConnected: true, phoneNumberId: 'pn1' },
    [B2]: { id: B2, isActive: true, isWhatsappConnected: true, phoneNumberId: 'pn2' }
  };
  db.customers = [
    { id: uuid(1), business_id: B1, name: 'Asha', whatsapp_number: '919000000001', preferred_language: 'hi', last_message_at: iso(at(-1)), is_blocked: false, opted_out_at: null, bot_paused_until: null },
    { id: uuid(2), business_id: B2, name: 'Ravi', whatsapp_number: '919000000002', preferred_language: 'en', last_message_at: iso(at(-1)), is_blocked: false, opted_out_at: null, bot_paused_until: null }
  ];
  db.travel_quote_settings = [];
  db.travel_quotes = [];
  db.bookings = [];
});

let n = 0;
const quote = (over = {}) => {
  const sentAt = over.sentAt || at(-4);
  const row = {
    id: `q-${++n}`, business_id: B1, customer_id: uuid(1), booking_id: null, status: 'sent', trip_type: 'oneway',
    from_city: 'pune', to_city: 'mumbai', base_fare: 2500, extras: [], total_amount: 2500, advance_amount: 500,
    collected: { fromLabel: 'Pune', toLabel: 'Mumbai' },
    sent_at: iso(sentAt), expires_at: iso(new Date(sentAt.getTime() + 24 * HOUR)),
    reminder_sent_at: null, accepted_at: null, overdue_notified_at: null, paid_at: null, customer_paid_claim_at: null,
    ...over
  };
  delete row.sentAt;
  db.travel_quotes.push(row);
  return row;
};
const accepted = (hoursAgo, over = {}) => {
  const booking = { id: `bk-${++n}`, business_id: B1, status: 'pending', payment_status: 'pending', ...(over.booking || {}) };
  db.bookings.push(booking);
  return quote({ status: 'accepted', accepted_at: iso(at(-hoursAgo)), sentAt: at(-hoursAgo - 1), booking_id: booking.id, ...over, booking: undefined });
};
const run = (when = NOW, opts = {}) => sweep.runSweep({ now: when, ...opts });
const find = (id) => db.travel_quotes.find((q) => q.id === id);

// ── Reminder ────────────────────────────────────────────────────────────────────────────────────

test('reminder: not before reminder_after_hours (default 3), sent from that moment, in the customer\'s language, plain text', async () => {
  const q = quote({ sentAt: NOW });
  await run(new Date(NOW.getTime() + 3 * HOUR - 60000));
  assert.equal(state.sends.length, 0);
  assert.equal(find(q.id).reminder_sent_at, null);

  const out = await run(new Date(NOW.getTime() + 3 * HOUR));
  assert.equal(out.remindersSent, 1);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].template, null, 'plain text only - no template to fall back to');
  assert.equal(state.sends[0].customerId, uuid(1));
  assert.ok(state.sends[0].text.includes('Pune → Mumbai') && state.sends[0].text.includes('₹2,500'));
  assert.ok(state.sends[0].text.includes('पुष्टि व भुगतान'), 'hi customer: Hindi text naming the Hindi button');
  assert.ok(find(q.id).reminder_sent_at);
  assert.equal(find(q.id).status, 'sent');
});

test('reminder: sent once - a later pass does nothing', async () => {
  quote({ sentAt: at(-4) });
  await run();
  await run(at(1));
  assert.equal(state.sends.length, 1);
});

test('reminder: two overlapping runs send it once (the claim)', async () => {
  quote({ sentAt: at(-4) });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(state.sends.length, 1);
  assert.equal(a.remindersSent + b.remindersSent, 1);
});

test('reminder: the business\'s own reminder_after_hours; defaults (3) when it has no settings row', async () => {
  db.travel_quote_settings = [{ business_id: B2, valid_hours: 48, reminder_after_hours: 6 }];
  const own = quote({ business_id: B2, customer_id: uuid(2), sentAt: at(-5), expires_at: iso(at(43)) });
  const dflt = quote({ sentAt: at(-4) });
  await run();
  assert.deepEqual(state.sends.map(s => s.customerId), [uuid(1)], 'B2 waits for its 6 hours');
  assert.equal(find(own.id).reminder_sent_at, null);
  assert.ok(find(dflt.id).reminder_sent_at);
  await run(at(1.5));
  assert.equal(state.sends.length, 2);
});

test('reminder: never when reminder_after_hours is 0, or would fall at/after this quote\'s expiry', async () => {
  db.travel_quote_settings = [{ business_id: B1, valid_hours: 24, reminder_after_hours: 0 }];
  quote({ sentAt: at(-10) });
  await run();
  assert.equal(state.sends.length, 0);

  db.travel_quote_settings = [{ business_id: B1, valid_hours: 24, reminder_after_hours: 3 }];
  db.travel_quotes = [];
  quote({ sentAt: at(-4), expires_at: iso(at(-1)) }); // expired already
  quote({ sentAt: at(-4), expires_at: iso(at(-4 + 3)) }); // short quote: its expiry is exactly the reminder time
  const short = quote({ sentAt: at(-4), expires_at: iso(at(-4 + 2)) }); // expires 2h after sending, reminder due at 3h
  db.travel_quotes.forEach(q => { if (q !== short) q.reminder_sent_at = null; });
  await run();
  assert.equal(state.sends.length, 0);
});

test('reminder: only status sent - never a handoff lead, accepted, paid, expired or cancelled quote', async () => {
  for (const status of ['handoff', 'accepted', 'paid', 'expired', 'cancelled']) quote({ status, sentAt: at(-4) });
  await run();
  assert.equal(state.sends.length, 0);
});

test('reminder: window closed (customer\'s last message over 24 h ago) sends nothing and says nothing', async () => {
  db.customers[0].last_message_at = iso(at(-24.5));
  const q = quote({ sentAt: at(-4) });
  const out = await run();
  assert.equal(state.sends.length, 0);
  assert.equal(out.reminderSkipped.window_closed, 1);
  assert.equal(out.errors, 0);
  assert.equal(find(q.id).status, 'sent');
  // just inside the window it goes
  db.customers[0].last_message_at = iso(at(-23.5));
  await run();
  assert.equal(state.sends.length, 1);
});

test('reminder: a blocked, opted-out or bot-paused customer, or a disconnected / inactive business, is skipped', async () => {
  quote({ sentAt: at(-4) });
  db.customers[0].is_blocked = true; await run(); db.customers[0].is_blocked = false;
  db.customers[0].opted_out_at = iso(at(-9)); await run(); db.customers[0].opted_out_at = null;
  db.customers[0].bot_paused_until = iso(at(5)); await run(); db.customers[0].bot_paused_until = null;
  state.businesses[B1].isWhatsappConnected = false; await run(); state.businesses[B1].isWhatsappConnected = true;
  state.businesses[B1].isActive = false; await run(); state.businesses[B1].isActive = true;
  assert.equal(state.sends.length, 0);
  await run();
  assert.equal(state.sends.length, 1, 'and it still goes once they are fine again');
});

test('reminder: works after the travel_quotes switch was turned off', async () => {
  db.business_features = [{ business_id: B1, feature: 'travel_quotes', is_enabled: false }];
  db.category_features = [{ category: 'travels', feature: 'travel_quotes', is_enabled: false }];
  quote({ sentAt: at(-4) });
  await run();
  assert.equal(state.sends.length, 1);
});

test('reminder: the send failing still leaves the claim (never retried)', async () => {
  state.sendResult = { sent: false, code: 'rejected' };
  const q = quote({ sentAt: at(-4) });
  const out = await run();
  assert.equal(out.remindersSent, 0);
  assert.equal(out.reminderSkipped.send_rejected, 1);
  assert.ok(find(q.id).reminder_sent_at);
  state.sendResult = null;
  await run(at(1));
  assert.equal(state.sends.length, 1);
});

// ── Expiry ──────────────────────────────────────────────────────────────────────────────────────

test('expiry: a sent quote becomes expired exactly at expires_at, not before', async () => {
  const q = quote({ sentAt: at(-24), expires_at: iso(at(0)) });
  await run(new Date(NOW.getTime() - 1000));
  assert.equal(find(q.id).status, 'sent');
  const out = await run(NOW);
  assert.equal(find(q.id).status, 'expired');
  assert.equal(out.expired, 1);
});

test('expiry: only sent quotes - accepted, paid, handoff and cancelled stay as they are; the customer is told nothing', async () => {
  const rows = {};
  for (const status of ['accepted', 'paid', 'handoff', 'cancelled']) rows[status] = quote({ status, sentAt: at(-30), expires_at: iso(at(-6)), reminder_sent_at: iso(at(-20)) });
  const sent = quote({ sentAt: at(-30), expires_at: iso(at(-6)), reminder_sent_at: iso(at(-20)) });
  const out = await run();
  assert.equal(out.expired, 1);
  assert.equal(find(sent.id).status, 'expired');
  for (const status of Object.keys(rows)) assert.equal(find(rows[status].id).status, status);
  assert.equal(state.sends.length, 0);
});

test('expiry: also for a business whose WhatsApp is disconnected or whose switch is off', async () => {
  state.businesses[B1].isWhatsappConnected = false;
  db.business_features = [{ business_id: B1, feature: 'travel_quotes', is_enabled: false }];
  const q = quote({ sentAt: at(-30), expires_at: iso(at(-6)), reminder_sent_at: iso(at(-20)) });
  await run();
  assert.equal(find(q.id).status, 'expired');
});

test('expiry runs before the reminder: an expired quote is never reminded', async () => {
  quote({ sentAt: at(-30), expires_at: iso(at(-6)) });
  await run();
  assert.equal(state.sends.length, 0);
});

// ── Overdue advance ─────────────────────────────────────────────────────────────────────────────

test('overdue: not before accepted_at + valid_hours (default 24), then the owner is told once, with the amount', async () => {
  const q = accepted(23.9);
  await run();
  assert.equal(state.pushes.length, 0);
  const late = accepted(24);
  const out = await run();
  assert.equal(out.overdueNotified, 1);
  assert.equal(state.pushes.length, 1);
  assert.deepEqual(state.pushes[0], {
    businessId: B1, type: 'quote_advance_overdue',
    payload: { bookingId: late.booking_id, customerId: uuid(1), customerName: 'Asha', customerNumber: '919000000001', amount: 500 }
  });
  assert.ok(find(late.id).overdue_notified_at);
  assert.equal(find(q.id).overdue_notified_at ?? null, null);
  await run(at(2));
  assert.equal(state.pushes.length, 2, 'the first quote (now 25.9 h) is told once; the second is not told again');
  await run(at(3));
  assert.equal(state.pushes.length, 2);
});

test('overdue: two overlapping runs tell the owner once (the claim)', async () => {
  accepted(30);
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(state.pushes.length, 1);
  assert.equal(a.overdueNotified + b.overdueNotified, 1);
});

test('overdue: the business\'s own valid_hours decides', async () => {
  db.travel_quote_settings = [{ business_id: B1, valid_hours: 48, reminder_after_hours: 3 }];
  const q = accepted(30);
  await run();
  assert.equal(state.pushes.length, 0);
  await run(at(18));
  assert.equal(state.pushes.length, 1);
  assert.ok(find(q.id).overdue_notified_at);
});

test('overdue: never changes the booking or the quote status, never cancels', async () => {
  const q = accepted(40);
  const before = JSON.stringify(db.bookings);
  await run();
  assert.equal(JSON.stringify(db.bookings), before);
  assert.equal(find(q.id).status, 'accepted');
});

test('overdue: a quote paid before the deadline (status paid, or the booking already paid) is left alone', async () => {
  quote({ status: 'paid', accepted_at: iso(at(-40)), paid_at: iso(at(-30)), sentAt: at(-41) });
  accepted(40, { booking: { payment_status: 'paid' } }); // status not yet synced: the booking says paid
  const out = await run();
  assert.equal(state.pushes.length, 0);
  assert.equal(out.overdueSkipped.not_pending, 1);
});

test('overdue: a cancelled booking is skipped (no alert, booking untouched)', async () => {
  const q = accepted(40, { booking: { status: 'cancelled' } });
  const out = await run();
  assert.equal(state.pushes.length, 0);
  assert.equal(out.overdueSkipped.booking_cancelled, 1);
  assert.equal(find(q.id).overdue_notified_at ?? null, null);
  assert.equal(db.bookings.find(b => b.id === q.booking_id).status, 'cancelled');
});

test('overdue: no advance asked, no booking, or accepted long ago (30 days) - no alert', async () => {
  accepted(40, { advance_amount: null });
  quote({ status: 'accepted', accepted_at: iso(at(-40)), sentAt: at(-41), booking_id: null });
  accepted(31 * 24);
  await run();
  assert.equal(state.pushes.length, 0);
});

test('overdue: also after the switch was turned off; skipped when the business is gone or inactive', async () => {
  db.business_features = [{ business_id: B1, feature: 'travel_quotes', is_enabled: false }];
  accepted(30);
  await run();
  assert.equal(state.pushes.length, 1);
  state.businesses[B1].isActive = false;
  accepted(30);
  await run();
  assert.equal(state.pushes.length, 1);
});

// ── Errors and the loop ─────────────────────────────────────────────────────────────────────────

test('one part failing does not stop the others, and the pass never rejects', async () => {
  quote({ sentAt: at(-30), expires_at: iso(at(-6)) });
  accepted(30);
  const supabase = require('../config/supabase');
  const original = supabase.from;
  supabase.from = (table) => {
    if (table !== 'travel_quote_settings') return original(table);
    const q = { select: () => q, in: () => q, then: (resolve) => resolve({ data: null, error: { message: 'settings down' } }) };
    return q;
  };
  try {
    quote({ sentAt: at(-4) });
    const out = await run();
    assert.equal(out.expired, 1, 'expiry still ran');
    assert.ok(out.errors >= 2, 'reminders and overdue both failed on the settings read');
  } finally { supabase.from = original; }
});

test('one bad quote does not stop the next', async () => {
  db.customers[0].last_message_at = iso(at(-1));
  quote({ sentAt: at(-4), customer_id: uuid(404) }); // customer gone
  const ok = quote({ sentAt: at(-5) });
  const out = await run();
  assert.equal(out.reminderSkipped.customer_gone, 1);
  assert.equal(state.sends.length, 1);
  assert.ok(find(ok.id).reminder_sent_at);
});

test('a sender that throws is counted, logged, and the next quote still goes', async () => {
  quote({ sentAt: at(-4) });
  quote({ sentAt: at(-5) });
  state.throwNext = true;
  const out = await run();
  assert.equal(out.errors, 1);
  assert.equal(out.remindersSent, 1);
});

test('runSweepSafely returns the summary, and never rejects even when everything fails', async () => {
  const ok = await sweep.runSweepSafely({ now: NOW });
  assert.equal(ok.errors, 0);
  const supabase = require('../config/supabase');
  const original = supabase.from;
  supabase.from = () => { throw new Error('database gone'); };
  try {
    const out = await sweep.runSweepSafely({ now: NOW });
    assert.ok(out === null || out.errors >= 3);
  } finally { supabase.from = original; }
});

test('a pass that runs out of time stops cleanly and sends nothing more', async () => {
  quote({ sentAt: at(-4) });
  const out = await run(NOW, { budgetMs: -1 });
  assert.equal(out.budgetStopped, true);
  assert.equal(state.sends.length, 0);
});

test('nothing to do is a quiet pass', async () => {
  const out = await run();
  assert.deepEqual([out.expired, out.remindersSent, out.overdueNotified, out.errors], [0, 0, 0, 0]);
});

// ── The loop in server.js ───────────────────────────────────────────────────────────────────────

test('server.js: the quote sweep runs inside the follow-up loop, after the follow-ups, in its own try', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const loop = src.slice(src.indexOf('const runFollowupSweep'), src.indexOf('setTimeout(() => {\n    runFollowupSweep()'));
  assert.ok(loop.length > 100, 'found the loop');
  const follow = loop.indexOf('followupSweepService.runSweep()');
  const quotes = loop.indexOf('quoteSweepService.runSweepSafely()');
  assert.ok(follow > -1 && quotes > follow, 'follow-ups first, then the quote sweep');
  assert.match(loop.slice(follow, quotes), /\} catch \(err\) \{\s*logger\.error\('Follow-up sweep failed:', err\);\s*\}/, 'the follow-up sweep has its own catch before the quote sweep');
  assert.match(loop.slice(quotes), /^quoteSweepService\.runSweepSafely\(\);\s*\} finally \{\s*followupSweepRunning = false;/, 'the running flag is always cleared');
  assert.ok(src.includes('if (config.ENABLE_FOLLOWUP_SWEEPER) {'), 'under the same switch');
});
