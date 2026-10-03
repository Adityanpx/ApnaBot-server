// Run: node --test src/services/followupSweep.service.test.js
// runSweep against an in-memory stand-in for Supabase (the filters the
// sweeper uses, incl. .or() and followup_sends' unique key), with the
// business lookup, feature switch and WhatsApp send replaced — nothing is
// written or sent.
const test = require('node:test');
const assert = require('node:assert/strict');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-03T06:30:00Z'); // 12:00 India time
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

let db; let sendCalls; let hooks; let featureOn; let businessRow; let sendBehaviour;

// ── In-memory Supabase ──
const toTime = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : v);
const cmp = (a, b) => { const x = toTime(a); const y = toTime(b); return x < y ? -1 : x > y ? 1 : 0; };
const splitTop = (s) => {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts;
};
const orClause = (part) => {
  const [col, op, ...rest] = part.split('.');
  const val = rest.join('.');
  if (op === 'is' && val === 'null') return r => (r[col] ?? null) === null;
  if (op === 'lte') return r => r[col] !== null && r[col] !== undefined && cmp(r[col], val) <= 0;
  if (op === 'gte') return r => r[col] !== null && r[col] !== undefined && cmp(r[col], val) >= 0;
  if (op === 'in') { const vs = val.replace(/^\(|\)$/g, '').split(','); return r => vs.includes(r[col]); }
  throw new Error(`mock .or(): unsupported ${part}`);
};

