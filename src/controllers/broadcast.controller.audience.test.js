// Run: node --test src/controllers/broadcast.controller.audience.test.js
// audience-summary / audience-skipped handlers (cap flag, validation, paging)
// and createBroadcast with the 'customers' / 'segment' audiences (ids must be
// this business's → 404). The audience service is the real one; Supabase is a
// small stand-in with an rpc recorder. Owner-only access is the route's
// requireRole, checked in src/routes/broadcastTemplate.roles.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const CUSTOMERS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', business_id: 'b' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', business_id: 'b' },
  { id: 'aaaaaaaa-0000-4000-8000-0000000000ff', business_id: 'other' }
];
const [C1, C2, CX] = CUSTOMERS.map(c => c.id);
const inserted = [];
const rpcCalls = [];
let rpcRows = [];
let rpcCount = 0;
let summaryData = {};

const supabase = {
  rpc: (name, args, opts = {}) => {
    rpcCalls.push({ name, args, opts, filters: [] });
    const call = rpcCalls[rpcCalls.length - 1];
    if (name === 'broadcast_audience_summary') return Promise.resolve({ data: summaryData, error: null });
    const q = {
      eq: (c, v) => { call.filters.push(['eq', c, v]); return q; },
      not: (c, op, v) => { call.filters.push(['not', c, op, v]); return q; },
      order: (c, o) => { call.filters.push(['order', c, o]); return q; },
      range: (from, to) => { call.filters.push(['range', from, to]); return q; },
      then: (resolve) => resolve({ data: rpcRows, count: rpcCount, error: null })
    };
    return q;
  },
  from: (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push(r => r[c] === v); return q; },
      in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
      insert: (row) => { inserted.push(row); return q; },
      single: async () => ({ data: { id: 'new', ...inserted[inserted.length - 1] }, error: null }),
      maybeSingle: async () => ({ data: { id: 't', business_id: 'b', name: 'promo', status: 'approved', send_support: 'ok', category: 'MARKETING', language: 'en_US', body_text: 'Hi', header_type: 'NONE' }, error: null }),
      then: (resolve) => resolve({ data: table === 'customers' ? CUSTOMERS.filter(r => filters.every(f => f(r))) : [], error: null })
    };
    return q;
  }
};
stub('../config/supabase', supabase);
stub('../config/env', { WALLET_BILLING_ENABLED: false, MAX_BROADCAST_RECIPIENTS: 1000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({}) });
stub('../services/wallet.service', {});
stub('../services/rateCard.service', {});
stub('../queues/broadcast.queue', { addToBroadcastQueue: async () => {} });
const { createBroadcast, getAudienceSummary, getAudienceSkipped } = require('./broadcast.controller');

const call = async (handler, body, businessId = 'b') => {
  let failure;
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId }, params: {}, body }, res, (err) => { failure = err; });
  if (failure) throw failure;
  return res;
};

test.beforeEach(() => {
  inserted.length = 0; rpcCalls.length = 0; rpcRows = []; rpcCount = 0;
  summaryData = { selected: 10, willReceive: 7, skipped: { no_number: 1, blocked: 1, opted_out: 0, not_opted_in: 1 } };
});

// ── audience-summary ──

