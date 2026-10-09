// Run: node --test src/controllers/customer.controller.test.js
// isBroadcastEligible must match broadcastAudience.service.js#resolveAudience.
// The VIP tests use an in-memory stand-in for customers / bookings / the
// customer_booking_stats RPC that, like PostgREST on the hosted project,
// caps every response at MAX_ROWS rows.
const test = require('node:test');
const assert = require('node:assert/strict');

const MAX_ROWS = 1000;
const tables = { customers: [], bookings: [], contact_group_members: [] };

const query = (table) => {
  const filters = [];
  const orders = [];
  let range = null;
  let head = false;
  let wantCount = false;
  const q = {
    select: (cols, opts = {}) => { head = !!opts.head; wantCount = opts.count === 'exact'; return q; },
    // 'contact_group_members.group_id' = the inner-embed filter (customers with a membership in that group)
    eq: (c, v) => {
      if (c === 'contact_group_members.group_id') {
        filters.push(r => tables.contact_group_members.some(m => m.customer_id === r.id && m.group_id === v));
      } else {
        filters.push(r => r[c] === v);
      }
      return q;
    },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    // .not(col, 'eq', '<json>') on a jsonb column; .not(col, 'is', null) = "is not null"
    not: (c, op, v) => {
      if (op === 'is') {
        assert.equal(v, null);
        filters.push(r => (r[c] ?? null) !== null);
        return q;
      }
      assert.equal(op, 'eq');
      filters.push(r => JSON.stringify(r[c] ?? null) !== JSON.stringify(JSON.parse(v)));
      return q;
    },
    // Only the tags form of or(): tags.cs."<json, with \" and \\ escaped>" conditions joined by commas
    // (jsonb @>: the row's tags contain every element of the condition's array).
    or: (expr) => {
      const conditions = [...expr.matchAll(/tags\.cs\."((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(m[1].replace(/\\(["\\])/g, '$1')));
      assert.ok(conditions.length > 0, `or() form this fake doesn't read: ${expr}`);
      filters.push(r => conditions.some(c => Array.isArray(r.tags) && c.every(t => r.tags.includes(t))));
      return q;
    },
    // Postgres: NULLs sort first in a descending order unless nullsFirst: false.
    order: (c, { ascending = true, nullsFirst = !ascending } = {}) => { orders.push({ c, ascending, nullsFirst }); return q; },
    range: (from, to) => { range = [from, to]; return q; },
    then: (resolve) => {
      let rows = tables[table].filter(r => filters.every(f => f(r)));
      const count = wantCount ? rows.length : null;
      for (const { c, ascending, nullsFirst } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const an = a[c] === null || a[c] === undefined;
          const bn = b[c] === null || b[c] === undefined;
          if (an || bn) return an === bn ? 0 : (an ? -1 : 1) * (nullsFirst ? 1 : -1);
          return (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1);
        });
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
const GROUP = 'aaaaaaaa-0000-4000-8000-000000000001';
stub('../services/contactGroup.service', {
  isUuid: (v) => /^[0-9a-f-]{36}$/i.test(String(v)),
  groupsByCustomer: async (businessId, ids) => new Map(ids.filter(id => tables.contact_group_members.some(m => m.customer_id === id))
    .map(id => [id, [{ id: GROUP, name: 'Diwali' }]]))
});
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { isBroadcastEligible, getCustomers, getCustomerSummary, getCustomerIds, getCustomerTags, MAX_CUSTOMER_IDS } = require('./customer.controller');

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

// ── Post-booking consent stats (business 'cons'): 4 asked (2 yes, 1 no, 1 unanswered), 1 never asked, 1 other business ──
const cons = (id, over = {}) => ({ id, business_id: 'cons', whatsapp_number: id, name: id, opted_in: false, is_blocked: false, opted_out_at: null, last_message_at: '2026-10-01T00:00:00Z', consent_prompted_at: null, consent_prompt_result: null, ...over });
tables.customers.push(
  cons('k1', { consent_prompted_at: '2026-10-02T00:00:00Z', consent_prompt_result: 'yes', opted_in: true }),
  cons('k2', { consent_prompted_at: '2026-10-02T00:00:00Z', consent_prompt_result: 'yes', opted_in: true }),
  cons('k3', { consent_prompted_at: '2026-10-02T00:00:00Z', consent_prompt_result: 'no' }),
  cons('k4', { consent_prompted_at: '2026-10-02T00:00:00Z' }),
  cons('k5'),
  { ...cons('k6'), business_id: 'other', consent_prompted_at: '2026-10-02T00:00:00Z', consent_prompt_result: 'yes' }
);

