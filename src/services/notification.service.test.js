// Run: node --test src/services/notification.service.test.js
// Push notifications: which channel each device gets, who is a recipient, the
// critical-type dedupe and the new_message throttle, the customer_waiting check.
// In-memory Supabase and Redis; push.service (the FCM transport) is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let sent; let redisKeys; let redisDown; let pushEnabled; let scheduled;

const from = (table) => {
  const filters = [];
  const rows = () => (db[table] = db[table] || []);
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    in: (c, vs) => { filters.push((r) => vs.includes(r[c])); return q; },
    gt: (c, v) => { filters.push((r) => new Date(r[c]).getTime() > new Date(v).getTime()); return q; },
    limit: () => q,
    then: (resolve, reject) => Promise.resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null }).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../config/redis', {
  set: async (key, value, ex, ttl, nx) => {
    if (redisDown) throw new Error('redis down');
    assert.equal(nx, 'NX');
    if (redisKeys.has(key)) return null;
    redisKeys.set(key, ttl);
    return 'OK';
  }
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./push.service', {
  isPushEnabled: () => pushEnabled,
  sendToDevices: async (tokens, message) => { sent.push({ tokens, message }); return { successCount: tokens.length, failureCount: 0, removedCount: 0 }; }
});
stub('../queues/customerWaiting.queue', {
  scheduleCustomerWaiting: async (data, delay) => { scheduled.push({ data, delay }); }
});

const svc = require('./notification.service');

const BIZ = 'b1';
// 22:00 IST = 16:30 UTC; 12:00 IST = 06:30 UTC
const NIGHT = new Date('2026-10-17T17:00:00Z'); // 22:30 IST
const NOON = new Date('2026-10-17T06:30:00Z'); // 12:00 IST

test.beforeEach(() => {
  sent = []; redisKeys = new Map(); redisDown = false; pushEnabled = true; scheduled = [];
  db = {
    users: [
      { id: 'owner', business_id: BIZ, role: 'owner', is_active: true },
      { id: 'staffAll', business_id: BIZ, role: 'staff', is_active: true, can_view_chats: true, can_manage_bookings: true, can_manage_billing: true },
      { id: 'staffChat', business_id: BIZ, role: 'staff', is_active: true, can_view_chats: true, can_manage_bookings: false, can_manage_billing: false },
      { id: 'staffOff', business_id: BIZ, role: 'staff', is_active: false, can_view_chats: true, can_manage_bookings: true, can_manage_billing: true },
      { id: 'otherBizOwner', business_id: 'b2', role: 'owner', is_active: true }
    ],
    device_tokens: [
      { user_id: 'owner', business_id: BIZ, token: 't-owner', language: 'hi' },
      { user_id: 'staffAll', business_id: BIZ, token: 't-staffAll', language: 'en' },
      { user_id: 'staffChat', business_id: BIZ, token: 't-staffChat', language: 'mr' },
      { user_id: 'staffOff', business_id: BIZ, token: 't-staffOff', language: 'en' },
      { user_id: 'otherBizOwner', business_id: 'b2', token: 't-other', language: 'en' }
    ],
    notification_preferences: [],
    messages: []
  };
});

const tokensSent = () => sent.flatMap((s) => s.tokens).sort();
const channelOf = (token) => sent.find((s) => s.tokens.includes(token)).message.android.notification.channelId;

// ── channel selection ───────────────────────────────────────────────────────
test('voice type uses the per-language channel; unknown language falls back to en', () => {
  assert.equal(svc.pickChannel({ type: 'booking_new', language: 'hi' }), 'v1_booking_new_hi');
  assert.equal(svc.pickChannel({ type: 'human_needed', language: 'mr' }), 'v1_human_needed_mr');
  assert.equal(svc.pickChannel({ type: 'payment_received', language: 'ta' }), 'v1_payment_received_en');
  assert.equal(svc.pickChannel({ type: 'enquiry_new', language: undefined }), 'v1_enquiry_new_en');
  assert.equal(svc.pickChannel({ type: 'booking_cancelled', language: 'en' }), 'v1_booking_cancelled_en');
});