const from = (table) => {
  const filters = []; let op = 'select'; let payload; let countHead = false; const orders = []; let rng = null; let lim = null; let embedCustomer = false;
  const matching = () => db[table].filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') {
      if (table === 'followup_sends') {
        if (hooks.conflictFor && hooks.conflictFor.has(payload.customer_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        if (db.followup_sends.some(r => r.automation_id === payload.automation_id && r.customer_id === payload.customer_id && r.trigger_key === payload.trigger_key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
      }
      const row = { id: `${table}-${db[table].length + 1}`, created_at: NOW.toISOString(), ...payload };
      db[table].push(row);
      if (table === 'followup_sends' && hooks.afterClaim) hooks.afterClaim(row);
      return { data: [row], error: null };
    }
    if (op === 'update') {
      const hit = matching(); hit.forEach(r => Object.assign(r, payload));
      return { data: hit, error: null };
    }
    if (op === 'delete') {
      const hit = matching(); db[table] = db[table].filter(r => !hit.includes(r));
      return { data: hit, error: null };
    }
    let rows = matching();
    if (countHead) return { data: null, count: rows.length, error: null };
    if (orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const o of orders) { const c = o.asc ? cmp(a[o.col], b[o.col]) : cmp(b[o.col], a[o.col]); if (c) return c; }
        return 0;
      });
    }
    if (rng) rows = rows.slice(rng[0], rng[1] + 1);
    if (lim !== null) rows = rows.slice(0, lim);
    // PostgREST embed: bookings ... customer:customers(...)
    if (embedCustomer) rows = rows.map(r => ({ ...r, customer: db.customers.find(c => c.id === r.customer_id) || null }));
    return { data: rows, error: null };
  };
  const q = {
    select: (cols, opts) => { if (opts && opts.head) countHead = true; if (typeof cols === 'string' && cols.includes('customer:customers(')) embedCustomer = true; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    delete: () => { op = 'delete'; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    neq: (c, v) => { filters.push(r => r[c] !== v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    lte: (c, v) => { filters.push(r => r[c] != null && cmp(r[c], v) <= 0); return q; },
    lt: (c, v) => { filters.push(r => r[c] != null && cmp(r[c], v) < 0); return q; },
    gt: (c, v) => { filters.push(r => r[c] != null && cmp(r[c], v) > 0); return q; },
    gte: (c, v) => { filters.push(r => r[c] != null && cmp(r[c], v) >= 0); return q; },
    or: (s) => { const fs = splitTop(s).map(orClause); filters.push(r => fs.some(f => f(r))); return q; },
    order: (col, o) => { orders.push({ col, asc: !o || o.ascending !== false }); return q; },
    range: (a, b) => { rng = [a, b]; return q; },
    limit: (n) => { lim = n; return q; },
    maybeSingle: async () => { const r = run(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
    single: async () => { const r = run(); return { data: r.data ? r.data[0] : null, error: r.error }; },
    then: (resolve, reject) => { try { resolve(run()); } catch (e) { reject(e); } }
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./business.service', { getBusinessById: async (id) => (businessRow && businessRow.id === id ? businessRow : null) });
stub('./categoryFeature.service', { isEnabled: async (category, feature) => feature === 'followups' && featureOn });
const FREE_FORM_WINDOW_MS = DAY;
stub('./windowAwareSend.service', {
  isConnected: (b) => !!(b.isWhatsappConnected && b.phoneNumberId),
  isWindowOpen: (c, nowMs = Date.now()) => !!(c.last_message_at && nowMs < new Date(c.last_message_at).getTime() + FREE_FORM_WINDOW_MS),
  sendWindowAwareMessage: async (business, customer, opts) => {
    if (sendBehaviour.throwFor && sendBehaviour.throwFor.has(customer.id)) throw new Error('boom');
    const windowOpen = customer.last_message_at && NOW.getTime() < new Date(customer.last_message_at).getTime() + FREE_FORM_WINDOW_MS;
    sendCalls.push({ customerId: customer.id, text: opts.textFor(customer.preferred_language || null), template: opts.template, params: opts.templateParams, templateText: opts.templateText, billing: opts.billing });
    if (windowOpen) return { sent: 'text', messageId: `msg-${customer.id}`, costPaise: 0 };
    if (!opts.template) return { sent: false, code: 'no_template' };
    return { sent: 'template', messageId: `msg-${customer.id}`, costPaise: 80 };
  }
});

const { runSweep, compareAutomations, TRIGGER_PRIORITY } = require('./followupSweep.service');

// ── Fixtures ──
const customer = (id, over = {}) => ({
  id, business_id: 'b1', whatsapp_number: `9198000000${id.slice(-2).padStart(2, '0')}`, name: `Cust ${id}`,
  last_message_at: ago(4 * HOUR), opted_in: false, opted_out_at: null, is_blocked: false, bot_paused_until: null, preferred_language: null,
  ...over
});
const nudge = (over = {}) => ({
  id: 'a-nudge', business_id: 'b1', name: 'Nudge', preset: 'enquiry_nudge', trigger_type: 'after_last_inbound',
  delay_minutes: 180, trigger_params: { recentBookingDays: 7 }, message_category: 'marketing',
  message_text: 'Hi {{customerName}}!', message_text_translations: null, template_id: null, template_variable_mapping: null,
  send_start_minute: 540, send_end_minute: 1260, daily_cap: 100, per_customer_cap: 3, is_active: true, created_at: ago(30 * DAY),
  ...over
});
const winBack = (over = {}) => ({
  id: 'a-win', business_id: 'b1', name: 'Win back', preset: 'win_back', trigger_type: 'inactive_for',
  delay_minutes: 30 * 24 * 60, trigger_params: { onlyPastCustomers: true, maxInactiveDays: 180 }, message_category: 'marketing',
  message_text: 'Hi again', message_text_translations: null, template_id: 't1',
  template_variable_mapping: [{ source: 'customer.name', fallback: 'there' }, { source: 'business.name', fallback: 'us' }],
  send_start_minute: 600, send_end_minute: 1200, daily_cap: 50, per_customer_cap: 2, is_active: true, created_at: ago(30 * DAY),
  ...over
});

const reset = ({ customers = [], automations = [], bookings = [], sends = [] } = {}) => {
  db = {
    customers, bookings, followup_automations: automations, followup_sends: sends,
    subscriptions: [{ id: 's1', business_id: 'b1', status: 'active' }],
    message_templates: [{ id: 't1', business_id: 'b1', name: 'come_back', status: 'approved', category: 'MARKETING', header_type: 'NONE', language: 'en_US', body_text: 'Hi {{1}}, {{2}} misses you!' }]
  };
  sendCalls = []; hooks = {}; featureOn = true; sendBehaviour = {};
  businessRow = { id: 'b1', name: 'Bright', displayName: 'Bright Minds', businessCategory: 'coaching', isActive: true, isWhatsappConnected: true, phoneNumberId: 'pn' };
};
const sweep = (opts = {}) => runSweep({ now: NOW, ...opts });
const sendFor = (customerId) => db.followup_sends.find(s => s.customer_id === customerId);

// ── enquiry_nudge ──
test('enquiry nudge: due after the delay, not before; sent as text and recorded', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02', { last_message_at: ago(2 * HOUR) })] });
  const s = await sweep();
  assert.equal(s.sent, 1);
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c01']);
  assert.equal(sendCalls[0].text, 'Hi Cust c01!');
  const row = sendFor('c01');
  assert.equal(row.status, 'sent_text');
  assert.equal(row.message_id, 'msg-c01');
  assert.equal(row.cost_paise, 0);
  assert.equal(row.trigger_key, `inbound:${customer('c01').last_message_at}`);
  assert.equal(sendFor('c02'), undefined);
});

test('enquiry nudge: window margin — last inbound 23h55m ago is not due, 23h45m is', async () => {
  reset({ automations: [nudge()], customers: [customer('c01', { last_message_at: ago(23 * HOUR + 55 * MIN) }), customer('c02', { last_message_at: ago(23 * HOUR + 45 * MIN) })] });
  await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c02']);
});

test('enquiry nudge: open booking or a booking in the last recentBookingDays excludes; an old closed one does not', async () => {
  reset({
    automations: [nudge()],
    customers: [customer('c01'), customer('c02'), customer('c03'), customer('c04')],
    bookings: [
      { customer_id: 'c01', business_id: 'b1', status: 'pending', created_at: ago(40 * DAY) },   // open
      { customer_id: 'c02', business_id: 'b1', status: 'completed', created_at: ago(5 * DAY) },  // recent
      { customer_id: 'c03', business_id: 'b1', status: 'completed', created_at: ago(10 * DAY) }  // old, closed
    ]
  });
  await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId).sort(), ['c03', 'c04']);
});

test('opted out, blocked and bot-paused customers are never candidates', async () => {
  reset({
    automations: [nudge()],
    customers: [
      customer('c01', { opted_out_at: ago(DAY) }),
      customer('c02', { is_blocked: true }),
      customer('c03', { bot_paused_until: new Date(NOW.getTime() + HOUR).toISOString() }),
      customer('c04', { bot_paused_until: ago(HOUR) }) // pause over
    ]
  });
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c04']);
  assert.equal(s.candidates, 1);
});

// ── win_back ──
test('win back: needs opted_in and a past confirmed/completed booking; inactive between delay and maxInactiveDays', async () => {
  const past = (id) => ({ customer_id: id, business_id: 'b1', status: 'completed', created_at: ago(60 * DAY) });
  reset({
    automations: [winBack()],
    customers: [
      customer('c01', { last_message_at: ago(40 * DAY), opted_in: true, name: 'Asha' }), // due
      customer('c02', { last_message_at: ago(40 * DAY), opted_in: false }),               // not opted in
      customer('c03', { last_message_at: ago(40 * DAY), opted_in: true }),                // never booked
      customer('c04', { last_message_at: ago(10 * DAY), opted_in: true }),                // not inactive long enough
      customer('c05', { last_message_at: ago(200 * DAY), opted_in: true })                // past maxInactiveDays
    ],
    bookings: [past('c01'), past('c02'), { customer_id: 'c03', business_id: 'b1', status: 'cancelled', created_at: ago(60 * DAY) }, past('c04'), past('c05')]
  });
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c01']);
  const call = sendCalls[0];
  assert.equal(call.template.id, 't1');
  assert.deepEqual(call.params, ['Asha', 'Bright Minds']);
  assert.equal(call.templateText, 'Hi Asha, Bright Minds misses you!');
  const row = sendFor('c01');
  assert.equal(call.billing.referenceId, row.id);
  assert.equal(row.status, 'sent_template');
  assert.equal(row.cost_paise, 80);
  assert.equal(row.trigger_key, `inactive:${new Date(ago(40 * DAY)).toISOString()}`);
  assert.equal(s.sent, 1);
});

test('win back: template no longer approved → skipped no_template, nothing sent', async () => {
  reset({
    automations: [winBack()],
    customers: [customer('c01', { last_message_at: ago(40 * DAY), opted_in: true })],
    bookings: [{ customer_id: 'c01', business_id: 'b1', status: 'completed', created_at: ago(60 * DAY) }]
  });
  db.message_templates[0].status = 'rejected';
  const s = await sweep();
  assert.equal(sendCalls.length, 0);
  assert.equal(sendFor('c01').status, 'skipped');
  assert.equal(sendFor('c01').reason, 'no_template');
  assert.equal(s.skipped, 1);
});

// ── Limits ──
test('outside send hours: nothing happens', async () => {
  reset({ automations: [nudge({ send_start_minute: 780, send_end_minute: 1260 })], customers: [customer('c01')] }); // 13:00–21:00, now 12:00
  const s = await sweep();
  assert.equal(sendCalls.length, 0);
  assert.equal(s.outsideHours, 1);
  assert.equal(db.followup_sends.length, 0);
});

test('daily cap counts today\'s claims (India day) and stops at the cap', async () => {
  reset({
    automations: [nudge({ daily_cap: 2 })],
    customers: [customer('c01'), customer('c02'), customer('c03')],
    sends: [
      { id: 'old1', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'x1', trigger_key: 'k1', status: 'sent_text', created_at: ago(2 * HOUR) },  // today
      { id: 'old2', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'x2', trigger_key: 'k2', status: 'sent_text', created_at: ago(13 * HOUR) } // yesterday IST
    ]
  });
  const s = await sweep();
  assert.equal(s.sent, 1);
  reset({ automations: [nudge({ daily_cap: 1 })], customers: [customer('c01')], sends: [
    { id: 'old1', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'x1', trigger_key: 'k1', status: 'claimed', created_at: ago(5 * MIN) }
  ] });
  const s2 = await sweep();
  assert.equal(s2.sent, 0);
  assert.equal(s2.capReached, 1);
});

test('per-customer lifetime cap: earlier sends for this automation count', async () => {
  const prior = (n) => ({ id: `p${n}`, automation_id: 'a-nudge', business_id: 'b1', customer_id: 'c01', trigger_key: `inbound:old-${n}`, status: 'sent_text', created_at: ago((n + 2) * DAY) });
  reset({ automations: [nudge({ per_customer_cap: 2 })], customers: [customer('c01'), customer('c02')], sends: [prior(1), prior(2)] });
  await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c02']);
});

test('already handled occurrence (same trigger key) is not sent again', async () => {
  const c = customer('c01');
  reset({ automations: [nudge()], customers: [c], sends: [
    { id: 'p1', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'c01', trigger_key: `inbound:${c.last_message_at}`, status: 'skipped', created_at: ago(HOUR) }
  ] });
  const s = await sweep();
  assert.equal(sendCalls.length, 0);
  assert.equal(s.candidates, 0);
});

test('claim conflict (another sweep got there first) → skipped silently', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02')] });
  hooks.conflictFor = new Set(['c01']);
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c02']);
  assert.equal(s.failed, 0);
  assert.equal(sendFor('c01'), undefined);
});

test('fresh re-check after the claim: STOP / reply / booking in between → skipped with reason', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02'), customer('c03'), customer('c04')] });
  hooks.afterClaim = (row) => {
    const c = db.customers.find(x => x.id === row.customer_id);
    if (c.id === 'c01') c.opted_out_at = NOW.toISOString();
    if (c.id === 'c02') c.last_message_at = ago(MIN); // replied → new trigger
    if (c.id === 'c03') db.bookings.push({ customer_id: 'c03', business_id: 'b1', status: 'pending', created_at: NOW.toISOString() });
  };
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c04']);
  assert.equal(sendFor('c01').reason, 'opted_out');
  assert.equal(sendFor('c02').reason, 'customer_replied');
  assert.equal(sendFor('c03').reason, 'booked');
  assert.equal(s.skipped, 3);
});

test('stale claims (>30 min) become failed "interrupted" and are not re-sent; recent claims untouched', async () => {
  const c = customer('c01');
  reset({ automations: [nudge()], customers: [c], sends: [
    { id: 'st1', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'c01', trigger_key: `inbound:${c.last_message_at}`, status: 'claimed', created_at: ago(40 * MIN) },
    { id: 'st2', automation_id: 'a-nudge', business_id: 'b1', customer_id: 'zz', trigger_key: 'k', status: 'claimed', created_at: ago(20 * MIN) }
  ] });
  const s = await sweep();
  assert.equal(s.staleClaims, 1);
  assert.equal(db.followup_sends.find(r => r.id === 'st1').status, 'failed');
  assert.equal(db.followup_sends.find(r => r.id === 'st1').reason, 'interrupted');
  assert.equal(db.followup_sends.find(r => r.id === 'st2').status, 'claimed');
  assert.equal(sendCalls.length, 0); // same occurrence, never re-sent
});

test('one candidate throwing is marked failed; the others still go out', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02'), customer('c03')] });
  sendBehaviour.throwFor = new Set(['c02']);
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId).sort(), ['c01', 'c03']);
  assert.equal(sendFor('c02').status, 'failed');
  assert.equal(sendFor('c02').reason, 'error');
  assert.equal(s.failed, 1);
  assert.equal(s.sent, 2);
});