test('summary: consentAsked / consentYes / consentNo count this business only', async () => {
  let body;
  const res = { status: () => res, json: (b) => { body = b; return res; } };
  await getCustomerSummary({ query: {}, user: { businessId: 'cons' } }, res, (err) => { throw err; });
  assert.equal(body.data.total, 5);
  assert.equal(body.data.consentAsked, 4);
  assert.equal(body.data.consentYes, 2);
  assert.equal(body.data.consentNo, 1);
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

// ── Imported contacts (never messaged) + groups ──
// Business 'imp': 2 who messaged, 2 imported (last_message_at null), one in a group.
const imp = (id, lastMessageAt) => ({ id, business_id: 'imp', whatsapp_number: id, name: id, opted_in: false, is_blocked: false, opted_out_at: null, last_message_at: lastMessageAt });
tables.customers.push(imp('imported-1', null), imp('chat-old', '2026-09-01T00:00:00Z'), imp('imported-2', null), imp('chat-new', '2026-10-01T00:00:00Z'));
tables.contact_group_members.push({ group_id: GROUP, customer_id: 'imported-2' }, { group_id: GROUP, customer_id: 'chat-old' });

const callAs = async (handler, query, businessId) => {
  let body; let status;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
  await handler({ query, user: { businessId } }, res, (err) => { throw err; });
  return { status, body };
};

test('list: customers who never messaged sort last (not first, as a plain DESC would put NULLs)', async () => {
  const { body } = await callAs(getCustomers, {}, 'imp');
  assert.deepEqual(body.data.customers.map(c => c.id).slice(0, 2), ['chat-new', 'chat-old']);
  assert.deepEqual(body.data.customers.map(c => c.id).slice(2).sort(), ['imported-1', 'imported-2']);
});

test('list ?neverMessaged=true: only customers with no inbound message yet', async () => {
  const { body } = await callAs(getCustomers, { neverMessaged: 'true' }, 'imp');
  assert.deepEqual(body.data.customers.map(c => c.id).sort(), ['imported-1', 'imported-2']);
  assert.equal(body.data.pagination.total, 2);
  assert.equal(body.data.customers[0].windowExpiresAt, null); // no 24h window
});

test('list ?groupId=: members of that group only, each row with its groups', async () => {
  const { body } = await callAs(getCustomers, { groupId: GROUP }, 'imp');
  assert.deepEqual(body.data.customers.map(c => c.id), ['chat-old', 'imported-2']);
  assert.deepEqual(body.data.customers[0].groups, [{ id: GROUP, name: 'Diwali' }]);
  const all = await callAs(getCustomers, {}, 'imp');
  assert.deepEqual(all.body.data.customers.find(c => c.id === 'chat-new').groups, []);
  const both = await callAs(getCustomers, { groupId: GROUP, neverMessaged: 'true' }, 'imp');
  assert.deepEqual(both.body.data.customers.map(c => c.id), ['imported-2']);
});

test('list ?groupId=garbage: 400, not a database error', async () => {
  const { status, body } = await callAs(getCustomers, { groupId: 'nope' }, 'imp');
  assert.equal(status, 400);
  assert.match(body.message, /groupId must be a group id/);
});

// ── Tags filter, GET /ids, GET /tags ──
// Business 'tg': tags are free text; matching is ANY of the given tags, exact (case-sensitive).
const tg = (id, tags, over = {}) => ({ id, business_id: 'tg', whatsapp_number: id, name: id, opted_in: true, is_blocked: false, opted_out_at: null, pipeline_stage: 'new', last_message_at: '2026-10-01T00:00:00Z', tags, ...over });
tables.customers.push(
  tg('t1', ['vip']),
  tg('t2', ['diwali', 'vip'], { pipeline_stage: 'lost' }),
  tg('t3', ['diwali']),
  tg('t4', ['a,b']),
  tg('t5', ['say "hi"', 'x(y)']),
  tg('t6', []),
  tg('t7', ['VIP'], { last_message_at: null }),
  tg('o1', ['vip'], { business_id: 'other-tg' })
);
const idsOf = (res) => res.body.data.customers.map(c => c.id).sort();

test('list ?tags=: customers with that exact tag; other businesses never match', async () => {
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'vip' }, 'tg')), ['t1', 't2']);
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'VIP' }, 'tg')), ['t7']); // case-sensitive
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'vi' }, 'tg')), []);      // not a substring match
});

test('list ?tags=a,b and ?tags=a&tags=b: customers with ANY of them, each once', async () => {
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'vip,diwali' }, 'tg')), ['t1', 't2', 't3']);
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: ['vip', 'diwali'] }, 'tg')), ['t1', 't2', 't3']);
  const res = await callAs(getCustomers, { tags: 'vip,diwali' }, 'tg');
  assert.equal(res.body.data.pagination.total, 3);
});