test('voice off sends voice types on v1_messages; quiet hours on v1_silent (quiet wins)', () => {
  assert.equal(svc.pickChannel({ type: 'booking_new', language: 'hi', voice: false }), 'v1_messages');
  assert.equal(svc.pickChannel({ type: 'booking_new', language: 'hi', quiet: true }), 'v1_silent');
  assert.equal(svc.pickChannel({ type: 'booking_new', language: 'hi', voice: false, quiet: true }), 'v1_silent');
});

test('new_message / customer_waiting use their voice channel; voice off -> v1_messages, quiet -> v1_silent', () => {
  assert.equal(svc.pickChannel({ type: 'new_message', language: 'hi' }), 'v1_new_message_hi');
  assert.equal(svc.pickChannel({ type: 'customer_waiting', language: 'mr' }), 'v1_customer_waiting_mr');
  assert.equal(svc.pickChannel({ type: 'new_message', language: 'hi', quiet: true }), 'v1_silent');
  assert.equal(svc.pickChannel({ type: 'customer_waiting', language: 'mr', voice: false }), 'v1_messages');
});

test('critical voice types keep their voice clip whatever voice / quiet say; usage_90 has no clip yet', () => {
  for (const type of ['whatsapp_disconnected', 'payment_issue', 'usage_100', 'plan_expiring', 'plan_expired', 'quality_dropped']) {
    assert.equal(svc.pickChannel({ type, language: 'hi', voice: false, quiet: true }), `v1_${type}_hi`, type);
    assert.equal(svc.pickChannel({ type, language: 'ta' }), `v1_${type}_en`, type);
  }
  assert.equal(svc.pickChannel({ type: 'usage_90', language: 'hi', voice: false, quiet: true }), 'v1_critical');
});

test('quiet hours: off when empty, same-day window, window past midnight, 22:00-07:00 in India time', () => {
  const p = (start, end, enabled = true) => svc.resolvePrefs({ quietHours: { enabled, start, end } });
  assert.equal(svc.isQuietHours(svc.resolvePrefs({}), NIGHT), false); // default: off
  assert.equal(svc.isQuietHours(p('22:00', '07:00', false), NIGHT), false); // times set but not enabled
  assert.equal(svc.isQuietHours(p('22:00', '07:00'), NIGHT), true);
  assert.equal(svc.isQuietHours(p('22:00', '07:00'), NOON), false);
  assert.equal(svc.isQuietHours(p('22:00', '07:00'), new Date('2026-10-17T22:00:00Z')), true); // 03:30 IST
  assert.equal(svc.isQuietHours(p('13:00', '15:00'), NOON), false);
  assert.equal(svc.isQuietHours(p('11:00', '13:00'), NOON), true);
  assert.equal(svc.isQuietHours(p('22:00', '22:00'), NIGHT), false);
});

test('notify: each device gets its own language channel, wording and the FCM shape', async () => {
  await svc.notify(BIZ, 'booking_new', { bookingId: 'bk1', customerId: 'c1', customerName: 'Ravi', summary: 'Innova', date: '2026-10-20' });
  assert.equal(channelOf('t-owner'), 'v1_booking_new_hi');
  assert.equal(channelOf('t-staffAll'), 'v1_booking_new_en');
  assert.ok(!tokensSent().includes('t-staffChat')); // no booking permission
  const owner = sent.find((s) => s.tokens.includes('t-owner')).message;
  assert.deepEqual(owner.notification, { title: 'नई बुकिंग', body: 'Ravi · Innova · 2026-10-20' });
  assert.deepEqual(owner.android, { priority: 'high', notification: { channelId: 'v1_booking_new_hi', tag: 'booking_new:c1' } });
  assert.deepEqual(owner.data, { type: 'booking_new', route: '/bookings/bk1', customerId: 'c1', bookingId: 'bk1' });
  assert.ok(Object.values(owner.data).every((v) => typeof v === 'string'));
});