// ── Business checks, dry run, global cap ──
test('business checks: feature off / not connected / no active subscription / inactive → whole business skipped', async () => {
  const run = async (mutate) => {
    reset({ automations: [nudge()], customers: [customer('c01')] });
    mutate();
    const s = await sweep();
    assert.equal(sendCalls.length, 0);
    return s.businessesSkipped.b1;
  };
  assert.equal(await run(() => { featureOn = false; }), 'feature_off');
  assert.equal(await run(() => { businessRow.isWhatsappConnected = false; }), 'not_connected');
  assert.equal(await run(() => { db.subscriptions = []; }), 'no_active_subscription');
  assert.equal(await run(() => { businessRow.isActive = false; }), 'business_inactive');
});

test('dry run: lists who would get what, claims and sends nothing', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02')] });
  const s = await sweep({ dryRun: true });
  assert.equal(s.planned.length, 2);
  assert.equal(s.planned[0].via, 'text');
  assert.equal(db.followup_sends.length, 0);
  assert.equal(sendCalls.length, 0);
});

test('global cap per sweep stops claiming across automations', async () => {
  reset({ automations: [nudge()], customers: ['c01', 'c02', 'c03', 'c04'].map(id => customer(id)) });
  const s = await sweep({ maxSends: 2 });
  assert.equal(s.sent, 2);
  assert.equal(db.followup_sends.length, 2);
});

