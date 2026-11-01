// Run: node --test src/services/quoteFlow.service.test.js
// The WhatsApp side of a travel quote: pricing + saving + sending the quote, Confirm (one booking per
// quote, however many taps), "I've paid", Change, Talk to us, and the engine's handoffs. In-memory
// Supabase (real filtering / unique index); the queue, notifications, handoff and payment are stubs.
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);

const stub = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const state = { jobs: [], pushes: [], deleted: [], raised: 0, claimed: true, handoffSettings: null, pipeline: [], business: null, graph: null };
stub('../queues/whatsapp.queue', { addToWhatsappQueueAndWait: async (job) => { state.jobs.push(job); }, addToWhatsappQueue: async (job) => { state.jobs.push(job); } });
stub('./socket.service', { emitToBusiness: () => {} });
stub('./business.service', { getBusinessById: async () => state.business });
stub('./booking.service', {
  normalizeTripType: (v) => (/round/i.test(String(v)) ? 'round_trip' : 'oneway'),
  deleteBookingSession: async (businessId, number) => { state.deleted.push([businessId, number]); }
});
stub('./bookingGraph.service', { loadGraph: async () => state.graph });
stub('./handoff.service', {
  getActiveSettings: async () => state.handoffSettings,
  raise: async () => { state.raised += 1; return { claimed: state.claimed }; },
  replyTextFor: () => 'HANDOFF TEXT'
});
stub('./notification.service', {
  notify: (businessId, type, payload) => { state.pushes.push({ type, payload }); },
  notifyOnce: (businessId, type, payload) => { state.pushes.push({ type, payload, once: true }); }
});
stub('./payment.service', { buildPaymentQrCaption: ({ intro, upiId }) => `${intro} | UPI ${upiId || '-'}` });
stub('./customerPipeline.service', { advancePipelineStage: async (customerId, stage) => { state.pipeline.push([customerId, stage]); } });
stub('./reports.service', { getPeriodRanges: () => ({}) });

const quoteFlow = require('./quoteFlow.service');
// The in-memory database numbers rows 'travel_quotes-1', not UUIDs, so read the id apart without the UUID check
// (utils/quoteIds.test.js covers the real parser).
const parseQuoteTapId = (id) => { const [, quoteId, action] = id.split(':'); return { quoteId, action }; };

const { B1, uuid } = h;
const CUSTOMER = { id: uuid(500), name: 'Asha', preferredLanguage: 'en' };
const OTHER_CUSTOMER = { id: uuid(501), name: 'Ravi', preferredLanguage: 'en' };
const tenant = { businessId: B1, phoneNumberId: 'pn1', accessToken: 'tok', enabledLanguages: ['en', 'hi', 'mr'] };
const ctxFor = (customer = CUSTOMER) => ({ tenant, customer, customerNumber: '919000000001' });

const QUOTE_NODE = uuid(900);
const session = (extra = {}) => ({
  ruleId: 'rule1', currentNodeId: QUOTE_NODE, answeredFields: [],
  collected: {
    tripType: 'One Way', pickupLocation: 'pune', dropLocation: 'mumbai', quoteRouteId: 'route-1', quoteFromLabel: 'Pune',
    quoteToLabel: 'Mumbai', passengers: '1-4', vehicleId: 'veh-1', vehicleName: 'Toyota Innova Crysta', vehicleFare: 3500,
    routeFareId: 'rf-1', travelDate: 'Today', pickupTime: '10:00 AM', pickupMinute: 600, ...extra
  },
  displayOverrides: { travelDate: '02/11/2026' }
});

let db;
test.beforeEach(() => {
  h.reset();
  h.state.fake = createFakeSupabase({ uniques: [{ table: 'bookings', cols: ['quote_id'] }] });
  db = h.state.fake.db;
  Object.assign(state, { jobs: [], pushes: [], deleted: [], raised: 0, claimed: true, handoffSettings: null, pipeline: [] });
  state.business = {
    id: B1, name: 'SG Travels', displayName: 'SG Travels', requireAdvancePayment: true, advancePaymentType: 'percentage',
    advancePaymentValue: 20, paymentQrUrl: 'https://r2.test/qr.png', upiId: 'sg@upi'
  };
  state.graph = {
    nodes: [{ id: 'menu', nodeType: 'reply' }, { id: 'trip', nodeType: 'question' }, { id: QUOTE_NODE, nodeType: 'quote' }],
    edges: [{ fromNodeId: 'menu', toNodeId: 'trip' }, { fromNodeId: 'trip', toNodeId: QUOTE_NODE }]
  };
  db.businesses = [{ id: B1, require_advance_payment: true, advance_payment_type: 'percentage', advance_payment_value: 20, payment_qr_url: 'x' }];
  db.travel_routes = [{ id: 'route-1', business_id: B1, toll_included: null }];
  db.customers = [CUSTOMER, OTHER_CUSTOMER].map(c => ({ ...c, business_id: B1 }));
});

