// Run: node --test src/services/broadcastAudience.resolve.test.js
// resolveAudience against an in-memory stand-in for the customers and
// bookings tables (eq / neq / in, including the 'fields->>course' JSON path).
// Like PostgREST on the hosted project, every response is capped at
// MAX_ROWS rows (after .range()), so an un-paged read silently loses rows.
const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_ROWS = 1000;
const requests = []; // { table, filters: [description] } per request, for the "every page" checks
const inSizes = [];  // { table, c, n } per in() call, for the URL-length checks

const tables = {
  customers: [
    { id: 'c1', business_id: 'b', whatsapp_number: '919000000001', name: 'Asha', opted_in: true, is_blocked: false },
    { id: 'c2', business_id: 'b', whatsapp_number: '919000000002', name: 'Ravi', opted_in: true, is_blocked: false },
    { id: 'c3', business_id: 'b', whatsapp_number: '919000000003', name: 'Meena', opted_in: false, is_blocked: false }, // not opted in
    { id: 'c4', business_id: 'b', whatsapp_number: '919000000004', name: 'Kiran', opted_in: true, is_blocked: true },   // blocked
    { id: 'c5', business_id: 'b', whatsapp_number: '919000000005', name: 'Neha', opted_in: true, is_blocked: false },   // no request
    { id: 'c6', business_id: 'b', whatsapp_number: '919000000007', name: 'Sunil', opted_in: true, is_blocked: false, opted_out_at: '2026-10-01T10:00:00Z' }, // sent STOP
    { id: 'x1', business_id: 'other', whatsapp_number: '919000000006', name: 'Other', opted_in: true, is_blocked: false }
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
    in: (c, vs) => { inSizes.push({ table, c, n: vs.length }); return add(`in ${c}`, r => vs.includes(valueOf(r, c))); },
    gte: (c, v) => add(`gte ${c}`, r => valueOf(r, c) !== null && valueOf(r, c) !== undefined && valueOf(r, c) >= v),
    // Only the tags form of or(): tags.cs."<json>" conditions joined by commas (jsonb @>).
    or: (expr) => {
      const conds = [...expr.matchAll(/tags\.cs\."((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(m[1].replace(/\\(["\\])/g, '$1')));
      assert.ok(conds.length > 0, `or() form this fake doesn't read: ${expr}`);
      return add('or tags', r => conds.some(cd => Array.isArray(r.tags) && cd.every(t => r.tags.includes(t))));
    },
    // PostgREST `is null`: a missing column reads as null, like a row from before the column existed.
    is: (c, v) => add(`is ${c} ${v}`, r => (valueOf(r, c) ?? null) === v),
    order: (c, { ascending = true } = {}) => { orders.push({ c, ascending }); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    maybeSingle: async () => ({ data: (tables[table] || []).find(r => filters.every(f => f(r))) || null, error: null }),
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
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query, rpc: (...args) => rpc(...args) } };
const { resolveAudience, normalizeAudience, audienceSummary, audienceSkipped, requiresMarketingOptIn, templateCategory, SKIP_REASONS } = require('./broadcastAudience.service');

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
  const c = { id: `big-${pad(i)}`, business_id: 'big', whatsapp_number: `9199${pad(i)}`, name: `C${i}`, opted_in: true, is_blocked: false };
  bigEligible.push(c);
  tables.customers.push(c);
  tables.bookings.push({ id: `bk-${pad(i)}`, customer_id: c.id, business_id: 'big', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } });
  if (i % 3 === 0) {
    tables.customers.push({ id: `big-${pad(i)}-x`, business_id: 'big', whatsapp_number: `9299${pad(i)}`, name: `X${i}`, ...[
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
    assert.deepEqual(p.filters, ['eq business_id big', 'eq opted_in true', 'is marketing_blocked_at null', 'eq is_blocked false', 'is opted_out_at null']);
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

// ── Valid numbers, 'customers' and 'segment' ──
const DAYS = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAYS).toISOString();
const seg = (id, over = {}) => ({
  id, business_id: 'seg', whatsapp_number: `9190000${id.slice(1).padStart(5, '0')}`, name: `N-${id}`,
  opted_in: true, is_blocked: false, opted_out_at: null, tags: [], pipeline_stage: 'new', last_message_at: ago(1), ...over
});
tables.customers.push(
  seg('s1', { tags: ['vip'], last_message_at: ago(2) }),
  seg('s2', { tags: ['diwali'], pipeline_stage: 'contacted', last_message_at: ago(10) }),
  seg('s3', { tags: ['vip', 'diwali'], pipeline_stage: 'converted', last_message_at: ago(40) }),
  seg('s4', { last_message_at: null }),                                   // imported, never messaged
  seg('s5', { tags: ['vip'], opted_in: false }),                          // not opted in
  seg('s6', { tags: ['vip'], is_blocked: true }),                         // blocked
  seg('s7', { tags: ['vip'], opted_out_at: '2026-10-01T10:00:00Z' }),     // sent STOP
  seg('s8', { tags: ['vip'], whatsapp_number: '12345' }),                 // too short
  seg('s9', { tags: ['vip'], whatsapp_number: '9190000000123456789' }),   // too long (19)
  seg('s10', { tags: ['vip'], whatsapp_number: '+919000000010' }),        // not digits only
  seg('s11', { tags: ['vip'], whatsapp_number: '91 90000 00011' }),       // has spaces
  seg('s12', { tags: ['a,b', 'say "hi"'] }),
  seg('s13', { tags: ['vip'], whatsapp_number: '12345678' }),             // exactly 8 digits: valid
  seg('s14', { tags: ['vip'], whatsapp_number: '123456789012345' }),      // exactly 15 digits: valid
  seg('s15', { tags: ['vip'], whatsapp_number: null })                    // no number
);
// 'customers' fixtures use readable ids, not UUIDs, so they skip normalizeAudience (its uuid check is tested in broadcastAudience.service.test.js).
const segIds = async (filter, params) => {
  const a = filter === 'customers' ? { filter, params } : normalizeAudience(filter, params);
  assert.ok(!a.error, a.error);
  return (await resolveAudience('seg', a.filter, a.params)).map(c => c.id).sort();
};
const SEG_ALL_VALID = ['s1', 's12', 's13', 's14', 's2', 's3', 's4'];

test('numbers: an audience drops customers whose number is not 8-15 digits (every type)', async () => {
  // all_customers: only the invalid-number customers are gone; every other eligible customer is still there.
  assert.deepEqual(await segIds('all_customers'), SEG_ALL_VALID);
  const everyone = tables.customers.filter(c => c.business_id === 'seg').map(c => c.id);
  assert.deepEqual(await segIds('customers', { customerIds: everyone }), SEG_ALL_VALID);
  assert.deepEqual(await segIds('segment', { tags: ['vip'] }), ['s1', 's13', 's14', 's3']);
  const G = 'aaaaaaaa-0000-4000-8000-0000000000c1';
  tables.contact_groups.push({ id: G, business_id: 'seg', name: 'All' });
  for (const id of everyone) tables.contact_group_members.push({ group_id: G, customer_id: id });
  assert.deepEqual(await segIds('groups', { groupIds: [G] }), SEG_ALL_VALID);
});

test('numbers: an audience that already had only valid numbers is unchanged', async () => {
  assert.deepEqual(await names('all_customers'), ['Asha', 'Neha', 'Ravi']);
});

test("customers: the chosen ones only — opted-in / not blocked / not opted out, this business's, each once", async () => {
  assert.deepEqual(await segIds('customers', { customerIds: ['s1', 's2', 's5', 's6', 's7'] }), ['s1', 's2']);
  assert.deepEqual(await segIds('customers', { customerIds: ['s1', 's1', 's1'] }), ['s1']);
  // ids of another business (c1 is business 'b') add nobody
  assert.deepEqual(await segIds('customers', { customerIds: ['c1', 'c2', 's3'] }), ['s3']);
});

test('customers: 2,000 ids are read in small chunks (URL length) and all resolve', async () => {
  for (let i = 0; i < 2000; i += 1) {
    tables.customers.push({ id: `cap-${pad(i)}`, business_id: 'cap', whatsapp_number: `9188${pad(i)}`, name: `K${i}`, opted_in: true, is_blocked: false });
  }
  const ids = Array.from({ length: 2000 }, (_, i) => `cap-${pad(i)}`);
  inSizes.length = 0;
  const got = await resolveAudience('cap', 'customers', { customerIds: ids });
  assert.equal(got.length, 2000);
  assert.equal(new Set(got.map(c => c.id)).size, 2000);
  const sizes = inSizes.filter(x => x.table === 'customers' && x.c === 'id').map(x => x.n);
  assert.equal(sizes.length, 10);
  assert.ok(sizes.every(n => n <= 200), `an in() filter was ${Math.max(...sizes)} ids long`);
});

test('segment: tags match ANY, exactly', async () => {
  assert.deepEqual(await segIds('segment', { tags: ['diwali'] }), ['s2', 's3']);
  assert.deepEqual(await segIds('segment', { tags: ['diwali', 'vip'] }), ['s1', 's13', 's14', 's2', 's3']);
  assert.deepEqual(await segIds('segment', { tags: ['VIP'] }), []);
  assert.deepEqual(await segIds('segment', { tags: ['vi'] }), []);
  assert.deepEqual(await segIds('segment', { tags: ['a,b'] }), ['s12']);
  assert.deepEqual(await segIds('segment', { tags: ['say "hi"'] }), ['s12']);
});

test('segment: pipeline stages (any of), last message within N days, never messaged', async () => {
  assert.deepEqual(await segIds('segment', { pipelineStages: ['contacted', 'converted'] }), ['s2', 's3']);
  assert.deepEqual(await segIds('segment', { activeWithinDays: 7 }), ['s1', 's12', 's13', 's14']);
  assert.deepEqual(await segIds('segment', { activeWithinDays: 30 }), ['s1', 's12', 's13', 's14', 's2']);
  assert.deepEqual(await segIds('segment', { neverMessaged: true }), ['s4']);
});

test('segment: filters combine with AND; same opt-in / STOP / blocked rules as every audience', async () => {
  assert.deepEqual(await segIds('segment', { tags: ['vip'], activeWithinDays: 7 }), ['s1', 's13', 's14']);
  assert.deepEqual(await segIds('segment', { tags: ['vip'], pipelineStages: ['converted'] }), ['s3']);
  // s5 (not opted in), s6 (blocked), s7 (STOP) all carry the vip tag and are never reached
  const vip = await segIds('segment', { tags: ['vip'] });
  for (const id of ['s5', 's6', 's7']) assert.ok(!vip.includes(id), id);
});

test('segment: applies every filter on every page (3,000 matching customers)', async () => {
  for (let i = 0; i < 3000; i += 1) {
    tables.customers.push({ id: `sg-${pad(i)}`, business_id: 'sg', whatsapp_number: `9177${pad(i)}`, name: `G${i}`, opted_in: true, is_blocked: false,
      tags: ['promo'], pipeline_stage: 'new', last_message_at: ago(1) });
  }
  const a = normalizeAudience('segment', { tags: ['promo'], pipelineStages: ['new'], activeWithinDays: 5 });
  requests.length = 0;
  const got = await resolveAudience('sg', a.filter, a.params);
  assert.equal(got.length, 3000);
  const pages = requests.filter(r => r.table === 'customers');
  assert.equal(pages.length, 4); // 1000 x3 + an empty last page
  for (const p of pages) {
    assert.deepEqual(p.filters, ['eq business_id sg', 'eq opted_in true', 'is marketing_blocked_at null', 'eq is_blocked false', 'is opted_out_at null', 'or tags', 'in pipeline_stage', 'gte last_message_at']);
  }
});

// ── Parity with the SQL functions (mocked) ──
// sqlModel is the rules of broadcast_audience (20261007120000_broadcast_audience_builder.sql)
// written out in JS over the same in-memory tables: who an audience selects, and the
// first reason each is skipped for. This checks the SERVICE side (summary / skipped
// list plumbing, masking, paging) and that the documented rules agree with
// resolveAudience on these fixtures. The real SQL is compared against the real
// database by scripts/checkAudienceParity.js.
const reasonOf = (c, requireOptIn = true) => {
  if (typeof c.whatsapp_number !== 'string' || !/^[0-9]{8,15}$/.test(c.whatsapp_number)) return 'no_number';
  if (c.is_blocked !== false) return 'blocked';
  if (c.opted_out_at) return 'opted_out';
  if (requireOptIn && c.marketing_blocked_at) return 'marketing_stopped';
  if (requireOptIn && c.opted_in !== true) return 'not_opted_in';
  return null;
};
const selects = (businessId, c, filter, p) => {
  switch (filter) {
    case 'all_customers': return true;
    case 'customers': return p.customerIds.includes(c.id);
    case 'groups': {
      const mine = tables.contact_groups.filter(g => g.business_id === businessId && p.groupIds.includes(g.id)).map(g => g.id);
      return tables.contact_group_members.some(m => m.customer_id === c.id && mine.includes(m.group_id));
    }
    case 'coaching_requests': return tables.bookings.some(b => b.business_id === businessId && b.customer_id === c.id
      && (p.form === 'any' ? ['demo', 'admission'].includes(b.form_key) : b.form_key === p.form)
      && (!p.course || (b.fields || {}).course === p.course)
      && (!p.skipClosed || (b.status !== null && b.status !== 'cancelled')));
    case 'segment': return (!p.tags || p.tags.some(t => (c.tags || []).includes(t)))
      && (!p.pipelineStages || p.pipelineStages.includes(c.pipeline_stage))
      && (!p.activeWithinDays || (c.last_message_at && new Date(c.last_message_at).getTime() >= Date.now() - p.activeWithinDays * DAYS))
      && (!p.neverMessaged || !c.last_message_at);
    default: return false;
  }
};
const sqlModel = (businessId, filter, params, requireOptIn = true) => tables.customers
  .filter(c => c.business_id === businessId && selects(businessId, c, filter, params || {}))
  .map(c => ({ customer_id: c.id, whatsapp_number: c.whatsapp_number, name: c.name, skip_reason: reasonOf(c, requireOptIn) }));

const rpcCalls = [];
const rpc = (name, args, opts = {}) => {
  rpcCalls.push({ name, args, opts });
  let rows = sqlModel(args.p_business_id, args.p_filter, args.p_params, args.p_require_opt_in);
  if (name === 'broadcast_audience_summary') {
    const n = (r) => rows.filter(x => x.skip_reason === r).length;
    return Promise.resolve({ data: { selected: rows.length, willReceive: rows.filter(x => !x.skip_reason).length, skipped: { no_number: n('no_number'), blocked: n('blocked'), opted_out: n('opted_out'), marketing_stopped: n('marketing_stopped'), not_opted_in: n('not_opted_in') } }, error: null });
  }
  const orders = [];
  let range = null;
  const q = {
    eq: (c, v) => { rows = rows.filter(r => r[c] === v); return q; },
    not: (c, op, v) => { assert.equal(op, 'is'); rows = rows.filter(r => (r[c] ?? null) !== v); return q; },
    order: (c, o = {}) => { orders.push({ c, ascending: o.ascending !== false, nullsFirst: !!o.nullsFirst }); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    then: (resolve) => {
      const count = opts.count === 'exact' ? rows.length : null;
      let out = [...rows];
      for (const { c, ascending, nullsFirst } of [...orders].reverse()) {
        out.sort((a, b) => {
          const an = a[c] === null || a[c] === undefined; const bn = b[c] === null || b[c] === undefined;
          if (an || bn) return an === bn ? 0 : (an ? -1 : 1) * (nullsFirst ? 1 : -1);
          return (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      resolve({ data: out.slice(0, MAX_ROWS), count, error: null });
    }
  };
  return q;
};

const G_ALL = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const PARITY_CASES = [
  ['b', 'all_customers', null],
  ['b', 'coaching_requests', { form: 'any', course: null, skipClosed: true }],
  ['b', 'coaching_requests', { form: 'demo', course: 'Abacus', skipClosed: false }],
  ['b', 'groups', { groupIds: ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000ff'] }],
  ['b', 'customers', { customerIds: ['c1', 'c3', 'c4', 'c6', 'x1', 'nope'] }],
  ['seg', 'all_customers', null],
  ['seg', 'groups', { groupIds: [G_ALL] }],
  ['seg', 'customers', { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) }],
  ['seg', 'segment', { tags: ['vip'] }],
  ['seg', 'segment', { tags: ['vip', 'diwali'], pipelineStages: ['new', 'converted'] }],
  ['seg', 'segment', { pipelineStages: ['contacted'], activeWithinDays: 30 }],
  ['seg', 'segment', { neverMessaged: true }],
  ['seg', 'segment', { activeWithinDays: 7 }],
  ['seg', 'segment', { tags: ['a,b'] }]
];

test('parity: for every audience type, the SQL rules\' willReceive ids = resolveAudience ids', async () => {
  for (const [businessId, filter, params] of PARITY_CASES) {
    const a = filter === 'customers' ? { filter, params } : normalizeAudience(filter, params);
    assert.ok(!a.error, a.error);
    const resolved = (await resolveAudience(businessId, a.filter, a.params)).map(c => c.id).sort();
    const viaSql = sqlModel(businessId, a.filter, a.params).filter(r => !r.skip_reason).map(r => r.customer_id).sort();
    assert.deepEqual(viaSql, resolved, `${businessId} ${filter} ${JSON.stringify(params).slice(0, 60)}`);
  }
});

test('summary: counts by skip reason, nothing double counted (selected = willReceive + skipped)', async () => {
  const everyone = { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) };
  const s = await audienceSummary('seg', 'customers', everyone);
  // s1-s4, s12-s14 receive; s5 not opted in; s6 blocked; s7 STOP; s8-s11 + s15 no valid number
  assert.deepEqual(s, { selected: 15, willReceive: 7, skipped: { no_number: 5, blocked: 1, opted_out: 1, marketing_stopped: 0, not_opted_in: 1 } });
  assert.equal(s.willReceive + Object.values(s.skipped).reduce((x, y) => x + y, 0), s.selected);
});

test('summary: one reason per customer, in the order no_number > blocked > opted_out > not_opted_in', async () => {
  tables.customers.push(
    { id: 'm1', business_id: 'multi', whatsapp_number: '123', name: 'M1', opted_in: false, is_blocked: true, opted_out_at: '2026-10-01T00:00:00Z' }, // all four -> no_number
    { id: 'm2', business_id: 'multi', whatsapp_number: '919000000022', name: 'M2', opted_in: false, is_blocked: true, opted_out_at: '2026-10-01T00:00:00Z' }, // -> blocked
    { id: 'm3', business_id: 'multi', whatsapp_number: '919000000023', name: 'M3', opted_in: false, is_blocked: false, opted_out_at: '2026-10-01T00:00:00Z' }, // -> opted_out
    { id: 'm4', business_id: 'multi', whatsapp_number: '919000000024', name: 'M4', opted_in: false, is_blocked: false, opted_out_at: null }                       // -> not_opted_in
  );
  assert.deepEqual(await audienceSummary('multi', 'all_customers', null),
    { selected: 4, willReceive: 0, skipped: { no_number: 1, blocked: 1, opted_out: 1, marketing_stopped: 0, not_opted_in: 1 } });
});

test('summary: reasons with no one still appear as 0; an empty audience is all zeros', async () => {
  assert.deepEqual(await audienceSummary('seg', 'segment', { tags: ['diwali'] }),
    { selected: 2, willReceive: 2, skipped: { no_number: 0, blocked: 0, opted_out: 0, marketing_stopped: 0, not_opted_in: 0 } });
  assert.deepEqual(await audienceSummary('seg', 'segment', { tags: ['none-has-this'] }),
    { selected: 0, willReceive: 0, skipped: { no_number: 0, blocked: 0, opted_out: 0, marketing_stopped: 0, not_opted_in: 0 } });
});

test('summary: asks the SQL function for this business, filter and params', async () => {
  rpcCalls.length = 0;
  await audienceSummary('seg', 'segment', { neverMessaged: true });
  assert.deepEqual(rpcCalls, [{ name: 'broadcast_audience_summary', args: { p_business_id: 'seg', p_filter: 'segment', p_params: { neverMessaged: true }, p_require_opt_in: true }, opts: {} }]);
  rpcCalls.length = 0;
  await audienceSummary('seg', 'all_customers', null);
  assert.deepEqual(rpcCalls[0].args.p_params, {}); // null params go as an empty object
});

test('skipped: only the skipped customers, numbers masked, with the reason', async () => {
  const everyone = { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) };
  const { items, total } = await audienceSkipped('seg', 'customers', everyone);
  assert.equal(total, 8);
  assert.deepEqual(items.map(i => i.customerId).sort(), ['s10', 's11', 's15', 's5', 's6', 's7', 's8', 's9'].sort());
  const byId = Object.fromEntries(items.map(i => [i.customerId, i]));
  assert.equal(byId.s5.reason, 'not_opted_in');
  assert.equal(byId.s6.reason, 'blocked');
  assert.equal(byId.s7.reason, 'opted_out');
  assert.equal(byId.s8.reason, 'no_number');
  assert.deepEqual(Object.keys(byId.s5).sort(), ['customerId', 'name', 'number', 'reason']);
  // 919000005 5 → "91" + stars + last four; the full number never leaves
  assert.equal(byId.s5.number, '91******0005');
  assert.ok(!items.some(i => /[0-9]{7,}/.test(i.number)), 'a number was not masked');
  assert.equal(byId.s15.number, ''); // no number at all
});

test('skipped: a reason filter returns that reason only, and total counts just those', async () => {
  const everyone = { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) };
  for (const [reason, n] of [['no_number', 5], ['blocked', 1], ['opted_out', 1], ['not_opted_in', 1]]) {
    const r = await audienceSkipped('seg', 'customers', everyone, { reason });
    assert.equal(r.total, n, reason);
    assert.ok(r.items.every(i => i.reason === reason), reason);
  }
  assert.deepEqual(SKIP_REASONS, ['no_number', 'blocked', 'opted_out', 'marketing_stopped', 'not_opted_in']);
});

test('skipped: paged A→Z by name (no name last), pages never overlap and cover everything', async () => {
  for (let i = 0; i < 130; i += 1) {
    tables.customers.push({ id: `pg-${pad(i)}`, business_id: 'paged', whatsapp_number: '1', name: i === 129 ? null : `P${pad(i)}`, opted_in: false, is_blocked: false });
  }
  const seen = [];
  for (let page = 1; page <= 3; page += 1) {
    const r = await audienceSkipped('paged', 'all_customers', null, { page, limit: 50 });
    assert.equal(r.total, 130);
    assert.equal(r.items.length, page === 3 ? 30 : 50);
    seen.push(...r.items.map(i => i.customerId));
  }
  assert.equal(new Set(seen).size, 130);
  assert.deepEqual(seen.slice(0, 3), ['pg-00000', 'pg-00001', 'pg-00002']);
  assert.equal(seen[129], 'pg-00129'); // the customer without a name is last
  assert.equal((await audienceSkipped('paged', 'all_customers', null, { page: 4, limit: 50 })).items.length, 0);
});

test('skipped: nobody skipped → empty list', async () => {
  assert.deepEqual(await audienceSkipped('seg', 'segment', { tags: ['diwali'] }), { items: [], total: 0 });
});

// ── UTILITY templates: opted_in is not required ──
// Fixture business 'b': Asha, Ravi, Neha opted in; Meena NOT opted in; Kiran blocked; Sunil sent STOP.

test('requiresMarketingOptIn: false ONLY for utility (any case); everything else is strict', () => {
  for (const c of ['UTILITY', 'utility', 'Utility', ' UTILITY ']) assert.equal(requiresMarketingOptIn(c), false, c);
  for (const c of ['MARKETING', 'marketing', 'AUTHENTICATION', 'authentication', 'SERVICE', '', null, undefined, 5, {}, 'UTILITY_PLUS', 'non-utility']) {
    assert.equal(requiresMarketingOptIn(c), true, String(c));
  }
});

test('UTILITY: a customer who is not opted in is included; opted-out, blocked and bad numbers still are not', async () => {
  const a = normalizeAudience('all_customers');
  const got = (await resolveAudience('b', a.filter, a.params, { category: 'UTILITY' })).map(c => c.name).sort();
  assert.deepEqual(got, ['Asha', 'Meena', 'Neha', 'Ravi']); // + Meena (not opted in); not Kiran (blocked) or Sunil (STOP)
  tables.customers.push({ id: 'u1', business_id: 'util', whatsapp_number: '12', name: 'BadNumber', opted_in: false, is_blocked: false });
  assert.deepEqual(await resolveAudience('util', 'all_customers', null, { category: 'utility' }), []);
});

test('UTILITY: the same holds for groups, requests, picked customers and segments', async () => {
  const GROUPS = { groupIds: ['aaaaaaaa-0000-4000-8000-000000000001'] };
  const util = async (filter, params) => (await resolveAudience('b', filter, params, { category: 'UTILITY' })).map(c => c.name).sort();
  assert.deepEqual(await util('groups', GROUPS), ['Asha', 'Meena']); // c3 is in; c4 blocked and c6 STOP are not
  assert.deepEqual(await util('coaching_requests', { form: 'any', course: null, skipClosed: true }), ['Asha', 'Meena']);
  assert.deepEqual(await util('customers', { customerIds: ['c1', 'c3', 'c4', 'c6', 'x1'] }), ['Asha', 'Meena']); // x1 is another business's
  const seg = (await resolveAudience('seg', 'segment', { tags: ['vip'] }, { category: 'UTILITY' })).map(c => c.id);
  const strict = (await resolveAudience('seg', 'segment', { tags: ['vip'] })).map(c => c.id);
  assert.ok(seg.includes('s5') && !strict.includes('s5')); // s5: vip, not opted in
  assert.ok(!seg.includes('s6') && !seg.includes('s7')); // blocked / STOP stay out
});

test('MARKETING, AUTHENTICATION, no category and unknown categories keep the opted-in rule (the exact same filters)', async () => {
  for (const options of [undefined, {}, { category: null }, { category: 'MARKETING' }, { category: 'marketing' }, { category: 'AUTHENTICATION' }, { category: 'SERVICE' }, { category: 7 }]) {
    requests.length = 0;
    const got = (await resolveAudience('b', 'all_customers', null, options)).map(c => c.name).sort();
    assert.deepEqual(got, ['Asha', 'Neha', 'Ravi'], JSON.stringify(options));
    assert.deepEqual(requests[0].filters, ['eq business_id b', 'eq opted_in true', 'is marketing_blocked_at null', 'eq is_blocked false', 'is opted_out_at null'], JSON.stringify(options));
  }
});

test('UTILITY: no opted_in filter is sent, on every page', async () => {
  requests.length = 0;
  await resolveAudience('big', 'all_customers', null, { category: 'UTILITY' });
  assert.ok(requests.length >= 2);
  for (const r of requests) assert.deepEqual(r.filters.slice(0, 3), ['eq business_id big', 'eq is_blocked false', 'is opted_out_at null']);
  assert.ok(requests.every(r => !r.filters.includes('eq opted_in true')));
});

test('parity (mocked): UTILITY willReceive ids = resolveAudience ids for every audience type', async () => {
  for (const [businessId, filter, params] of PARITY_CASES) {
    const a = filter === 'customers' ? { filter, params } : normalizeAudience(filter, params);
    const resolved = (await resolveAudience(businessId, a.filter, a.params, { category: 'UTILITY' })).map(c => c.id).sort();
    const viaSql = sqlModel(businessId, a.filter, a.params, false).filter(r => !r.skip_reason).map(r => r.customer_id).sort();
    assert.deepEqual(viaSql, resolved, `${businessId} ${filter}`);
  }
});

test('summary: UTILITY asks for no opt-in and never reports not_opted_in', async () => {
  const everyone = { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) };
  rpcCalls.length = 0;
  const s = await audienceSummary('seg', 'customers', everyone, { category: 'UTILITY' });
  assert.equal(rpcCalls[0].args.p_require_opt_in, false);
  assert.equal(s.skipped.not_opted_in, 0);
  // s5 (not opted in) now receives: 7 + 1; blocked, STOP and the five bad numbers are still skipped
  assert.deepEqual(s, { selected: 15, willReceive: 8, skipped: { no_number: 5, blocked: 1, opted_out: 1, marketing_stopped: 0, not_opted_in: 0 } });
  rpcCalls.length = 0;
  for (const category of ['MARKETING', 'AUTHENTICATION', null, undefined, 'nope']) {
    await audienceSummary('seg', 'customers', everyone, { category });
    assert.equal(rpcCalls.at(-1).args.p_require_opt_in, true, String(category));
  }
});

test('skipped: UTILITY has no not_opted_in rows; blocked, opted_out and no_number are still listed', async () => {
  const everyone = { customerIds: tables.customers.filter(c => c.business_id === 'seg').map(c => c.id) };
  rpcCalls.length = 0;
  const all = await audienceSkipped('seg', 'customers', everyone, { category: 'UTILITY' });
  assert.equal(rpcCalls[0].args.p_require_opt_in, false);
  assert.equal(all.total, 7);
  assert.ok(!all.items.some(i => i.reason === 'not_opted_in' || i.customerId === 's5'));
  assert.deepEqual([...new Set(all.items.map(i => i.reason))].sort(), ['blocked', 'no_number', 'opted_out']);
  assert.equal((await audienceSkipped('seg', 'customers', everyone, { category: 'UTILITY', reason: 'not_opted_in' })).total, 0);
  assert.equal((await audienceSkipped('seg', 'customers', everyone, { reason: 'not_opted_in' })).total, 1); // marketing unchanged
});

// ── templateCategory: the stored category, scoped to the business ──

test("templateCategory: only an id that is this business's template gives a category; otherwise null", async () => {
  const T_OWN = 'bbbbbbbb-0000-4000-8000-000000000001';
  const T_OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
  tables.message_templates = [
    { id: T_OWN, business_id: 'b', category: 'UTILITY' },
    { id: T_OTHER, business_id: 'other', category: 'UTILITY' }
  ];
  assert.equal(await templateCategory('b', T_OWN), 'UTILITY');
  assert.equal(await templateCategory('b', T_OTHER), null); // another business's template
  assert.equal(await templateCategory('b', 'bbbbbbbb-0000-4000-8000-0000000000ff'), null); // not found
  for (const bad of [undefined, null, '', 'not-a-uuid', 5, {}]) assert.equal(await templateCategory('b', bad), null, String(bad));
});