test('limits to one business when businessId is given', async () => {
  reset({ automations: [nudge(), nudge({ id: 'a-other', business_id: 'b2' })], customers: [customer('c01')] });
  const s = await sweep({ businessId: 'b1' });
  assert.equal(s.automations, 1);
});

// ── One follow-up per customer per India-time day, across automations ──
const nudgeB = (over = {}) => nudge({ id: 'a-second', name: 'Second nudge', preset: 'custom', delay_minutes: 60, created_at: ago(10 * DAY), ...over });

test('two automations (same trigger) due for the same customer: exactly one send, the older automation wins', async () => {
  reset({ automations: [nudgeB(), nudge()], customers: [customer('c01')] }); // nudge() is older (30 days)
  const s = await sweep();
  assert.equal(s.sent, 1);
  assert.equal(db.followup_sends.length, 1);
  assert.equal(db.followup_sends[0].automation_id, 'a-nudge');
});

// A customer can't be due for an after_last_inbound nudge (< 24 h since the
// last inbound) and an inactive_for win-back (≥ 1 day) at the same moment, so
// trigger priority is shown with a one-send budget instead.
test('trigger priority: a newer enquiry nudge goes before an older win-back', async () => {
  reset({
    automations: [winBack({ created_at: ago(90 * DAY) }), nudge({ created_at: ago(DAY) })],
    customers: [
      customer('c01', { last_message_at: ago(40 * DAY), opted_in: true }), // win-back due
      customer('c02')                                                       // nudge due
    ],
    bookings: [{ customer_id: 'c01', business_id: 'b1', status: 'completed', created_at: ago(60 * DAY) }]
  });
  const s = await sweep({ maxSends: 1 });
  assert.equal(s.sent, 1);
  assert.deepEqual(db.followup_sends.map(r => [r.automation_id, r.customer_id]), [['a-nudge', 'c02']]);
});