test('summary: selected / willReceive / skipped by reason, and the cap', async () => {
  const res = await call(getAudienceSummary, { audienceFilter: 'segment', audienceParams: { tags: ['vip'] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, {
    selected: 10, willReceive: 7, skipped: { no_number: 1, blocked: 1, opted_out: 0, not_opted_in: 1 }, overCap: false, cap: 1000
  });
});

test('summary: asks SQL for this business with the normalized audience', async () => {
  await call(getAudienceSummary, { audienceFilter: 'segment', audienceParams: { tags: [' vip ', 'vip'], neverMessaged: false, activeWithinDays: 30 } }, 'biz-1');
  assert.deepEqual(rpcCalls.map(c => [c.name, c.args]), [[
    'broadcast_audience_summary', { p_business_id: 'biz-1', p_filter: 'segment', p_params: { tags: ['vip'], activeWithinDays: 30 } }
  ]]);
  rpcCalls.length = 0;
  await call(getAudienceSummary, {}); // no audience given = everyone
  assert.deepEqual(rpcCalls[0].args, { p_business_id: 'b', p_filter: 'all_customers', p_params: {} });
});

test('summary: overCap is true only when willReceive is above the cap (exactly the cap is fine)', async () => {
  summaryData = { selected: 1500, willReceive: 1000, skipped: {} };
  assert.equal((await call(getAudienceSummary, {})).body.data.overCap, false);
  summaryData = { selected: 1500, willReceive: 1001, skipped: {} };
  const res = await call(getAudienceSummary, {});
  assert.equal(res.body.data.overCap, true);
  assert.equal(res.body.data.cap, 1000);
});

test('summary: a bad audience is a 400 and SQL is not called', async () => {
  for (const body of [
    { audienceFilter: 'vip' },
    { audienceFilter: 'segment', audienceParams: {} },
    { audienceFilter: 'segment', audienceParams: { vip: true } },
    { audienceFilter: 'customers', audienceParams: { customerIds: ['nope'] } },
    { audienceFilter: 'groups' }
  ]) {
    assert.equal((await call(getAudienceSummary, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(rpcCalls.length, 0);
});

// ── audience-skipped ──

test('skipped: a page of masked customers with the reason, and pagination', async () => {
  rpcRows = [
    { customer_id: C1, name: 'Asha', whatsapp_number: '919876543210', skip_reason: 'not_opted_in' },
    { customer_id: C2, name: null, whatsapp_number: '12345', skip_reason: 'no_number' }
  ];
  rpcCount = 120;
  const res = await call(getAudienceSkipped, { audienceFilter: 'all_customers', page: 2, limit: 50 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.items, [
    { customerId: C1, name: 'Asha', number: '91******3210', reason: 'not_opted_in' },
    { customerId: C2, name: null, number: '*****', reason: 'no_number' }
  ]);
  assert.deepEqual(res.body.data.pagination, { total: 120, page: 2, limit: 50, totalPages: 3, pages: 3, hasNextPage: true, hasPrevPage: true });
  // the second page of 50 = rows 50..99, every skipped customer (any reason), name A→Z then id
  assert.deepEqual(rpcCalls[0].filters, [
    ['not', 'skip_reason', 'is', null],
    ['order', 'name', { ascending: true, nullsFirst: false }],
    ['order', 'customer_id', { ascending: true }],
    ['range', 50, 99]
  ]);
  assert.deepEqual(rpcCalls[0].opts, { count: 'exact' });
});

test('skipped: reason filter, defaults (page 1, 50 per page) and limits', async () => {
  const res = await call(getAudienceSkipped, { audienceFilter: 'all_customers', reason: 'blocked' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(rpcCalls[0].filters[0], ['eq', 'skip_reason', 'blocked']);
  assert.deepEqual(rpcCalls[0].filters.at(-1), ['range', 0, 49]);
  rpcCalls.length = 0;
  assert.equal((await call(getAudienceSkipped, { audienceFilter: 'all_customers', limit: 100 })).statusCode, 200);
  assert.deepEqual(rpcCalls[0].filters.at(-1), ['range', 0, 99]);
});

test('skipped: bad reason / page / limit / audience → 400, SQL not called', async () => {
  rpcCalls.length = 0;
  for (const body of [
    { reason: 'spam' },
    { reason: 5 },
    { page: 0 },
    { page: '2' },
    { page: 1.5 },
    { limit: 0 },
    { limit: 101 },
    { limit: '10' },
    { audienceFilter: 'segment', audienceParams: {} }
  ]) {
    assert.equal((await call(getAudienceSkipped, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.equal(rpcCalls.length, 0);
});

// ── createBroadcast with the new audiences ──

test("create 'customers': ids of this business → saved with audience_params", async () => {
  const res = await call(createBroadcast, { name: 'Pick', templateId: 't', audienceFilter: 'customers', audienceParams: { customerIds: [C1, C2, C1] } });
  assert.equal(res.statusCode, 201);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].audience_filter, 'customers');
  assert.deepEqual(inserted[0].audience_params, { customerIds: [C1, C2] });
});

test("create 'customers': an id from another business (or unknown) → 404, nothing saved", async () => {
  const foreign = await call(createBroadcast, { name: 'Pick', templateId: 't', audienceFilter: 'customers', audienceParams: { customerIds: [C1, CX] } });
  assert.equal(foreign.statusCode, 404);
  assert.match(foreign.body.message, /customers were not found/);
  const unknown = await call(createBroadcast, { name: 'Pick', templateId: 't', audienceFilter: 'customers', audienceParams: { customerIds: [C1, 'bbbbbbbb-0000-4000-8000-000000000009'] } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(inserted.length, 0);
});

test("create 'customers': more than 2,000 ids → 400", async () => {
  const ids = Array.from({ length: 2001 }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const res = await call(createBroadcast, { name: 'Pick', templateId: 't', audienceFilter: 'customers', audienceParams: { customerIds: ids } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /at most 2000 customers/);
  assert.equal(inserted.length, 0);
});

test("create 'segment': saved with the normalized filters; an empty segment is a 400", async () => {
  const ok = await call(createBroadcast, { name: 'Seg', templateId: 't', audienceFilter: 'segment', audienceParams: { tags: ['vip'], pipelineStages: ['new'] } });
  assert.equal(ok.statusCode, 201);
  assert.equal(inserted[0].audience_filter, 'segment');
  assert.deepEqual(inserted[0].audience_params, { tags: ['vip'], pipelineStages: ['new'] });
  inserted.length = 0;
  assert.equal((await call(createBroadcast, { name: 'Seg', templateId: 't', audienceFilter: 'segment', audienceParams: {} })).statusCode, 400);
  assert.equal(inserted.length, 0);
});