const send = async (s = session(), quote = { action: 'send', reason: null, nodeId: QUOTE_NODE }, customer = CUSTOMER) =>
  quoteFlow.handleResult(ctxFor(customer), s, quote);
const tapBtn = (job, n) => job.buttons[n].nextKeyword;
const tap = (id, customer = CUSTOMER) => quoteFlow.handleTap(ctxFor(customer), parseQuoteTapId(id));
const quotes = () => db.travel_quotes || [];
const bookings = () => db.bookings || [];

// ── Sending the quote ───────────────────────────────────────────────────────────────────────────

test('send: prices from the rate card, saves a sent quote, sends the message with three buttons, drops the session', async () => {
  const { quoteId } = await send();
  const [q] = quotes();
  assert.equal(q.id, quoteId);
  assert.deepEqual([q.status, q.trip_type, q.from_city, q.to_city, q.base_fare, q.total_amount, q.advance_amount, q.route_id, q.route_fare_id, q.vehicle_id],
    ['sent', 'oneway', 'pune', 'mumbai', 3500, 3500, 700, 'route-1', 'rf-1', 'veh-1']);
  assert.deepEqual(q.extras, []);
  assert.equal(q.collected.flowEntryNodeId, 'trip');
  assert.equal(q.collected.date, '02/11/2026');
  // valid 24 h by default
  const hours = (new Date(q.expires_at) - new Date(q.sent_at)) / 3600000;
  assert.equal(hours, 24);

  assert.equal(state.jobs.length, 1);
  const [job] = state.jobs;
  assert.deepEqual(job.buttons.map(b => b.title), ['Confirm & pay', 'Change', 'Talk to us']);
  assert.deepEqual(job.buttons.map(b => parseQuoteTapId(b.nextKeyword).action), ['confirm', 'change', 'talk']);
  assert.ok(job.buttons.every(b => parseQuoteTapId(b.nextKeyword).quoteId === q.id));
  for (const part of ['Pune → Mumbai', 'One Way', '02/11/2026', '10:00 AM', '1-4', 'Toyota Innova Crysta', 'Total: *₹3,500*', 'Toll is extra', 'Advance to confirm: *₹700*', 'valid until']) {
    assert.ok(job.message.includes(part), part);
  }
  assert.ok(!job.message.includes('Fare: ₹'), 'no breakdown when there are no extras');
  assert.deepEqual(state.deleted, [[B1, '919000000001']]);
  assert.equal(db.messages.length, 1);
});

test('send: night charge, driver allowance and minimum charge are itemised; the total is rounded and the toll override shown', async () => {
  db.travel_quote_settings = [{ business_id: B1, night_charge: 300, night_start_minute: 1320, night_end_minute: 360, driver_allowance_per_day: 500, toll_included: false, minimum_charge: 0, valid_hours: 24, reminder_after_hours: 3 }];
  db.travel_routes = [{ id: 'route-1', business_id: B1, toll_included: true }];
  await send(session({ tripType: 'Round Trip', numberOfDays: '2', pickupMinute: 1380, pickupTime: '11:00 PM', vehicleFare: 4905 }));
  const [q] = quotes();
  assert.equal(q.trip_type, 'round_trip');
  assert.deepEqual(q.extras.map(e => [e.key, e.amount]), [['night_charge', 300], ['driver_allowance', 1000]]);
  assert.equal(q.total_amount, 6210); // 4905 + 300 + 1000 = 6205 -> nearest 10
  assert.equal(q.collected.tollIncluded, true);
  const text = state.jobs[0].message;
  for (const part of ['Fare: ₹4,905', 'Night charge: ₹300', 'Driver allowance (2 day(s)): ₹1,000', 'Total: *₹6,210*', 'Toll is included']) {
    assert.ok(text.includes(part), part);
  }
});

test('send: with the advance off the button says Confirm and no advance line is shown', async () => {
  state.business.requireAdvancePayment = false;
  await send();
  assert.equal(quotes()[0].advance_amount, null);
  assert.equal(state.jobs[0].buttons[0].title, 'Confirm');
  assert.ok(!state.jobs[0].message.includes('Advance'));
});