test('compareAutomations: trigger priority, then created_at, then id; unknown triggers last', () => {
  const a = (id, trigger_type, created_at) => ({ id, trigger_type, created_at });
  const list = [
    a('w-old', 'inactive_for', '2026-01-01T00:00:00Z'),
    a('future', 'some_future_trigger', '2025-01-01T00:00:00Z'),
    a('review', 'after_completed', '2026-09-30T00:00:00Z'),
    a('payment', 'after_payment_requested', '2026-09-30T00:00:00Z'),
    a('n-new-b', 'after_last_inbound', '2026-09-01T00:00:00Z'),
    a('n-new-a', 'after_last_inbound', '2026-09-01T00:00:00Z'),
    a('n-old', 'after_last_inbound', '2026-05-01T00:00:00Z')
  ];
  assert.deepEqual([...list].sort(compareAutomations).map(x => x.id), ['n-old', 'n-new-a', 'n-new-b', 'payment', 'review', 'w-old', 'future']);
  assert.deepEqual(TRIGGER_PRIORITY, { after_last_inbound: 0, after_payment_requested: 1, after_completed: 2, inactive_for: 3 });
});

test('the next India-time day the other automation can send', async () => {
  reset({ automations: [nudge({ per_customer_cap: 1 }), nudgeB()], customers: [customer('c01')] });
  await sweep();
  assert.deepEqual(db.followup_sends.map(r => [r.automation_id, r.status]), [['a-nudge', 'sent_text']]);

  // Next day, 12:00 IST again; the customer messaged in the morning.
  const tomorrow = new Date(NOW.getTime() + DAY);
  db.customers[0].last_message_at = new Date(tomorrow.getTime() - 4 * HOUR).toISOString();
  const s = await runSweep({ now: tomorrow });
  assert.equal(s.sent, 1);
  assert.equal(db.followup_sends.at(-1).automation_id, 'a-second'); // a-nudge used its 1 lifetime send
});