test('notify: tag falls back to the booking id, and the booking_cancelled / enquiry routes', async () => {
  await svc.notify(BIZ, 'booking_cancelled', { bookingId: 'bk9', customerName: 'Sita' });
  assert.equal(sent[0].message.android.notification.tag, 'booking_cancelled:bk9');
  sent = [];
  await svc.notify(BIZ, 'enquiry_new', { customerId: 'c7', customerNumber: '919800000001' });
  assert.equal(sent[0].message.data.route, '/messages/c7');
  assert.equal(sent[0].message.notification.body.includes('919800000001'), true);
});

test('notify: prefs - type toggle off skips that user, voice off uses v1_messages, quiet hours use v1_silent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT });
  db.notification_preferences = [
    { user_id: 'owner', business_id: BIZ, prefs: { types: { booking_new: false } } },
    { user_id: 'staffAll', business_id: BIZ, prefs: { voiceEnabled: false } },
    { user_id: 'staffChat', business_id: BIZ, prefs: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } }
  ];
  await svc.notify(BIZ, 'booking_new', { bookingId: 'bk1' });
  assert.deepEqual(tokensSent(), ['t-staffAll']); // owner opted out; staffChat has no booking permission
  assert.equal(channelOf('t-staffAll'), 'v1_messages'); // voice off, and it has no quiet hours of its own
});

test('notify: voice off outside quiet hours -> v1_messages; quiet hours -> v1_silent', async (t) => {
  db.notification_preferences = [
    { user_id: 'owner', business_id: BIZ, prefs: { voiceEnabled: false } },
    { user_id: 'staffAll', business_id: BIZ, prefs: { quietHours: { enabled: true, start: '22:00', end: '07:00' } } }
  ];
  t.mock.timers.enable({ apis: ['Date'], now: NOON });
  await svc.notify(BIZ, 'enquiry_new', { customerId: 'c1' });
  assert.equal(channelOf('t-owner'), 'v1_messages');
  assert.equal(channelOf('t-staffAll'), 'v1_enquiry_new_en');
  sent = [];
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT });
  await svc.notify(BIZ, 'enquiry_new', { customerId: 'c1' });
  assert.equal(channelOf('t-owner'), 'v1_messages'); // voice off, no quiet hours for owner
  assert.equal(channelOf('t-staffAll'), 'v1_silent');
});

test('critical types ignore toggles and quiet hours and go to the owner only', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT });
  db.notification_preferences = [
    { user_id: 'owner', business_id: BIZ, prefs: { types: { usage_100: false, payment_issue: false }, voiceEnabled: false, quietHours: { enabled: true, start: '22:00', end: '07:00' } } }
  ];
  await svc.notify(BIZ, 'usage_100', {});
  assert.deepEqual(tokensSent(), ['t-owner']);
  assert.equal(channelOf('t-owner'), 'v1_usage_100_hi'); // owner's language, voice off + quiet hours ignored
  assert.equal(sent[0].message.data.route, '/subscription/status');
});

// ── recipients / permission mapping ─────────────────────────────────────────
test('recipients: bookings -> can_manage_bookings, messages -> can_view_chats, payments -> can_manage_billing; inactive and other-business users never', async () => {
  const who = async (type) => { sent = []; await svc.notify(BIZ, type, { customerId: 'c1', bookingId: 'bk1' }); return tokensSent(); };
  assert.deepEqual(await who('booking_new'), ['t-owner', 't-staffAll']);
  assert.deepEqual(await who('booking_cancelled'), ['t-owner', 't-staffAll']);
  assert.deepEqual(await who('enquiry_new'), ['t-owner', 't-staffAll', 't-staffChat']);
  assert.deepEqual(await who('human_needed'), ['t-owner', 't-staffAll', 't-staffChat']);
  assert.deepEqual(await who('new_message'), ['t-owner', 't-staffAll', 't-staffChat']);
  assert.deepEqual(await who('customer_waiting'), ['t-owner', 't-staffAll', 't-staffChat']);
  assert.deepEqual(await who('payment_received'), ['t-owner', 't-staffAll']);
  assert.deepEqual(await who('plan_expired'), ['t-owner']);
});

