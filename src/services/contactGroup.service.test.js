// Run: node --test src/services/contactGroup.service.test.js
// Adding / removing up to MAX_MEMBERS_PER_CALL (500) customers, and reading the
// groups of a page of customers, look ids up with in() filters, which travel in
// the URL. On the hosted project 350 UUIDs work and 400 fail ("fetch failed",
// measured 2026-10-07), so no single filter may carry more than 200 ids — a
// request for 500 goes out as several lookups and still covers all 500.
const test = require('node:test');
const assert = require('node:assert/strict');

const inSizes = []; // ids per in() filter, per request
const pad = (n) => String(n).padStart(5, '0');
const uuid = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = 'aaaaaaaa-0000-4000-8000-0000000000e1';

const tables = {
  customers: [],
  contact_groups: [{ id: G, business_id: 'b', name: 'Diwali', created_at: 't', updated_at: 't' }],
  contact_group_members: []
};
for (let i = 0; i < 500; i += 1) tables.customers.push({ id: uuid(i), business_id: 'b' });
tables.customers.push({ id: uuid(9000), business_id: 'other' });

const query = (table) => {
  const filters = [];
  let op = null;
  let range = null;
  const matching = () => tables[table].filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op && op.type === 'upsert') {
      const added = op.rows.filter(r => !tables[table].some(x => x.group_id === r.group_id && x.customer_id === r.customer_id));
      tables[table].push(...added);
      return { data: added, error: null };
    }
    if (op && op.type === 'delete') {
      const gone = matching();
      tables[table] = tables[table].filter(r => !gone.includes(r));
      return { data: gone, error: null };
    }
    let rows = matching();
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows.slice(0, 1000), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { inSizes.push(vs.length); filters.push(r => vs.includes(r[c])); return q; },
    delete: () => { op = { type: 'delete' }; return q; },
    upsert: (rows) => { op = { type: 'upsert', rows }; return q; },
    order: () => q,
    range: (from, to) => { range = [from, to]; return q; },
    single: async () => {
      const { data } = run();
      const row = { ...data[0] };
      if (table === 'contact_groups') row.contact_group_members = [{ count: tables.contact_group_members.filter(m => m.group_id === row.id).length }];
      return { data: row, error: null };
    },
    maybeSingle: async () => ({ data: run().data[0] || null, error: null }),
    then: (resolve) => resolve(run())
  };
  return q;
};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query } };
const service = require('./contactGroup.service');

const members = () => tables.contact_group_members.filter(m => m.group_id === G).length;
const biggestIn = () => Math.max(...inSizes);

test.beforeEach(() => { inSizes.length = 0; tables.contact_group_members = []; });

test('addMembers: 500 customers (the per-request limit) are all checked and added; no in() carries more than 200 ids', async () => {
  const ids = tables.customers.filter(c => c.business_id === 'b').map(c => c.id);
  const res = await service.addMembers('b', G, { customerIds: ids });
  assert.equal(res.error, undefined);
  assert.equal(res.added, 500);
  assert.equal(members(), 500);
  assert.ok(biggestIn() <= 200, `an in() filter carried ${biggestIn()} ids`);
});

test("addMembers: a customer of another business among 450 is still caught (404, nothing added)", async () => {
  const ids = [...tables.customers.filter(c => c.business_id === 'b').slice(0, 449).map(c => c.id), uuid(9000)];
  const res = await service.addMembers('b', G, { customerIds: ids });
  assert.equal(res.status, 404);
  assert.match(res.error, /customers were not found/);
  assert.equal(members(), 0);
  assert.ok(biggestIn() <= 200);
});

test('addMembers: more than 500 per request is still refused', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => uuid(i));
  const res = await service.addMembers('b', G, { customerIds: ids });
  assert.equal(res.status, 400);
  assert.match(res.error, /At most 500 customers per request/);
});

test('removeMembers: 500 members are all removed (counted across lookups); no in() carries more than 200 ids', async () => {
  const ids = tables.customers.filter(c => c.business_id === 'b').map(c => c.id);
  tables.contact_group_members = ids.map(customer_id => ({ group_id: G, customer_id }));
  const res = await service.removeMembers('b', G, { customerIds: ids });
  assert.equal(res.error, undefined);
  assert.equal(res.removed, 500);
  assert.equal(members(), 0);
  assert.ok(biggestIn() <= 200, `an in() filter carried ${biggestIn()} ids`);
});

test('removeMembers: only the listed customers leave', async () => {
  const ids = tables.customers.filter(c => c.business_id === 'b').map(c => c.id);
  tables.contact_group_members = ids.map(customer_id => ({ group_id: G, customer_id }));
  const res = await service.removeMembers('b', G, { customerIds: ids.slice(0, 450) });
  assert.equal(res.removed, 450);
  assert.equal(members(), 50);
});

test('groupsByCustomer: 450 customers → each with its group; no in() carries more than 200 ids', async () => {
  const ids = tables.customers.filter(c => c.business_id === 'b').slice(0, 450).map(c => c.id);
  tables.contact_group_members = ids.map(customer_id => ({ group_id: G, customer_id }));
  const map = await service.groupsByCustomer('b', ids);
  assert.equal(map.size, 450);
  assert.deepEqual(map.get(ids[449]), [{ id: G, name: 'Diwali' }]);
  assert.ok(biggestIn() <= 200, `an in() filter carried ${biggestIn()} ids`);
});