test('a follow-up claimed earlier today by another automation blocks the customer for the rest of the day', async () => {
  reset({ automations: [nudge()], customers: [customer('c01'), customer('c02')], sends: [
    { id: 'o1', automation_id: 'a-other', business_id: 'b1', customer_id: 'c01', trigger_key: 'k', status: 'sent_template', created_at: ago(3 * HOUR) },
    { id: 'o2', automation_id: 'a-other', business_id: 'b1', customer_id: 'c02', trigger_key: 'k', status: 'skipped', created_at: ago(3 * HOUR) }, // skipped doesn't count
    { id: 'o3', automation_id: 'a-other', business_id: 'b2', customer_id: 'c02', trigger_key: 'k', status: 'sent_text', created_at: ago(HOUR) }  // other business
  ] });
  await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c02']);
  // filtered before claiming — no wasted claim row for c01
  assert.equal(db.followup_sends.filter(r => r.automation_id === 'a-nudge' && r.customer_id === 'c01').length, 0);
});

test('dry run respects the per-customer daily limit too', async () => {
  reset({ automations: [nudge(), nudgeB()], customers: [customer('c01'), customer('c02')] });
  const s = await sweep({ dryRun: true });
  assert.deepEqual(s.planned.map(p => [p.automationId, p.customerId]), [['a-nudge', 'c01'], ['a-nudge', 'c02']]);
});

test('fresh re-check: an overlapping sweep claimed the customer earlier today → skipped daily_limit_customer', async () => {
  reset({ automations: [nudge()], customers: [customer('c01')] });
  hooks.afterClaim = (row) => {
    if (row.automation_id !== 'a-nudge') return;
    db.followup_sends.push({ id: 'race', automation_id: 'a-other', business_id: 'b1', customer_id: row.customer_id, trigger_key: 'k', status: 'claimed', created_at: ago(MIN) });
  };
  const s = await sweep();
  assert.equal(sendCalls.length, 0);
  assert.equal(sendFor('c01').reason, 'daily_limit_customer');
  assert.equal(s.skipped, 1);
});

test('fresh re-check: a later claim by another sweep does not stop the earlier one', async () => {
  reset({ automations: [nudge()], customers: [customer('c01')] });
  hooks.afterClaim = (row) => {
    if (row.automation_id !== 'a-nudge') return;
    db.followup_sends.push({ id: 'zz-later', automation_id: 'a-other', business_id: 'b1', customer_id: row.customer_id, trigger_key: 'k', status: 'claimed', created_at: new Date(NOW.getTime() + 1000).toISOString() });
  };
  await sweep();
  assert.equal(sendCalls.length, 1);
});

test('template params: Hindi template, unnamed customer, no owner fallback → जी', async () => {
  reset({
    automations: [winBack({ template_variable_mapping: [{ source: 'customer.name', fallback: '' }, { source: 'business.name', fallback: 'us' }] })],
    customers: [customer('c01', { last_message_at: ago(40 * DAY), opted_in: true, name: null })],
    bookings: [{ customer_id: 'c01', business_id: 'b1', status: 'completed', created_at: ago(60 * DAY) }]
  });
  db.message_templates[0].language = 'hi';
  await sweep();
  assert.deepEqual(sendCalls[0].params, ['जी', 'Bright Minds']);
});

