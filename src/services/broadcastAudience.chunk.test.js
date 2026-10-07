// Run: node --test src/services/broadcastAudience.chunk.test.js
// An audience read by customer id (groups, coaching requests) asks PostgREST
// for those ids in `in (...)` filters, which travel in the URL. On the hosted
// project 350 UUIDs work and 400 fail ("fetch failed", measured 2026-10-07),
// so no single filter may carry more than 200: an audience of 450 must go out
// as several requests and still resolve to all 450.
const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_ROWS = 1000;
const inSizes = []; // ids per in() filter, per request
const pad = (n) => String(n).padStart(5, '0');

const tables = { customers: [], bookings: [], contact_groups: [], contact_group_members: [] };
const G = 'aaaaaaaa-0000-4000-8000-0000000000d1';
tables.contact_groups.push({ id: G, business_id: 'c', name: 'Everyone' });
for (let i = 0; i < 450; i += 1) {
  const id = `chunk-${pad(i)}`;
  tables.customers.push({ id, business_id: 'c', whatsapp_number: `9188${pad(i)}`, name: `K${i}`, opted_in: true, is_blocked: false });
  tables.contact_group_members.push({ group_id: G, customer_id: id });
  tables.bookings.push({ id: `bk-${pad(i)}`, customer_id: id, business_id: 'c', form_key: 'demo', status: 'pending', fields: {} });
}

const valueOf = (row, col) => {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  return m ? (row[m[1]] || {})[m[2]] : row[col];
};
const query = (table) => {
  const filters = [];
  const orders = [];
  let range = null;
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => valueOf(r, c) === v); return q; },
    neq: (c, v) => { filters.push(r => valueOf(r, c) !== v); return q; },
    in: (c, vs) => { inSizes.push(vs.length); filters.push(r => vs.includes(valueOf(r, c))); return q; },
    is: (c, v) => { filters.push(r => (valueOf(r, c) ?? null) === v); return q; },
    order: (c) => { orders.push(c); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    then: (resolve) => {
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      for (const c of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      resolve({ data: rows.slice(0, MAX_ROWS), error: null });
    }
  };
  return q;
};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query } };
const { resolveAudience } = require('./broadcastAudience.service');

test('groups: 450 members resolve, every in() filter carries at most 200 ids', async () => {
  inSizes.length = 0;
  const got = await resolveAudience('c', 'groups', { groupIds: [G] });
  assert.equal(got.length, 450);
  assert.equal(new Set(got.map(c => c.id)).size, 450);
  assert.ok(Math.max(...inSizes) <= 200, `an in() filter carried ${Math.max(...inSizes)} ids`);
  assert.ok(inSizes.filter(n => n > 1).length >= 3, 'the 450 ids should go out in at least 3 requests');
});

test('coaching requests: 450 requesting parents resolve, every in() filter carries at most 200 ids', async () => {
  inSizes.length = 0;
  const got = await resolveAudience('c', 'coaching_requests', { form: 'any', course: null, skipClosed: true });
  assert.equal(got.length, 450);
  assert.equal(new Set(got.map(c => c.id)).size, 450);
  assert.ok(Math.max(...inSizes) <= 200, `an in() filter carried ${Math.max(...inSizes)} ids`);
});
