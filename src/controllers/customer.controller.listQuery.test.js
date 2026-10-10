// Run: node --test src/controllers/customer.controller.listQuery.test.js
// Characterization of getCustomers: the exact calls it makes on the Supabase
// query builder for each filter combination, and the response it builds from
// two rows. The expected values below were recorded from the handler as it
// was BEFORE its query was extracted into buildCustomerQuery (shared with the
// ids endpoint), so a pass here means the list's queries and output are
// unchanged. A test that needs a new filter (tags) is added in
// customer.controller.test.js, not here.
const test = require('node:test');
const assert = require('node:assert/strict');

const log = []; // one entry per builder created: [table, [method, ...args]...]
const rows = [
  { id: 'r1', business_id: 'b', whatsapp_number: '911', name: 'A', opted_in: true, is_blocked: false, opted_out_at: null, pipeline_stage: 'new', last_message_at: '2026-10-01T00:00:00Z', opt_in_link_id: null, tags: ['x'] },
  { id: 'r2', business_id: 'b', whatsapp_number: '912', name: 'B', opted_in: false, is_blocked: true, opted_out_at: null, pipeline_stage: 'lost', last_message_at: null, opt_in_link_id: null, tags: [] }
];
const builder = (table) => {
  const calls = [];
  log.push([table, calls]);
  const q = new Proxy({}, {
    get: (_, method) => {
      if (method === 'then') return (resolve) => resolve({ data: rows, count: rows.length, error: null });
      return (...args) => { calls.push([method, ...args]); return q; };
    }
  });
  return q;
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from: builder, rpc: async () => ({ data: [], error: null }) });
stub('../services/business.service', { getBusinessById: async () => ({ id: 'b', vipEnabled: false }) });
stub('../services/optInLink.service', { fetchLinkNames: async () => new Map() });
stub('../services/contactGroup.service', {
  isUuid: (v) => /^[0-9a-f-]{36}$/i.test(String(v)),
  groupsByCustomer: async () => new Map([['r1', [{ id: 'g', name: 'G' }]]])
});
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { getCustomers } = require('./customer.controller');

const GROUP = 'aaaaaaaa-0000-4000-8000-000000000001';
const run = async (query) => {
  log.length = 0;
  let body; let status = 200;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
  await getCustomers({ query, user: { businessId: 'b' } }, res, (err) => { throw err; });
  return { status, body, customersQueries: log.filter(([t]) => t === 'customers').map(([, calls]) => calls) };
};

const COUNT = { count: 'exact' };
const ORDER = ['order', 'last_message_at', { ascending: false, nullsFirst: false }];

test('no filters: select *, business scope, order, one range', async () => {
  const { customersQueries } = await run({});
  assert.deepEqual(customersQueries, [[
    ['select', '*', COUNT], ['eq', 'business_id', 'b'], ORDER, ['range', 0, 19]
  ]]);
});

test('every plain filter + search + page: same calls, same order', async () => {
  const { customersQueries } = await run({
    page: '3', limit: '10', search: 'ra,(hul)%*', isBlocked: 'false', optedIn: 'true',
    broadcastEligible: 'true', pipelineStage: 'contacted', neverMessaged: 'true'
  });
  assert.deepEqual(customersQueries, [[
    ['select', '*', COUNT], ['eq', 'business_id', 'b'],
    ['or', 'name.ilike.%rahul%,whatsapp_number.ilike.%rahul%'],
    ['eq', 'is_blocked', false], ['eq', 'opted_in', true],
    ['eq', 'opted_in', true], ['is', 'marketing_blocked_at', null], ['eq', 'is_blocked', false], ['is', 'opted_out_at', null],
    ['eq', 'pipeline_stage', 'contacted'], ['is', 'last_message_at', null],
    ORDER, ['range', 20, 29]
  ]]);
});

test('groupId: inner embed + filter on the membership', async () => {
  const { customersQueries } = await run({ groupId: GROUP });
  assert.deepEqual(customersQueries, [[
    ['select', '*, contact_group_members!inner(group_id)', COUNT], ['eq', 'business_id', 'b'],
    ['eq', 'contact_group_members.group_id', GROUP], ORDER, ['range', 0, 19]
  ]]);
});

test('isVip: whole filtered set read in pages of 1000 with an id tiebreak, then sliced in memory', async () => {
  const { customersQueries } = await run({ isVip: 'true', pipelineStage: 'new' });
  assert.deepEqual(customersQueries, [[
    ['select', '*', COUNT], ['eq', 'business_id', 'b'], ['eq', 'pipeline_stage', 'new'],
    ORDER, ['order', 'id', { ascending: true }], ['range', 0, 999]
  ]]);
});

test('bad pipelineStage / groupId: 400 before any query', async () => {
  const a = await run({ pipelineStage: 'nope' });
  assert.equal(a.status, 400);
  assert.deepEqual(a.customersQueries, []);
  const b = await run({ groupId: 'nope' });
  assert.equal(b.status, 400);
  assert.deepEqual(b.customersQueries, []);
});

test('response: camelCased rows with isVip / broadcastEligible / groups / windowExpiresAt and pagination', async () => {
  const { status, body } = await run({ page: '1', limit: '20' });
  assert.equal(status, 200);
  assert.deepEqual(body.data.pagination, { total: 2, page: 1, limit: 20, totalPages: 1, pages: 1, hasNextPage: false, hasPrevPage: false });
  const [a, b] = body.data.customers;
  assert.deepEqual(
    { id: a.id, isVip: a.isVip, broadcastEligible: a.broadcastEligible, optInLinkName: a.optInLinkName, groups: a.groups, windowExpiresAt: a.windowExpiresAt, whatsappNumber: a.whatsappNumber, tags: a.tags },
    { id: 'r1', isVip: false, broadcastEligible: true, optInLinkName: null, groups: [{ id: 'g', name: 'G' }], windowExpiresAt: '2026-10-02T00:00:00.000Z', whatsappNumber: '911', tags: ['x'] }
  );
  assert.deepEqual(
    { id: b.id, broadcastEligible: b.broadcastEligible, groups: b.groups, windowExpiresAt: b.windowExpiresAt },
    { id: 'r2', broadcastEligible: false, groups: [], windowExpiresAt: null }
  );
});