// ── Booking triggers: review request (after_completed) / payment reminder (after_payment_requested) ──
const utilityTemplate = { id: 't2', business_id: 'b1', name: 'booking_followup', status: 'approved', category: 'UTILITY', header_type: 'NONE', language: 'en_US', body_text: 'Hi {{1}}, about booking {{2}}' };
const review = (over = {}) => ({
  id: 'a-review', business_id: 'b1', name: 'Review', preset: 'review_request', trigger_type: 'after_completed',
  delay_minutes: 1440, trigger_params: {}, message_category: 'utility',
  message_text: 'Thanks {{customerName}} for {{bookingCode}}!', message_text_translations: null, template_id: 't2',
  template_variable_mapping: [{ source: 'customer.name', fallback: '' }, { source: 'booking.code', fallback: '' }],
  send_start_minute: 600, send_end_minute: 1200, daily_cap: 100, per_customer_cap: 3, is_active: true, created_at: ago(30 * DAY),
  ...over
});
const payment = (over = {}) => review({
  id: 'a-pay', name: 'Payment', preset: 'payment_pending', trigger_type: 'after_payment_requested', delay_minutes: 360,
  message_text: '{{amount}} for {{bookingCode}} is pending',
  template_variable_mapping: [{ source: 'customer.name', fallback: '' }, { source: 'booking.amount', fallback: '' }],
  ...over
});
const booking = (id, customerId, over = {}) => ({
  id, business_id: 'b1', customer_id: customerId, booking_code: `SG${id.slice(-2)}`, payment_amount: 0,
  status: 'confirmed', payment_status: 'not_required', completed_at: null, payment_requested_at: null, ...over
});
const resetBooking = (opts) => { reset(opts); db.message_templates.push(utilityTemplate); };

test('review request: due 1 day after completion; template with the booking code; claim carries booking_id', async () => {
  resetBooking({
    automations: [review()],
    customers: [customer('c01', { last_message_at: ago(5 * DAY), name: 'Asha' }), customer('c02', { last_message_at: ago(5 * DAY) }), customer('c03', { last_message_at: ago(9 * DAY) })],
    bookings: [
      booking('bk01', 'c01', { status: 'completed', completed_at: ago(DAY + MIN) }),        // due
      booking('bk02', 'c02', { status: 'completed', completed_at: ago(23 * HOUR) }),        // not yet
      booking('bk03', 'c03', { status: 'completed', completed_at: ago(3 * DAY + HOUR) })    // missed by > 2 days: never sent late
    ]
  });
  const s = await sweep();
  assert.equal(s.sent, 1);
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c01']);
  assert.deepEqual(sendCalls[0].params, ['Asha', 'SG01']);
  assert.equal(sendCalls[0].templateText, 'Hi Asha, about booking SG01');
  const row = sendFor('c01');
  assert.equal(row.booking_id, 'bk01');
  assert.equal(row.trigger_key, 'completed:bk01');
  assert.equal(row.status, 'sent_template');
  // utility: no marketing opt-in needed (c01 is not opted in)
  assert.equal(db.customers[0].opted_in, false);
});

test('review request: one per booking — a second sweep sends nothing', async () => {
  resetBooking({ automations: [review()], customers: [customer('c01', { last_message_at: ago(5 * DAY) })],
    bookings: [booking('bk01', 'c01', { status: 'completed', completed_at: ago(DAY + MIN) })] });
  await sweep();
  const s2 = await runSweep({ now: new Date(NOW.getTime() + 15 * MIN) });
  assert.equal(s2.sent, 0);
  assert.equal(sendCalls.length, 1);
});

test('review request: booking reopened after the claim → skipped booking_reopened', async () => {
  resetBooking({ automations: [review()], customers: [customer('c01', { last_message_at: ago(5 * DAY) })],
    bookings: [booking('bk01', 'c01', { status: 'completed', completed_at: ago(DAY + MIN) })] });
  hooks.afterClaim = () => { db.bookings[0].status = 'confirmed'; };
  await sweep();
  assert.equal(sendCalls.length, 0);
  assert.equal(sendFor('c01').reason, 'booking_reopened');
});

test('payment reminder: text in the open window with the amount; replied / cancelled / paid customers skipped', async () => {
  resetBooking({
    automations: [payment()],
    customers: [
      customer('c01', { last_message_at: ago(7 * HOUR) }),   // messaged before the request → due, window open
      customer('c02', { last_message_at: ago(HOUR) }),       // messaged after the request (screenshot?) → wait
      customer('c03', { last_message_at: ago(7 * HOUR) }),   // booking cancelled
      customer('c04', { last_message_at: ago(7 * HOUR) })    // already paid
    ],
    bookings: [
      booking('bk01', 'c01', { payment_status: 'pending', payment_amount: 1500, payment_requested_at: ago(6 * HOUR + MIN) }),
      booking('bk02', 'c02', { payment_status: 'pending', payment_amount: 900, payment_requested_at: ago(6 * HOUR + MIN) }),
      booking('bk03', 'c03', { status: 'cancelled', payment_status: 'pending', payment_requested_at: ago(6 * HOUR + MIN) }),
      booking('bk04', 'c04', { payment_status: 'paid', payment_requested_at: ago(6 * HOUR + MIN) })
    ]
  });
  const s = await sweep();
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c01']);
  assert.equal(sendCalls[0].text, '₹1,500 for SG01 is pending');
  assert.equal(sendFor('c01').status, 'sent_text');
  assert.equal(s.sent, 1);
  // filtered before claiming — no wasted claim rows for the others
  assert.deepEqual(db.followup_sends.map(r => r.customer_id), ['c01']);
});

