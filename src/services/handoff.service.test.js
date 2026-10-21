// Run: node --test src/services/handoff.service.test.js
// The human-needed alert: the atomic claim (one push per open escalation), the 30-minute cooldown after
// a clear, the bot pause that never shortens another pause, clear + auto-resume of the handoff's own
// pause only, the reminder, the reply text (open / closed) and the settings cache.
// In-memory Supabase and Redis; notification, socket and the reminder queue are recorders.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = 'b1';
const MIN = 60 * 1000;

let db; let redisStore; let redisDown; let dbDown; let pushes; let sockets; let scheduled; let cancelled; let reads;

const matches = (row, c, v) => (row[c] ?? null) === v;

const from = (table) => {
  const filters = []; let op = 'select'; let payload; let conflict;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (dbDown) return { data: null, error: new Error('db down') };
    if (op === 'update') { const m = matching(); m.forEach((r) => Object.assign(r, payload)); return { data: m, error: null }; }
    if (op === 'insert') { rows().push({ ...payload }); return { data: [payload], error: null }; }
    if (op === 'upsert') {
      const existing = rows().find((r) => r[conflict] === payload[conflict]);
      if (existing) Object.assign(existing, payload); else rows().push({ ...payload });
      return { data: [existing || payload], error: null };
    }
    if (table === 'business_handoff_settings') reads.push(table);
    return { data: matching(), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => matches(r, c, v)); return q; },
    is: (c, v) => { filters.push((r) => matches(r, c, v)); return q; },
    not: (c, _op, v) => { filters.push((r) => !matches(r, c, v)); return q; },
    // or('handoff_cleared_at.is.null,handoff_cleared_at.lt.<iso>')
    or: (expr) => {
      const parts = expr.split(',').map((p) => p.split('.'));
      filters.push((r) => parts.some(([col, opName, ...rest]) => {
        const v = rest.join('.');
        if (opName === 'is') return r[col] === null || r[col] === undefined;
        if (opName === 'lt') return r[col] != null && new Date(r[col]).getTime() < new Date(v).getTime();
        return false;
      }));
      return q;
    },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    upsert: (p, opts) => { op = 'upsert'; payload = p; conflict = opts.onConflict; return q; },
    maybeSingle: async () => { const r = run(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
    single: async () => { const r = run(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../config/redis', {
  get: async (k) => { if (redisDown) throw new Error('redis down'); return redisStore.get(k) ?? null; },
  set: async (k, v, _ex, ttl) => { if (redisDown) throw new Error('redis down'); redisStore.set(k, v); redisStore.set(`ttl:${k}`, ttl); return 'OK'; },
  del: async (k) => { if (redisDown) throw new Error('redis down'); return redisStore.delete(k) ? 1 : 0; },
  incr: async (k) => { if (redisDown) throw new Error('redis down'); const n = (redisStore.get(k) || 0) + 1; redisStore.set(k, n); return n; },
  expire: async (k, ttl) => { redisStore.set(`ttl:${k}`, ttl); return 1; }
});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./notification.service', { notify: (...args) => { pushes.push(args); return Promise.resolve(); } });
stub('./socket.service', { emitToBusiness: (...args) => { sockets.push(args); } });
stub('../queues/handoffReminder.queue', {
  scheduleHandoffReminder: async (data, delay) => { scheduled.push({ data, delay }); },
  cancelHandoffReminder: async (customerId, at) => { cancelled.push([customerId, at]); }
});

const svc = require('./handoff.service');
const { DEFAULTS } = require('../utils/handoffSettings');

const ON = { ...DEFAULTS, enabled: true };
const customerRow = (over = {}) => ({
  id: 'c1', business_id: BIZ, name: 'Ravi', whatsapp_number: '9198',
  bot_paused_until: null, needs_human_at: null, needs_human_reason: null, handoff_cleared_at: null, handoff_pause_set_to: null, ...over
});
const camel = () => ({ id: 'c1', name: 'Ravi', botPausedUntil: null });
const row = () => db.customers.find((c) => c.id === 'c1');
const raise = (reason, settings = ON, customer = camel()) => svc.raise({ businessId: BIZ, customer, customerNumber: '9198', reason, settings });

test.beforeEach(() => {
  db = { customers: [customerRow()], business_handoff_settings: [] };
  redisStore = new Map(); redisDown = false; dbDown = false;
  pushes = []; sockets = []; scheduled = []; cancelled = []; reads = [];
});

// ── raise ───────────────────────────────────────────────────────────────────
test('raise: the first trigger wins - one human_needed push, the row stamped, a reminder planned, the app told', async () => {
  const customer = camel();
  const r = await raise('keyword', ON, customer);
  assert.deepEqual(r, { claimed: true });
  assert.equal(row().needs_human_reason, 'keyword');
  assert.ok(row().needs_human_at);
  assert.equal(customer.needsHumanAt, row().needs_human_at);
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0], [BIZ, 'human_needed', { customerId: 'c1', customerName: 'Ravi', customerNumber: '9198' }]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 15 * MIN);
  assert.deepEqual(scheduled[0].data, { businessId: BIZ, customerId: 'c1', needsHumanAt: row().needs_human_at });
  assert.deepEqual(sockets, [[BIZ, 'needs_human', { customerId: 'c1', needsHuman: { since: row().needs_human_at, reason: 'keyword' } }]]);
});