test('notify never throws or rejects: push off, unknown type, database error', async () => {
  pushEnabled = false;
  await svc.notify(BIZ, 'booking_new', {});
  assert.equal(sent.length, 0);
  pushEnabled = true;
  await svc.notify(BIZ, 'no_such_type', {});
  await svc.notify(null, 'booking_new', {});
  db = { get users() { throw new Error('db down'); } };
  await svc.notify(BIZ, 'booking_new', {});
  assert.equal(sent.length, 0);
});

// ── dedupe and throttle ─────────────────────────────────────────────────────
test('notifyOnce: a critical event is sent once per key within its TTL; another key sends again', async () => {
  await svc.notifyOnce(BIZ, 'usage_90', {}, `${BIZ}:2026-10`, 3000);
  await svc.notifyOnce(BIZ, 'usage_90', {}, `${BIZ}:2026-10`, 3000);
  assert.equal(sent.length, 1);
  assert.equal(redisKeys.get(`notif:once:usage_90:${BIZ}:2026-10`), 3000);
  await svc.notifyOnce(BIZ, 'usage_90', {}, `${BIZ}:2026-11`, 3000);
  assert.equal(sent.length, 2);
  await svc.notifyOnce(BIZ, 'usage_100', {}, `${BIZ}:2026-10`, 3000); // different level, own key
  assert.equal(sent.length, 3);
});

test('notifyOnce: a Redis failure drops the push rather than risk a repeat; push off does not touch Redis', async () => {
  redisDown = true;
  await svc.notifyOnce(BIZ, 'payment_issue', {}, BIZ, 60);
  assert.equal(sent.length, 0);
  redisDown = false; pushEnabled = false;
  await svc.notifyOnce(BIZ, 'payment_issue', {}, BIZ, 60);
  assert.equal(redisKeys.size, 0);
});

test('new_message: at most one per customer per 2 minutes (Redis key), on the voice channel, and plans one 10-minute customer_waiting check', async () => {
  const payload = { customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', preview: 'hello' };
  await svc.notifyNewMessage(BIZ, payload);
  await svc.notifyNewMessage(BIZ, payload);
  const groups = sent.filter((s) => s.message.data.type === 'new_message');
  assert.equal(groups.length, 3); // owner(hi) + staffAll(en) + staffChat(mr): one call per language, once
  assert.deepEqual(groups.map((g) => g.message.android.notification.channelId).sort(),
    ['v1_new_message_en', 'v1_new_message_hi', 'v1_new_message_mr']);
  assert.equal(redisKeys.get(`notif:newmsg:${BIZ}:c1`), 120);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 10 * 60 * 1000);
  assert.equal(scheduled[0].data.customerId, 'c1');
  await svc.notifyNewMessage(BIZ, { ...payload, customerId: 'c2' }); // other customer is not throttled
  assert.equal(scheduled.length, 2);
});

test('new_message body carries the message preview', async () => {
  await svc.notifyNewMessage(BIZ, { customerId: 'c1', customerName: 'Ravi', preview: 'Need a cab at 5' });
  assert.equal(sent[0].message.notification.body, 'Ravi: Need a cab at 5');
});