test('list ?tags=: a tag with a comma, quotes or parentheses is matched as one tag (repeated form)', async () => {
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: ['a,b'] }, 'tg')), ['t4']);
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: ['say "hi"'] }, 'tg')), ['t5']);
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: ['x(y)'] }, 'tg')), ['t5']);
});

test('list ?tags= combines with the other filters', async () => {
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'vip', pipelineStage: 'lost' }, 'tg')), ['t2']);
  assert.deepEqual(idsOf(await callAs(getCustomers, { tags: 'VIP', neverMessaged: 'true' }, 'tg')), ['t7']);
});

test('list ?tags=: empty or blank means no tag filter; too many or too long is a 400', async () => {
  assert.equal((await callAs(getCustomers, { tags: '' }, 'tg')).body.data.pagination.total, 7);
  assert.equal((await callAs(getCustomers, { tags: ' , ' }, 'tg')).body.data.pagination.total, 7);
  const many = await callAs(getCustomers, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, 'tg');
  assert.equal(many.status, 400);
  assert.match(many.body.message, /at most 20 tags/);
  assert.equal((await callAs(getCustomers, { tags: 'x'.repeat(101) }, 'tg')).status, 400);
});

test('ids: same filters as the list → ids in the list\'s order, total, not truncated', async () => {
  const { status, body } = await callAs(getCustomerIds, { tags: 'vip,diwali' }, 'tg');
  assert.equal(status, 200);
  assert.deepEqual(body.data, { ids: ['t1', 't2', 't3'], total: 3, truncated: false });
  const list = await callAs(getCustomers, { tags: 'vip,diwali' }, 'tg');
  assert.deepEqual(body.data.ids, list.body.data.customers.map(c => c.id));
});

test('ids: every list filter works (neverMessaged, pipelineStage, groupId) and other businesses are excluded', async () => {
  assert.deepEqual((await callAs(getCustomerIds, { neverMessaged: 'true' }, 'tg')).body.data.ids, ['t7']);
  assert.deepEqual((await callAs(getCustomerIds, { pipelineStage: 'lost' }, 'tg')).body.data.ids, ['t2']);
  assert.deepEqual((await callAs(getCustomerIds, { groupId: GROUP }, 'imp')).body.data.ids, ['chat-old', 'imported-2']);
  assert.equal((await callAs(getCustomerIds, {}, 'tg')).body.data.total, 7);
});

test('ids: capped at 2000 with the real total and truncated: true (2,500 customers)', async () => {
  assert.equal(MAX_CUSTOMER_IDS, 2000);
  const { body } = await callAs(getCustomerIds, {}, 'big');
  assert.equal(body.data.ids.length, 2000);
  assert.equal(new Set(body.data.ids).size, 2000);
  assert.equal(body.data.total, 2500);
  assert.equal(body.data.truncated, true);
});

test('ids ?isVip=true: the VIPs among all 2,500 customers (past the 1000-row cap)', async () => {
  const { body } = await callAs(getCustomerIds, { isVip: 'true' }, 'big');
  assert.equal(body.data.total, 1500);
  assert.equal(body.data.ids.length, 1500);
  assert.equal(body.data.truncated, false);
  assert.ok(body.data.ids.every(id => Number(id.slice(2)) < 1500));
});

test('ids: bad filters are a 400, like the list', async () => {
  assert.equal((await callAs(getCustomerIds, { groupId: 'nope' }, 'tg')).status, 400);
  assert.equal((await callAs(getCustomerIds, { pipelineStage: 'nope' }, 'tg')).status, 400);
});

test('tags endpoint: distinct tags of this business, A→Z; none for a business without tags', async () => {
  const { status, body } = await callAs(getCustomerTags, {}, 'tg');
  assert.equal(status, 200);
  assert.deepEqual(body.data.tags, ['a,b', 'diwali', 'say "hi"', 'vip', 'VIP', 'x(y)']
    .sort((a, b) => a.localeCompare(b)));
  assert.deepEqual((await callAs(getCustomerTags, {}, 'imp')).body.data.tags, []);
});

test('tags endpoint: reads every page (a tag only on the last of 2,300 customers is found)', async () => {
  for (let i = 0; i < 2300; i += 1) tables.customers.push(tg(`tb-${pad(i)}`, i === 2299 ? ['last-one'] : [`t${i % 3}`], { business_id: 'tgbig' }));
  const { body } = await callAs(getCustomerTags, {}, 'tgbig');
  assert.deepEqual(body.data.tags, ['last-one', 't0', 't1', 't2']);
});