test('send: a new quote silences the reminder of the customer\'s older open quote', async () => {
  await send();
  assert.equal(quotes()[0].reminder_sent_at ?? null, null);
  await send();
  assert.ok(quotes()[0].reminder_sent_at, 'the older quote got no reminder');
  assert.equal(quotes()[1].reminder_sent_at ?? null, null);
});

test('send: the message and buttons follow the customer\'s language and fit WhatsApp\'s limits', async () => {
  const { buildQuoteText, quoteButtons } = quoteFlow;
  for (const lang of ['en', 'hi', 'mr']) {
    const q = {
      id: uuid(777), trip_type: 'round_trip', base_fare: 12345, total_amount: 20000, advance_amount: 4000, expires_at: new Date().toISOString(),
      extras: [{ key: 'night_charge', amount: 300 }, { key: 'driver_allowance', amount: 1000 }, { key: 'minimum_charge', amount: 5 }],
      collected: { fromLabel: 'A City Name Here 24', toLabel: 'Another City Name 24', date: '12/12/2026', pickupTime: '11:59 PM', passengers: '5-6', days: 10, vehicleName: 'Tempo Traveller 12 Seater', tollIncluded: false }
    };
    assert.ok(buildQuoteText(q, lang).length <= 1024, `${lang} body`);
    for (const withAdvance of [true, false]) {
      const buttons = quoteButtons({ ...q, advance_amount: withAdvance ? 1 : null }, lang);
      assert.ok(buttons.every(b => b.title.length <= 20), `${lang} titles: ${buttons.map(b => b.title).join(' | ')}`);
    }
  }
  const text = quoteFlow.buildQuoteText({
    id: uuid(778), trip_type: 'oneway', base_fare: 2500, total_amount: 2500, advance_amount: 500, expires_at: new Date().toISOString(), extras: [],
    collected: { fromLabel: 'Pune', toLabel: 'Mumbai', tollIncluded: true }
  }, 'hi');
  assert.ok(text.includes('कुल: *₹2,500*') && text.includes('टोल शामिल है'));
});

test('send: a session with no fare is refused (nothing saved or sent)', async () => {
  await assert.rejects(send(session({ vehicleFare: undefined })), /no vehicle fare/);
  assert.equal(quotes().length, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.deleted.length, 1, 'the stuck session is still dropped');
});

// ── Confirm ─────────────────────────────────────────────────────────────────────────────────────

const confirmTap = () => `quote:${quotes()[0].id}:confirm`;

test('Confirm with an advance: accepted, a pending booking linked to the quote, the QR then the "I\'ve paid" button', async () => {
  await send();
  state.jobs.length = 0;
  await tap(confirmTap());
  const [q] = quotes();
  assert.equal(q.status, 'accepted');
  assert.ok(q.accepted_at);
  assert.equal(bookings().length, 1);
  const [b] = bookings();
  assert.deepEqual([b.status, b.payment_status, b.fare_amount, b.payment_amount, b.quote_id, b.payment_details.requestedVia], ['pending', 'pending', 3500, 700, q.id, 'advance']);
  assert.equal(q.booking_id, b.id);
  assert.equal(b.fields.pickupLocation, 'Pune');
  assert.equal(b.fields.quoteTotal, 3500);
  assert.match(b.booking_code, /^SG\d{4}$/);

  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs[0].type, 'image');
  assert.equal(state.jobs[0].imageUrl, 'https://r2.test/qr.png');
  assert.ok(state.jobs[0].message.includes('₹700') && state.jobs[0].message.includes(b.booking_code) && state.jobs[0].message.includes('UPI sg@upi'));
  assert.equal(state.jobs[1].buttons.length, 1);
  assert.equal(state.jobs[1].buttons[0].title, "I've paid");
  assert.deepEqual(parseQuoteTapId(tapBtn(state.jobs[1], 0)), { quoteId: q.id, action: 'paid' });
  assert.equal(state.pushes.filter(p => p.type === 'booking_new').length, 1);
  assert.deepEqual(state.pipeline, [], 'not converted until the owner marks it paid');
});