// ── customer_waiting ────────────────────────────────────────────────────────
test('customer_waiting: notifies when nothing was sent to the customer since, stays quiet when something was', async () => {
  const job = { businessId: BIZ, customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', since: '2026-10-17T10:00:00.000Z' };
  db.messages = [{ business_id: BIZ, customer_id: 'c1', direction: 'inbound', created_at: '2026-10-17T10:05:00.000Z' }];
  assert.equal(await svc.runCustomerWaitingCheck(job), 'notified');
  assert.equal(sent.every((s) => s.message.data.type === 'customer_waiting'), true);
  assert.match(sent[0].message.android.notification.channelId, /^v1_customer_waiting_(en|hi|mr)$/);
  sent = [];
  db.messages.push({ business_id: BIZ, customer_id: 'c1', direction: 'outbound', created_at: '2026-10-17T10:06:00.000Z' });
  assert.equal(await svc.runCustomerWaitingCheck(job), 'answered');
  assert.equal(sent.length, 0);
  db.messages = [{ business_id: BIZ, customer_id: 'c1', direction: 'outbound', created_at: '2026-10-17T09:00:00.000Z' }]; // before the message
  assert.equal(await svc.runCustomerWaitingCheck(job), 'notified');
});

// ── preferences ─────────────────────────────────────────────────────────────
test('resolvePrefs fills defaults: every type on, voice on, quiet hours off', () => {
  const p = svc.resolvePrefs({});
  assert.deepEqual(p, {
    types: { booking_new: true, enquiry_new: true, payment_received: true, human_needed: true, booking_cancelled: true, new_message: true, customer_waiting: true },
    voiceEnabled: true,
    quietHours: { enabled: false, start: '22:00', end: '07:00' }
  });
  assert.deepEqual(svc.resolvePrefs({ voice: false, quietStart: '01:00' }), p); // old keys are ignored
  assert.ok(Object.values(p.types).every((v) => v === true));
  assert.equal(svc.resolvePrefs({ types: { booking_new: false } }).types.booking_new, false);
});

test('validatePrefs accepts a good body and rejects bad shapes, naming the field', () => {
  const good = { types: { booking_new: false }, voiceEnabled: true, quietHours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.equal(svc.validatePrefs(good).ok, true);
  assert.equal(svc.validatePrefs({}).ok, true);
  assert.equal(svc.validatePrefs({ quietHours: { enabled: false } }).ok, true);
  const field = (body) => { const r = svc.validatePrefs(body); assert.equal(r.ok, false, JSON.stringify(body)); assert.ok(r.error.startsWith(r.field), r.error); return r.field; };
  assert.equal(field(null), 'body');
  assert.equal(field([]), 'body');
  assert.equal(field({ voiceEnabled: 'yes' }), 'voiceEnabled');
  assert.equal(field({ voice: true }), 'voice'); // the old keys are gone
  assert.equal(field({ quietStart: '22:00' }), 'quietStart');
  assert.equal(field({ types: { nope: true } }), 'types.nope');
  assert.equal(field({ types: { usage_100: true } }), 'types.usage_100'); // critical types are not switchable
  assert.equal(field({ types: { booking_new: 'no' } }), 'types.booking_new');
  assert.equal(field({ types: [] }), 'types');
  assert.equal(field({ quietHours: 'on' }), 'quietHours');
  assert.equal(field({ quietHours: { enabled: 1 } }), 'quietHours.enabled');
  assert.equal(field({ quietHours: { start: '25:00' } }), 'quietHours.start');
  assert.equal(field({ quietHours: { end: '7:00' } }), 'quietHours.end');
  assert.equal(field({ quietHours: { from: '22:00' } }), 'quietHours.from');
});

test('sendTest goes only to that user, ignores toggles and quiet hours, and never collapses', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NIGHT });
  db.notification_preferences = [{ user_id: 'owner', business_id: BIZ, prefs: { types: { booking_new: false }, quietHours: { enabled: true, start: '22:00', end: '07:00' } } }];
  await svc.sendTest(BIZ, 'owner', 'booking_new');
  assert.deepEqual(tokensSent(), ['t-owner']);
  assert.equal(channelOf('t-owner'), 'v1_booking_new_hi');
  assert.match(sent[0].message.android.notification.tag, /^booking_new:\d+$/);
});

test('texts exist in en / hi / mr for every type', () => {
  for (const type of svc.TYPE_NAMES) {
    for (const lang of ['en', 'hi', 'mr']) {
      const { title, body } = svc.buildText(type, { customerName: 'Ravi', amount: 500, days: 3 }, lang);
      assert.ok(title && body, `${type}/${lang}`);
      assert.ok(!/[{}]/.test(title + body), `${type}/${lang} has an unfilled placeholder`);
    }
  }
  assert.equal(svc.buildText('payment_received', { customerName: 'Ravi', amount: 500 }, 'en').body, '₹500 received from Ravi');
});