test('payment reminder: paid between claim and send → skipped paid; no amount reads "your payment"', async () => {
  resetBooking({ automations: [payment()],
    customers: [customer('c01', { last_message_at: ago(7 * HOUR) }), customer('c02', { last_message_at: ago(7 * HOUR) })],
    bookings: [
      booking('bk01', 'c01', { payment_status: 'pending', payment_requested_at: ago(6 * HOUR + MIN) }),
      booking('bk02', 'c02', { payment_status: 'pending', payment_requested_at: ago(6 * HOUR + 2 * MIN) })
    ] });
  hooks.afterClaim = (row) => { if (row.customer_id === 'c01') db.bookings[0].payment_status = 'paid'; };
  await sweep();
  assert.equal(sendFor('c01').reason, 'paid');
  assert.deepEqual(sendCalls.map(c => c.customerId), ['c02']);
  assert.equal(sendCalls[0].text, 'your payment for SG02 is pending');
});

test('payment reminder: a new request (paid → pending again) is a new occurrence', async () => {
  const firstRequest = ago(3 * DAY);
  resetBooking({ automations: [payment()], customers: [customer('c01', { last_message_at: ago(7 * HOUR) })],
    bookings: [booking('bk01', 'c01', { payment_status: 'pending', payment_requested_at: ago(6 * HOUR + MIN) })],
    sends: [{ id: 'old', automation_id: 'a-pay', business_id: 'b1', customer_id: 'c01', booking_id: 'bk01', trigger_key: `payment:bk01:${new Date(firstRequest).toISOString()}`, status: 'sent_template', created_at: ago(3 * DAY) }] });
  await sweep();
  assert.equal(sendCalls.length, 1);
  assert.notEqual(db.followup_sends.at(-1).trigger_key, db.followup_sends[0].trigger_key);
});

test('booking triggers respect the one-follow-up-per-customer-per-day rule (two bookings, same customer)', async () => {
  resetBooking({ automations: [review()], customers: [customer('c01', { last_message_at: ago(5 * DAY) })],
    bookings: [
      booking('bk01', 'c01', { status: 'completed', completed_at: ago(DAY + MIN) }),
      booking('bk02', 'c01', { status: 'completed', completed_at: ago(DAY + 2 * MIN) })
    ] });
  const s = await sweep();
  assert.equal(s.sent, 1);
  assert.equal(db.followup_sends.length, 1);
});

test('booking triggers: blocked / opted out / paused customers are not candidates', async () => {
  resetBooking({ automations: [review()],
    customers: [
      customer('c01', { last_message_at: ago(5 * DAY), is_blocked: true }),
      customer('c02', { last_message_at: ago(5 * DAY), opted_out_at: ago(DAY) }),
      customer('c03', { last_message_at: ago(5 * DAY), bot_paused_until: new Date(NOW.getTime() + HOUR).toISOString() })
    ],
    bookings: ['c01', 'c02', 'c03'].map((c, i) => booking(`bk0${i + 1}`, c, { status: 'completed', completed_at: ago(DAY + MIN) })) });
  const s = await sweep();
  assert.equal(s.candidates, 0);
  assert.equal(db.followup_sends.length, 0);
});

test('countDueCustomers counts due bookings for booking triggers', async () => {
  resetBooking({ automations: [], customers: [customer('c01', { last_message_at: ago(5 * DAY) }), customer('c02', { last_message_at: ago(5 * DAY), is_blocked: true })],
    bookings: [
      booking('bk01', 'c01', { status: 'completed', completed_at: ago(DAY + MIN) }),
      booking('bk02', 'c02', { status: 'completed', completed_at: ago(DAY + MIN) }),
      booking('bk03', 'c01', { status: 'completed', completed_at: ago(HOUR) })
    ] });
  const { countDueCustomers } = require('./followupSweep.service');
  assert.deepEqual(await countDueCustomers({ ...review(), business_id: 'b1' }, NOW), { count: 1, capped: false });
});