test('raise: while one is open every further trigger sends nothing (no push, no reminder, no event)', async () => {
  await raise('unmatched');
  for (const reason of ['tap', 'keyword', 'unmatched']) {
    assert.deepEqual(await raise(reason), { claimed: false }, reason);
  }
  assert.equal(pushes.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(sockets.length, 1);
  assert.equal(row().needs_human_reason, 'unmatched'); // the first reason stays
});

test('raise: two triggers at once - exactly one claims', async () => {
  const [a, b] = await Promise.all([raise('keyword'), raise('tap')]);
  assert.equal([a, b].filter((r) => r.claimed).length, 1);
  assert.equal(pushes.length, 1);
});

test('raise: "unmatched" waits 30 minutes after a clear; a tap or a keyword does not', async () => {
  row().handoff_cleared_at = new Date(Date.now() - 10 * MIN).toISOString();
  assert.deepEqual(await raise('unmatched'), { claimed: false });
  assert.equal(row().needs_human_at, null);
  assert.deepEqual(await raise('keyword'), { claimed: true });

  db.customers = [customerRow({ handoff_cleared_at: new Date(Date.now() - 10 * MIN).toISOString() })];
  assert.deepEqual(await raise('tap'), { claimed: true });

  db.customers = [customerRow({ handoff_cleared_at: new Date(Date.now() - 31 * MIN).toISOString() })];
  assert.deepEqual(await raise('unmatched'), { claimed: true });
});

test('raise: reminderMinutes 0 plans no reminder', async () => {
  await raise('tap', { ...ON, reminderMinutes: 0 });
  assert.equal(scheduled.length, 0);
  assert.equal(pushes.length, 1);
});

test('raise: a failed reminder plan or socket event never fails the escalation', async () => {
  const queue = require('../queues/handoffReminder.queue');
  const original = queue.scheduleHandoffReminder;
  queue.scheduleHandoffReminder = async () => { throw new Error('redis down'); };
  try {
    assert.deepEqual(await raise('tap'), { claimed: true });
  } finally { queue.scheduleHandoffReminder = original; }
  assert.equal(pushes.length, 1);
});

test('raise: a database error on the claim is thrown (the webhook then falls back to the plain push)', async () => {
  dbDown = true;
  await assert.rejects(raise('tap'), /db down/);
  assert.equal(pushes.length, 0);
});

test('raise: pauseBotMinutes pauses the bot and remembers what it wrote', async () => {
  const customer = camel();
  await raise('tap', { ...ON, pauseBotMinutes: 60 }, customer);
  assert.ok(row().bot_paused_until);
  assert.equal(row().handoff_pause_set_to, row().bot_paused_until);
  const minutes = (new Date(row().bot_paused_until).getTime() - Date.now()) / MIN;
  assert.ok(minutes > 59 && minutes <= 60, String(minutes));
  assert.equal(customer.botPausedUntil, row().bot_paused_until);
});

test('raise: never shortens a pause already in force (an owner\'s forever included); extends a shorter one', async () => {
  const forever = '9999-12-31T00:00:00.000Z';
  const indefinite = camel(); indefinite.botPausedUntil = forever;
  db.customers[0].bot_paused_until = forever;
  await raise('tap', { ...ON, pauseBotMinutes: 60 }, indefinite);
  assert.equal(row().bot_paused_until, forever);
  assert.equal(row().handoff_pause_set_to, null);

  db.customers = [customerRow({ bot_paused_until: new Date(Date.now() + 5 * MIN).toISOString() })];
  const shorter = camel(); shorter.botPausedUntil = row().bot_paused_until;
  await raise('tap', { ...ON, pauseBotMinutes: 60 }, shorter);
  assert.equal(row().handoff_pause_set_to, row().bot_paused_until);
  assert.ok(new Date(row().bot_paused_until).getTime() > Date.now() + 59 * MIN);
});

test('raise: pauseBotMinutes 0 leaves the bot on', async () => {
  await raise('tap');
  assert.equal(row().bot_paused_until, null);
});

test('raise: resets the unmatched run', async () => {
  redisStore.set(`handoff:unmatched:${BIZ}:c1`, 2);
  await raise('keyword');
  assert.equal(redisStore.has(`handoff:unmatched:${BIZ}:c1`), false);
});

// ── clear ───────────────────────────────────────────────────────────────────
test('clear: closes the escalation, stamps handoff_cleared_at, cancels the reminder, tells the app', async () => {
  await raise('keyword');
  const at = row().needs_human_at;
  sockets = [];
  const r = await svc.clear({ businessId: BIZ, customerId: 'c1' });
  assert.equal(r.found, true);
  assert.equal(r.wasOpen, true);
  assert.equal(r.clearedAt, row().handoff_cleared_at);
  assert.equal(row().needs_human_at, null);
  assert.equal(row().needs_human_reason, null);
  assert.deepEqual(cancelled, [['c1', at]]);
  assert.deepEqual(sockets, [[BIZ, 'needs_human', { customerId: 'c1', needsHuman: null }]]);
});

test('clear: nothing open -> wasOpen false and nothing touched; unknown or other-business customer -> found false', async () => {
  assert.deepEqual(await svc.clear({ businessId: BIZ, customerId: 'c1' }), { found: true, wasOpen: false, clearedAt: null });
  assert.equal(row().handoff_cleared_at, null);
  assert.equal(cancelled.length, 0);
  assert.deepEqual(await svc.clear({ businessId: 'other', customerId: 'c1' }), { found: false, wasOpen: false, clearedAt: null });
  assert.deepEqual(await svc.clear({ businessId: BIZ, customerId: 'nobody' }), { found: false, wasOpen: false, clearedAt: null });
});

test('clear: with auto-resume on, lifts the pause the handoff set - and only that one', async () => {
  db.business_handoff_settings = [{ business_id: BIZ, enabled: true, auto_resume_bot: true, pause_bot_minutes: 60 }];
  await raise('tap', { ...ON, pauseBotMinutes: 60, autoResumeBot: true });
  assert.ok(row().bot_paused_until);
  await svc.clear({ businessId: BIZ, customerId: 'c1' });
  assert.equal(row().bot_paused_until, null);
  assert.equal(row().handoff_pause_set_to, null);

  // The owner changed the pause since (a reply pauses 24h, "forever"...): left alone.
  db.customers = [customerRow({
    needs_human_at: new Date().toISOString(), needs_human_reason: 'tap',
    bot_paused_until: '2026-12-01T00:00:00.000Z', handoff_pause_set_to: '2026-10-21T10:00:00.000Z'
  })];
  await svc.clear({ businessId: BIZ, customerId: 'c1' });
  assert.equal(row().bot_paused_until, '2026-12-01T00:00:00.000Z');
  assert.equal(row().handoff_pause_set_to, null);
});

test('clear: with auto-resume off (or no settings row) the pause stays', async () => {
  db.business_handoff_settings = [{ business_id: BIZ, enabled: true, auto_resume_bot: false }];
  await raise('tap', { ...ON, pauseBotMinutes: 60 });
  const pause = row().bot_paused_until;
  await svc.clear({ businessId: BIZ, customerId: 'c1' });
  assert.equal(row().bot_paused_until, pause);
});

test('clearQuietly never throws', async () => {
  dbDown = true;
  assert.deepEqual(await svc.clearQuietly({ businessId: BIZ, customerId: 'c1' }), { found: false, wasOpen: false, clearedAt: null });
});

// ── reminder ────────────────────────────────────────────────────────────────
test('runReminder: pushes "still waiting" only while that same escalation is open', async () => {
  await raise('tap');
  const job = scheduled[0].data;
  pushes = [];
  assert.equal(await svc.runReminder(job), 'notified');
  assert.deepEqual(pushes, [[BIZ, 'human_needed', { customerId: 'c1', customerName: 'Ravi', customerNumber: '9198', reminder: true }]]);

  pushes = [];
  await svc.clear({ businessId: BIZ, customerId: 'c1' });
  assert.equal(await svc.runReminder(job), 'cleared');

  // Cleared and opened again: the old job must not remind about the new escalation.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await raise('keyword');
  assert.equal(await svc.runReminder(job), 'cleared');
  assert.equal(pushes.length, 1); // only the second raise's own push
  assert.equal(await svc.runReminder(scheduled[1].data), 'notified');
});

test('runReminder: a database error is reported, not thrown', async () => {
  dbDown = true;
  assert.equal(await svc.runReminder({ businessId: BIZ, customerId: 'c1', needsHumanAt: new Date().toISOString() }), 'error');
});

// ── what the customer is told ───────────────────────────────────────────────
// 2026-10-19 is a Monday. IST = UTC+05:30.
const ist = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00+05:30`);
const HOURS = {
  mon: [{ open: '09:00', close: '18:00' }], tue: [{ open: '09:00', close: '18:00' }],
  wed: [], thu: [{ open: '10:00', close: '18:00' }], fri: [{ open: '09:00', close: '18:00' }]
};

test('replyTextFor: built-in text in the customer\'s language; the business\'s own text wins, translated when it has one', () => {
  assert.match(svc.replyTextFor(ON, 'en'), /Our team has been told/);
  assert.match(svc.replyTextFor(ON, 'hi'), /हमारी टीम को बता दिया गया है/);
  assert.match(svc.replyTextFor(ON, 'mr'), /आमच्या टीमला कळवले आहे/);
  assert.match(svc.replyTextFor(ON, null), /Our team has been told/);
  const own = { ...ON, replyText: 'We will call you', replyTextTranslations: { hi: 'हम कॉल करेंगे' } };
  assert.equal(svc.replyTextFor(own, 'en'), 'We will call you');
  assert.equal(svc.replyTextFor(own, 'hi'), 'हम कॉल करेंगे');
  assert.equal(svc.replyTextFor(own, 'mr'), 'We will call you');
});

test('replyTextFor: closed -> the closed text with {{nextOpening}} filled; open, or hours unknown -> the normal text', () => {
  const withHours = { ...ON, hours: HOURS };
  assert.equal(svc.replyTextFor(withHours, 'en', ist('19', '20:00')),
    'Thank you! 🙏 We are closed right now. Our team will reply to you here tomorrow at 9:00 am.');
  assert.match(svc.replyTextFor(withHours, 'hi', ist('19', '20:00')), /कल सुबह 9:00 बजे/);
  assert.match(svc.replyTextFor(withHours, 'mr', ist('19', '20:00')), /उद्या सकाळी 9:00 वाजता/);
  assert.match(svc.replyTextFor(withHours, 'en', ist('19', '07:00')), /today at 9:00 am/);
  assert.match(svc.replyTextFor(withHours, 'en', ist('20', '20:00')), /Thursday at 10:00 am/); // Wednesday is closed
  assert.match(svc.replyTextFor(withHours, 'en', ist('19', '12:00')), /Our team has been told/); // open
  assert.match(svc.replyTextFor(ON, 'en', ist('19', '03:00')), /Our team has been told/); // hours null: never "closed"
  assert.match(svc.replyTextFor({ ...ON, hours: { mon: [] } }, 'en', ist('19', '12:00')), /Our team has been told/); // never opens: no time to give
  const own = { ...withHours, closedText: 'Shut. Back {{nextOpening}}', closedTextTranslations: { hi: 'बंद। {{nextOpening}} मिलेंगे' } };
  assert.equal(svc.replyTextFor(own, 'en', ist('19', '20:00')), 'Shut. Back tomorrow at 9:00 am');
  assert.equal(svc.replyTextFor(own, 'hi', ist('19', '20:00')), 'बंद। कल सुबह 9:00 बजे मिलेंगे');
});

// ── unmatched run ───────────────────────────────────────────────────────────
test('bumpUnmatched counts one more each time, with a 24h expiry set on the first; reset starts over', async () => {
  assert.equal(await svc.bumpUnmatched(BIZ, 'c1'), 1);
  assert.equal(redisStore.get(`ttl:handoff:unmatched:${BIZ}:c1`), 24 * 60 * 60);
  assert.equal(await svc.bumpUnmatched(BIZ, 'c1'), 2);
  assert.equal(await svc.bumpUnmatched(BIZ, 'c2'), 1);
  await svc.resetUnmatched(BIZ, 'c1');
  assert.equal(await svc.bumpUnmatched(BIZ, 'c1'), 1);
});

test('bumpUnmatched: Redis down counts 0, so a failure never escalates; reset never throws', async () => {
  redisDown = true;
  assert.equal(await svc.bumpUnmatched(BIZ, 'c1'), 0);
  await svc.resetUnmatched(BIZ, 'c1');
});

// ── settings ────────────────────────────────────────────────────────────────
test('getSettings: no row -> null (cached); a row -> the settings; getActiveSettings only when enabled', async () => {
  assert.equal(await svc.getSettings(BIZ), null);
  assert.equal(redisStore.get(`handoff:settings:${BIZ}`), 'none');
  assert.equal(await svc.getActiveSettings(BIZ), null);

  await svc.invalidateSettings(BIZ);
  db.business_handoff_settings = [{ business_id: BIZ, enabled: false, unmatched_threshold: 4 }];
  const off = await svc.getSettings(BIZ);
  assert.equal(off.enabled, false);
  assert.equal(off.unmatchedThreshold, 4);
  assert.equal(await svc.getActiveSettings(BIZ), null);

  await svc.invalidateSettings(BIZ);
  db.business_handoff_settings[0].enabled = true;
  assert.equal((await svc.getActiveSettings(BIZ)).unmatchedThreshold, 4);
});

test('getSettings: served from the cache within the minute (no second read)', async () => {
  db.business_handoff_settings = [{ business_id: BIZ, enabled: true }];
  await svc.getSettings(BIZ);
  const before = reads.length;
  await svc.getSettings(BIZ);
  await svc.getActiveSettings(BIZ);
  assert.equal(reads.length, before);
  assert.equal(redisStore.get(`ttl:handoff:settings:${BIZ}`), 60);
});

test('getSettings fails open: Redis down reads the database; a database error counts as no row (handoff off), never throws', async () => {
  db.business_handoff_settings = [{ business_id: BIZ, enabled: true }];
  redisDown = true;
  assert.equal((await svc.getActiveSettings(BIZ)).enabled, true);
  redisDown = false; redisStore.clear();
  dbDown = true;
  assert.equal(await svc.getActiveSettings(BIZ), null);
});

test('saveSettings: merges a patch onto the stored row (or the defaults), drops the cache, returns the saved settings', async () => {
  await svc.getSettings(BIZ); // caches "none"
  const first = await svc.saveSettings(BIZ, { enabled: true, replyText: 'Hi' });
  assert.equal(first.enabled, true);
  assert.equal(first.replyText, 'Hi');
  assert.equal(first.unmatchedThreshold, 3);
  assert.equal(redisStore.has(`handoff:settings:${BIZ}`), false);
  const second = await svc.saveSettings(BIZ, { unmatchedThreshold: 5 });
  assert.equal(second.replyText, 'Hi'); // kept
  assert.equal(second.unmatchedThreshold, 5);
  assert.equal(db.business_handoff_settings.length, 1);
});

test('toNeedsHuman: { since, reason } or null, from either row shape', () => {
  assert.equal(svc.toNeedsHuman({ needsHumanAt: null }), null);
  assert.equal(svc.toNeedsHuman(null), null);
  assert.deepEqual(svc.toNeedsHuman({ needsHumanAt: '2026-10-21T10:00:00Z', needsHumanReason: 'tap' }), { since: '2026-10-21T10:00:00Z', reason: 'tap' });
  assert.deepEqual(svc.toNeedsHuman({ needs_human_at: '2026-10-21T10:00:00Z', needs_human_reason: 'keyword' }), { since: '2026-10-21T10:00:00Z', reason: 'keyword' });
});
