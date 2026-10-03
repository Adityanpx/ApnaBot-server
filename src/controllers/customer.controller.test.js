// Run: node --test src/controllers/customer.controller.test.js
// isBroadcastEligible must match broadcastAudience.service.js#resolveAudience.
// The VIP tests use an in-memory stand-in for customers / bookings / the
// customer_booking_stats RPC that, like PostgREST on the hosted project,
// caps every response at MAX_ROWS rows.
const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_ROWS = 1000;
const tables = { customers: [], bookings: [] };

const query = (table) => {
  const filters = [];
  const orders = [];
  let range = null;
  let head = false;
  let wantCount = false;
  const q = {
    select: (cols, opts = {}) => { head = !!opts.head; wantCount = opts.count === 'exact'; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    order: (c, { ascending = true } = {}) => { orders.push({ c, ascending }); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    then: (resolve) => {
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      const count = wantCount ? rows.length : null;
      for (const { c, ascending } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      resolve({ data: head ? null : rows.slice(0, MAX_ROWS), count, error: null });
    }
  };
  return q;
};

const rpc = async (name, { p_business_id, p_customer_ids, p_statuses }) => {
  assert.equal(name, 'customer_booking_stats');
  const stats = new Map();
  for (const b of tables.bookings) {
    if (b.business_id !== p_business_id || !p_customer_ids.includes(b.customer_id) || !p_statuses.includes(b.status)) continue;
    const s = stats.get(b.customer_id) || { customer_id: b.customer_id, booking_count: 0, spend: 0 };
    s.booking_count += 1;
    s.spend += b.fare_amount;
    stats.set(b.customer_id, s);
  }
  return { data: [...stats.values()].slice(0, MAX_ROWS), error: null };
};

const business = { id: 'big', vipEnabled: true, vipCriteria: 'count', vipThreshold: 2 };

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from: query, rpc });
stub('../services/business.service', { getBusinessById: async () => business });
stub('../services/optInLink.service', { fetchLinkNames: async () => new Map() });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { isBroadcastEligible, getCustomers, getCustomerSummary } = require('./customer.controller');

const row = (over = {}) => ({ opted_in: true, is_blocked: false, opted_out_at: null, ...over });

test('broadcast eligible: opted in, not blocked, not opted out', () => {
  assert.equal(isBroadcastEligible(row()), true);
  assert.equal(isBroadcastEligible(row({ opted_out_at: undefined })), true); // row from before the column
});

test('not eligible: not opted in, blocked, or sent STOP', () => {
  assert.equal(isBroadcastEligible(row({ opted_in: false })), false);
  assert.equal(isBroadcastEligible(row({ is_blocked: true })), false);
  assert.equal(isBroadcastEligible(row({ opted_out_at: '2026-10-01T10:00:00Z' })), false);
});

// ── VIP counts past the 1000-row cap ──
// 2,500 customers; the first 1,500 have 2 confirmed bookings each (VIP at
// threshold 2), the rest 1 confirmed + 1 cancelled (not VIP). 4,000 bookings.
const pad = (n) => String(n).padStart(5, '0');
for (let i = 0; i < 2500; i += 1) {
  const id = `c-${pad(i)}`;
  tables.customers.push({ id, business_id: 'big', whatsapp_number: `91${pad(i)}`, name: `C${i}`,
    opted_in: false, is_blocked: false, opted_out_at: null, last_message_at: new Date(Date.UTC(2026, 9, 1) - (i % 7) * 1000).toISOString() });
  tables.bookings.push({ id: `b-${pad(i)}-1`, business_id: 'big', customer_id: id, status: 'confirmed', fare_amount: 100 });
  tables.bookings.push({ id: `b-${pad(i)}-2`, business_id: 'big', customer_id: id, status: i < 1500 ? 'completed' : 'cancelled', fare_amount: 100 });
}

const call = async (handler, query) => {
  let body;
  let failure;
  const res = { status: () => res, json: (b) => { body = b; return res; } };
  await handler({ query, user: { businessId: 'big' } }, res, (err) => { failure = err; });
  if (failure) throw failure;
  return body;
};

test('summary: VIPs counted over every confirmed booking (4,000 rows), not the first 1000', async () => {
  const body = await call(getCustomerSummary, {});
  assert.equal(body.data.total, 2500);
  assert.equal(body.data.vip, 1500);
});

test('list ?isVip=true: VIPs found among all 2,500 customers, each once, paginated in memory', async () => {
  const first = await call(getCustomers, { isVip: 'true', page: '1', limit: '20' });
  assert.equal(first.data.pagination.total, 1500);
  assert.equal(first.data.customers.length, 20);
  assert.ok(first.data.customers.every(c => c.isVip));

  const seen = new Set();
  for (let page = 1; page <= 15; page += 1) {
    const body = await call(getCustomers, { isVip: 'true', page: String(page), limit: '100' });
    for (const c of body.data.customers) seen.add(c.id);
  }
  assert.equal(seen.size, 1500); // tied last_message_at values didn't make pages overlap
});

test('list without isVip: still one ranged page with the exact total', async () => {
  const body = await call(getCustomers, { page: '2', limit: '20' });
  assert.equal(body.data.customers.length, 20);
  assert.equal(body.data.pagination.total, 2500);
});