test('payment_received: the actor is left out; another eligible user still gets it', async () => {
  await svc.notify(BIZ, 'payment_received', { bookingId: 'bk1', customerName: 'Ravi', amount: 500 }, { excludeUserId: 'owner' });
  assert.deepEqual(tokensSent(), ['t-staffAll']);
  assert.equal(sent[0].message.notification.body, '₹500 received from Ravi');
  sent = [];
  await svc.notify(BIZ, 'payment_received', { bookingId: 'bk1', customerNumber: '919800000001', amount: 500 }, { excludeUserId: 'staffAll' });
  assert.deepEqual(tokensSent(), ['t-owner']);
  assert.ok(sent[0].message.notification.body.includes('919800000001'));
});

test('critical routes', async () => {
  const routeOf = async (type) => { sent = []; await svc.notify(BIZ, type, {}); return sent[0].message.data.route; };
  assert.equal(await routeOf('whatsapp_disconnected'), '/business/whatsapp');
  assert.equal(await routeOf('payment_issue'), '/business/whatsapp');
  for (const type of ['usage_90', 'usage_100', 'plan_expiring', 'plan_expired']) assert.equal(await routeOf(type), '/subscription/status');
});

test('isAcknowledgement: short en / hi / mr / emoji acknowledgements only', () => {
  for (const yes of ['ok', 'OK', ' Okay! ', 'thanks', 'Thank you', 'thx', '👍', '🙏🙏', '👍 🙏', 'ho', 'हो', 'हाँ', 'ठीक', 'ठीक है', 'ठीक आहे.', 'धन्यवाद', 'बरं', 'ok sir']) {
    assert.equal(svc.isAcknowledgement(yes), true, yes);
  }
  for (const no of ['', '   ', 'what is the price', 'ok but how much is it', 'thanks for the quick reply sir', 'can you call', '?']) {
    assert.equal(svc.isAcknowledgement(no), false, no);
  }
});

test('asksForHuman: contains one of the listed phrases, any case', () => {
  for (const yes of ['I want to TALK TO OWNER', 'please call me', 'is this a Human?', 'a real person please', 'let me speak to someone', 'मालकांशी बोला', 'मला बोलायचे आहे', 'मुझे बात करनी है', 'कॉल करो', 'फोन करा', 'call kar na']) {
    assert.equal(svc.asksForHuman(yes), true, yes);
  }
  for (const no of ['', 'hello', 'price of innova', 'thanks']) assert.equal(svc.asksForHuman(no), false, no);
});

// ── handoff (human_needed reminder, no customer_waiting while a handoff is open) ──────────────
test('human_needed reminder: same type, title and channel, a "still waiting" body (en/hi/mr)', async () => {
  const payload = { customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', reminder: true };
  assert.equal(svc.buildText('human_needed', payload, 'en').body, 'Ravi is still waiting for your reply');
  assert.equal(svc.buildText('human_needed', payload, 'hi').body, 'Ravi अभी भी आपके जवाब का इंतज़ार कर रहा है');
  assert.equal(svc.buildText('human_needed', payload, 'mr').body, 'Ravi अजूनही तुमच्या उत्तराची वाट पाहत आहे');
  assert.equal(svc.buildText('human_needed', payload, 'en').title, svc.buildText('human_needed', { ...payload, reminder: false }, 'en').title);
  assert.match(svc.buildText('human_needed', { ...payload, reminder: false }, 'en').body, /asked something the bot couldn't answer/);
  await svc.notify(BIZ, 'human_needed', payload);
  assert.equal(channelOf('t-owner'), 'v1_human_needed_hi');
});

test('new_message with skipWaitingCheck: still pushes (throttled) but plans no customer_waiting check', async () => {
  const payload = { customerId: 'c1', customerName: 'Ravi', preview: 'hello?' };
  await svc.notifyNewMessage(BIZ, payload, { skipWaitingCheck: true });
  assert.equal(sent.filter((s) => s.message.data.type === 'new_message').length, 3);
  assert.equal(scheduled.length, 0);
});
