// Run: node --test src/services/broadcastAudience.resolve.test.js
// resolveAudience against an in-memory stand-in for the customers and
// bookings tables (eq / neq / in, including the 'fields->>course' JSON path).
// Like PostgREST on the hosted project, every response is capped at
// MAX_ROWS rows (after .range()), so an un-paged read silently loses rows.
const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_ROWS = 1000;
const requests = []; // { table, filters: [description] } per request, for the "every page" checks

const tables = {
  customers: [
    { id: 'c1', business_id: 'b', whatsapp_number: '911', name: 'Asha', opted_in: true, is_blocked: false },
    { id: 'c2', business_id: 'b', whatsapp_number: '912', name: 'Ravi', opted_in: true, is_blocked: false },
    { id: 'c3', business_id: 'b', whatsapp_number: '913', name: 'Meena', opted_in: false, is_blocked: false }, // not opted in
    { id: 'c4', business_id: 'b', whatsapp_number: '914', name: 'Kiran', opted_in: true, is_blocked: true },   // blocked
    { id: 'c5', business_id: 'b', whatsapp_number: '915', name: 'Neha', opted_in: true, is_blocked: false },   // no request
    { id: 'c6', business_id: 'b', whatsapp_number: '917', name: 'Sunil', opted_in: true, is_blocked: false, opted_out_at: '2026-10-01T10:00:00Z' }, // sent STOP
    { id: 'x1', business_id: 'other', whatsapp_number: '916', name: 'Other', opted_in: true, is_blocked: false }
  ],
  bookings: [
    { customer_id: 'c1', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c1', business_id: 'b', form_key: 'admission', status: 'pending', fields: { course: 'Abacus' } }, // same parent twice
    { customer_id: 'c2', business_id: 'b', form_key: 'demo', status: 'cancelled', fields: { course: 'Vedic Maths' } }, // "Not interested"
    { customer_id: 'c3', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c4', business_id: 'b', form_key: 'admission', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c5', business_id: 'b', form_key: null, status: 'pending', fields: {} },                         // chat booking
    { customer_id: 'c6', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },     // opted out
    { customer_id: 'x1', business_id: 'other', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } }
  ],
  // Groups (contact_groups / contact_group_members). g1 + g2 are business 'b''s;
  // gx belongs to another business and must never widen b's audience.
  contact_groups: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', business_id: 'b', name: 'Diwali' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', business_id: 'b', name: 'VIP' },
    { id: 'aaaaaaaa-0000-4000-8000-0000000000ff', business_id: 'other', name: 'Theirs' }
  ],
  contact_group_members: [
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000001', customer_id: 'c1' },
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000001', customer_id: 'c3' }, // not opted in
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000001', customer_id: 'c4' }, // blocked
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000001', customer_id: 'c6' }, // sent STOP
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000002', customer_id: 'c1' }, // in both groups
    { group_id: 'aaaaaaaa-0000-4000-8000-000000000002', customer_id: 'c5' },
    { group_id: 'aaaaaaaa-0000-4000-8000-0000000000ff', customer_id: 'c2' },
    { group_id: 'aaaaaaaa-0000-4000-8000-0000000000ff', customer_id: 'x1' }
  ]
};
const valueOf = (row, col) => {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  return m ? (row[m[1]] || {})[m[2]] : row[col];
};
const query = (table) => {
  const filters = [];
  const described = [];
  const orders = [];
  let range = null;
  const add = (desc, f) => { described.push(desc); filters.push(f); return q; };
  const q = {
    select: () => q,
    eq: (c, v) => add(`eq ${c} ${v}`, r => valueOf(r, c) === v),
    neq: (c, v) => add(`neq ${c} ${v}`, r => valueOf(r, c) !== v),
    in: (c, vs) => add(`in ${c}`, r => vs.includes(valueOf(r, c))),
    // PostgREST `is null`: a missing column reads as null, like a row from before the column existed.
    is: (c, v) => add(`is ${c} ${v}`, r => (valueOf(r, c) ?? null) === v),
    order: (c, { ascending = true } = {}) => { orders.push({ c, ascending }); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    then: (resolve) => {
      requests.push({ table, filters: described });
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      for (const { c, ascending } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (range) rows = rows.slice(range[0], range[1] + 1);
      resolve({ data: rows.slice(0, MAX_ROWS), error: null });
    }
  };
  return q;
};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query } };
const { resolveAudience, normalizeAudience } = require('./broadcastAudience.service');

const names = async (filter, params) => {
  const a = normalizeAudience(filter, params);
  return (await resolveAudience('b', a.filter, a.params)).map(c => c.name).sort();
};

test('all customers: every opted-in, non-blocked, not-opted-out customer of this business', async () => {
  assert.deepEqual(await names('all_customers'), ['Asha', 'Neha', 'Ravi']);
});

test('a customer who sent STOP (opted_out_at set) is left out of every audience', async () => {
  assert.ok(!(await names('all_customers')).includes('Sunil'));
  assert.ok(!(await names('coaching_requests', { form: 'demo' })).includes('Sunil'));
  assert.ok(!(await names('coaching_requests', { form: 'any', course: 'Abacus', skipClosed: false })).includes('Sunil'));
});

test('parents with a request: opted-in only, closed requests skipped, each parent once', async () => {
  assert.deepEqual(await names('coaching_requests', { form: 'any' }), ['Asha']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', skipClosed: false }), ['Asha', 'Ravi']);
});

test('form and course filters', async () => {
  assert.deepEqual(await names('coaching_requests', { form: 'admission' }), ['Asha']);
  assert.deepEqual(await names('coaching_requests', { form: 'demo', skipClosed: false }), ['Asha', 'Ravi']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', course: 'Vedic Maths', skipClosed: false }), ['Ravi']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', course: 'Chess' }), []);
});