test('Confirm tapped again (and twice at once): still one booking, the same QR sent again, one owner push', async () => {
  await send();
  state.jobs.length = 0;
  await Promise.all([tap(confirmTap()), tap(confirmTap())]);
  assert.equal(bookings().length, 1);
  await tap(confirmTap());
  assert.equal(bookings().length, 1);
  assert.equal(quotes()[0].status, 'accepted');
  assert.equal(state.pushes.filter(p => p.type === 'booking_new').length, 1);
  const qrJobs = state.jobs.filter(j => j.type === 'image');
  assert.equal(qrJobs.length, 3);
  assert.ok(qrJobs.every(j => j.message === qrJobs[0].message), 'the same booking code every time');
});

test('Confirm after the quote expired: expired, no booking, a "New quote" button', async () => {
  await send();
  quotes()[0].expires_at = new Date(Date.now() - 60000).toISOString();
  state.jobs.length = 0;
  await tap(confirmTap());
  assert.equal(quotes()[0].status, 'expired');
  assert.equal(bookings().length, 0);
  assert.ok(state.jobs[0].message.startsWith('This quote has expired'));
  assert.equal(state.jobs[0].buttons[0].title, 'New quote');
  assert.equal(parseQuoteTapId(tapBtn(state.jobs[0], 0)).action, 'change');
});

test('Confirm on a quote the sweep already expired: the same expired reply, no booking', async () => {
  await send();
  quotes()[0].status = 'expired';
  state.jobs.length = 0;
  await tap(confirmTap());
  assert.equal(bookings().length, 0);
  assert.ok(state.jobs[0].message.startsWith('This quote has expired'));
});

test('Confirm with the advance off: a confirmed booking at once, no payment request, the customer moves to converted', async () => {
  state.business.requireAdvancePayment = false;
  await send();
  state.jobs.length = 0;
  await tap(confirmTap());
  const [b] = bookings();
  assert.deepEqual([b.status, b.payment_status, b.fare_amount, b.payment_amount ?? null], ['confirmed', 'not_required', 3500, null]);
  assert.equal(state.jobs.length, 1);
  assert.ok(state.jobs[0].message.includes('Booking confirmed') && state.jobs[0].message.includes(b.booking_code));
  assert.ok(!state.jobs[0].buttons);
  assert.deepEqual(state.pipeline, [[CUSTOMER.id, 'converted']]);
});

test('Confirm with the advance on but no QR saved: the team shares the payment details (no image, no "I\'ve paid")', async () => {
  state.business.paymentQrUrl = null;
  await send();
  state.jobs.length = 0;
  await tap(confirmTap());
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].type, 'text');
  assert.ok(state.jobs[0].message.includes('₹700'));
});

test('another customer\'s tap, an unknown quote or a handoff row is "no longer available"', async () => {
  await send();
  state.jobs.length = 0;
  await tap(confirmTap(), OTHER_CUSTOMER);
  await tap(`quote:${uuid(999)}:confirm`);
  quotes()[0].status = 'handoff';
  await tap(confirmTap());
  assert.equal(bookings().length, 0);
  assert.equal(state.jobs.length, 3);
  assert.ok(state.jobs.every(j => j.message.startsWith('Sorry, this quote is no longer available')));
});

// ── "I've paid" ─────────────────────────────────────────────────────────────────────────────────

test('"I\'ve paid" tells the owner once, thanks the customer, and never marks anything paid', async () => {
  await send();
  await tap(confirmTap());
  state.jobs.length = 0; state.pushes.length = 0;
  const paidTap = `quote:${quotes()[0].id}:paid`;
  await tap(paidTap);
  await tap(paidTap);
  const [q] = quotes();
  assert.ok(q.customer_paid_claim_at);
  assert.equal(q.status, 'accepted');
  assert.equal(q.paid_at ?? null, null);
  assert.equal(bookings()[0].payment_status, 'pending');
  assert.equal(bookings()[0].status, 'pending');
  const claims = state.pushes.filter(p => p.type === 'quote_paid_claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].payload.amount, 700);
  assert.equal(claims[0].payload.bookingId, bookings()[0].id);
  assert.equal(state.jobs.length, 2);
  assert.ok(state.jobs.every(j => j.message.startsWith('Thanks!')));
});

test('"I\'ve paid" on a quote the owner already marked paid says so; on a sent or no-advance quote it is unavailable', async () => {
  await send();
  const id = quotes()[0].id;
  state.jobs.length = 0;
  await tap(`quote:${id}:paid`); // still 'sent'
  assert.ok(state.jobs[0].message.startsWith('Sorry, this quote is no longer available'));
  await tap(confirmTap());
  quotes()[0].status = 'paid';
  state.jobs.length = 0;
  await tap(`quote:${id}:paid`);
  assert.equal(state.jobs[0].message, 'We have already received your payment ✅');
  assert.equal(state.pushes.filter(p => p.type === 'quote_paid_claim').length, 0);
});

// ── Change / Talk to us ─────────────────────────────────────────────────────────────────────────

test('Change: asks the caller to restart the flow at its entry question and silences this quote\'s reminder', async () => {
  await send();
  const out = await tap(`quote:${quotes()[0].id}:change`);
  assert.deepEqual(out, { restart: { entryNodeId: 'trip' } });
  assert.ok(quotes()[0].reminder_sent_at);
  assert.equal(quotes()[0].status, 'sent');
});

test('Change on a quote with no known entry is "no longer available"', async () => {
  await send();
  delete quotes()[0].collected.flowEntryNodeId;
  state.jobs.length = 0;
  assert.deepEqual(await tap(`quote:${quotes()[0].id}:change`), {});
  assert.ok(state.jobs[0].message.startsWith('Sorry, this quote is no longer available'));
});

test('Talk to us: raises the handoff and sends the handoff reply; the quote itself is untouched', async () => {
  state.handoffSettings = { enabled: true };
  await send();
  state.jobs.length = 0;
  await tap(`quote:${quotes()[0].id}:talk`);
  assert.equal(state.raised, 1);
  assert.equal(state.jobs[0].message, 'HANDOFF TEXT');
  assert.equal(quotes().length, 1);
  assert.equal(quotes()[0].status, 'sent');
});

test('Talk to us with the handoff feature off falls back to the plain push and the built-in reply', async () => {
  await send();
  state.jobs.length = 0;
  await tap(`quote:${quotes()[0].id}:talk`);
  assert.equal(state.raised, 0);
  assert.equal(state.pushes.filter(p => p.type === 'human_needed').length, 1);
  assert.ok(state.jobs[0].message.startsWith('Thank you!'));
});

// ── The engine's handoffs ───────────────────────────────────────────────────────────────────────

test('Other route: raises the handoff, saves a handoff lead, replies, drops the session', async () => {
  state.handoffSettings = { enabled: true };
  const s = session({ quoteRouteId: undefined, pickupLocation: undefined, dropLocation: undefined });
  await send(s, { action: 'handoff', reason: 'other_route' });
  assert.equal(state.raised, 1);
  const [q] = quotes();
  assert.deepEqual([q.status, q.total_amount, q.advance_amount, q.collected.reason, q.trip_type, q.from_city], ['handoff', 0, null, 'other_route', 'oneway', '']);
  assert.equal(state.jobs[0].message, 'HANDOFF TEXT');
  assert.equal(state.deleted.length, 1);
});

test('Other route again while an escalation is open: the reply goes out but no second lead is saved', async () => {
  state.handoffSettings = { enabled: true };
  await send(session(), { action: 'handoff', reason: 'other_route' });
  state.claimed = false;
  await send(session(), { action: 'handoff', reason: 'other_route' });
  assert.equal(quotes().length, 1);
  assert.equal(state.jobs.length, 2);
});

test('feature switched off: the customer is handed over, no quote row is written', async () => {
  state.handoffSettings = { enabled: true };
  await send(session(), { action: 'handoff', reason: 'switch_off' });
  assert.equal(quotes().length, 0);
  assert.equal(state.raised, 1);
  assert.equal(state.jobs[0].message, 'HANDOFF TEXT');
});

test('no vehicle fits: a lead plus a message with Talk to us and Change on that lead; Talk then raises the handoff', async () => {
  state.handoffSettings = { enabled: true };
  await send(session({ passengers: '7+' }), { action: 'no_vehicle', reason: null });
  const [q] = quotes();
  assert.deepEqual([q.status, q.collected.reason, q.collected.passengers, q.collected.flowEntryNodeId], ['handoff', 'no_vehicle', '7+', 'trip']);
  const job = state.jobs[0];
  assert.ok(job.message.includes('Talk to us'));
  assert.deepEqual(job.buttons.map(b => parseQuoteTapId(b.nextKeyword).action), ['talk', 'change']);
  assert.equal(state.raised, 0, 'nothing is raised until they tap');
  state.jobs.length = 0;
  await tap(tapBtn(job, 0));
  assert.equal(state.raised, 1);
  const again = await tap(tapBtn(job, 1));
  assert.deepEqual(again, { restart: { entryNodeId: 'trip' } });
});