// ── Past the 1000-row cap ──
// Business 'big': 2,500 eligible customers, with ineligible ones (not opted
// in / blocked / sent STOP) mixed in on every page, and 2,500 open demo
// requests plus closed ones.
const pad = (n) => String(n).padStart(5, '0');
const bigEligible = [];
for (let i = 0; i < 2500; i += 1) {
  const c = { id: `big-${pad(i)}`, business_id: 'big', whatsapp_number: `91${pad(i)}`, name: `C${i}`, opted_in: true, is_blocked: false };
  bigEligible.push(c);
  tables.customers.push(c);
  tables.bookings.push({ id: `bk-${pad(i)}`, customer_id: c.id, business_id: 'big', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } });
  if (i % 3 === 0) {
    tables.customers.push({ id: `big-${pad(i)}-x`, business_id: 'big', whatsapp_number: `92${pad(i)}`, name: `X${i}`, ...[
      { opted_in: false, is_blocked: false },
      { opted_in: true, is_blocked: true },
      { opted_in: true, is_blocked: false, opted_out_at: '2026-10-01T10:00:00Z' }
    ][i % 9 / 3] });
    tables.bookings.push({ id: `bk-${pad(i)}-x`, customer_id: `big-${pad(i)}-x`, business_id: 'big', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } });
  }
  if (i % 5 === 0) {
    // a closed request for the same parent — must not duplicate them
    tables.bookings.push({ id: `bk-${pad(i)}-c`, customer_id: c.id, business_id: 'big', form_key: 'admission', status: 'cancelled', fields: { course: 'Abacus' } });
  }
}

const bigIds = async (filter, params) => {
  const a = normalizeAudience(filter, params);
  return (await resolveAudience('big', a.filter, a.params)).map(c => c.id);
};

test('all customers: an audience of 2,500 resolves to all 2,500, each once', async () => {
  const ids = await bigIds('all_customers');
  assert.equal(ids.length, 2500);
  assert.equal(new Set(ids).size, 2500);
  assert.deepEqual([...ids].sort(), bigEligible.map(c => c.id).sort());
});

test('all customers: opted_in / not blocked / not opted out is applied on every page', async () => {
  requests.length = 0;
  await bigIds('all_customers');
  const pages = requests.filter(r => r.table === 'customers');
  assert.equal(pages.length, 3); // 1000 + 1000 + 500
  for (const p of pages) {
    assert.deepEqual(p.filters, ['eq business_id big', 'eq opted_in true', 'eq is_blocked false', 'is opted_out_at null']);
  }
});

test('coaching requests: 2,500 requesting parents (more than 1000 booking rows) all resolve', async () => {
  const ids = await bigIds('coaching_requests', { form: 'any', skipClosed: false });
  assert.equal(ids.length, 2500);
  assert.equal(new Set(ids).size, 2500);
  requests.length = 0;
  assert.equal((await bigIds('coaching_requests', { form: 'demo' })).length, 2500);
  for (const p of requests.filter(r => r.table === 'bookings')) {
    assert.deepEqual(p.filters, ['eq business_id big', 'in form_key', 'neq status cancelled']);
  }
});

test('an exact multiple of the page size still ends (short last page is empty)', async () => {
  const keep = tables.customers;
  tables.customers = keep.filter(c => c.business_id !== 'big' || c.id < `big-${pad(2000)}`);
  try {
    assert.equal((await bigIds('all_customers')).length, 2000);
  } finally {
    tables.customers = keep;
  }
});

// ── Groups ──
const G1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const G2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const GX = 'aaaaaaaa-0000-4000-8000-0000000000ff';

test('groups: members of the chosen groups, opted-in / not blocked / not opted out only, each once', async () => {
  assert.deepEqual(await names('groups', { groupIds: [G1] }), ['Asha']);
  assert.deepEqual(await names('groups', { groupIds: [G1, G2] }), ['Asha', 'Neha']);
});

test("groups: scoped by business — another business's group id adds nobody", async () => {
  assert.deepEqual(await names('groups', { groupIds: [GX] }), []);
  assert.deepEqual(await names('groups', { groupIds: [G2, GX] }), ['Asha', 'Neha']);
  const a = normalizeAudience('groups', { groupIds: [G1] });
  assert.deepEqual((await resolveAudience('other', a.filter, a.params)).map(c => c.name), []);
});

test('groups: a deleted group (no row) resolves to nobody', async () => {
  assert.deepEqual(await names('groups', { groupIds: ['aaaaaaaa-0000-4000-8000-0000000000aa'] }), []);
});

test('groups: more than 1000 members are all reached', async () => {
  const BIG = 'aaaaaaaa-0000-4000-8000-0000000000b1';
  tables.contact_groups.push({ id: BIG, business_id: 'big', name: 'Everyone' });
  for (const c of bigEligible) tables.contact_group_members.push({ group_id: BIG, customer_id: c.id });
  try {
    const ids = await bigIds('groups', { groupIds: [BIG] });
    assert.equal(ids.length, 2500);
    assert.equal(new Set(ids).size, 2500);
  } finally {
    tables.contact_group_members = tables.contact_group_members.filter(m => m.group_id !== BIG);
    tables.contact_groups = tables.contact_groups.filter(g => g.id !== BIG);
  }
});
