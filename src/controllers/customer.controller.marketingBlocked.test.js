// Run: node --test src/controllers/customer.controller.marketingBlocked.test.js
// customers.marketing_blocked_at in the customer API: a customer who stopped marketing
// messages is not "Broadcast eligible" (flag, list filter and summary count), the
// customer page carries marketingBlockedAt, and the owner can lift the block
// (POST /api/customers/:id/resume-marketing). In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

let tables;

const query = (table) => {
  const filters = []; let op = 'select'; let payload; let head = false; let wantCount = false;
  const rows = () => tables[table].filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') { const m = rows(); m.forEach(r => Object.assign(r, payload)); return m; }
    return rows();
  };
  const q = {
    select: (cols, opts = {}) => { head = !!opts.head; wantCount = opts.count === 'exact'; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    not: (c, op2, v) => { filters.push(r => (r[c] ?? null) !== v); return q; },
    or: () => q,
    order: () => q,
    range: () => q,
    limit: () => q,
    maybeSingle: async () => ({ data: run()[0] || null, error: null }),
    single: async () => ({ data: run()[0] || null, error: null }),
    then: (resolve) => { const r = run(); resolve({ data: head ? null : r, count: wantCount ? r.length : null, error: null }); }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from: query, rpc: async () => ({ data: [], error: null }) });
stub('../services/business.service', { getBusinessById: async () => ({ id: 'b', vipEnabled: false }) });
stub('../services/optInLink.service', { fetchLinkNames: async () => new Map() });
stub('../services/contactGroup.service', { isUuid: () => true, groupsByCustomer: async () => new Map() });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { isBroadcastEligible, getCustomers, getCustomerSummary, getCustomerById, resumeMarketing } = require('./customer.controller');

const STAMP = '2026-10-01T10:00:00Z';
const cust = (id, over = {}) => ({ id, business_id: 'b', whatsapp_number: `91${id}`, name: id, opted_in: true, is_blocked: false, opted_out_at: null, marketing_blocked_at: null, last_message_at: '2026-10-01T00:00:00Z', ...over });

test.beforeEach(() => {
  tables = {
    customers: [cust('1001'), cust('1002', { marketing_blocked_at: STAMP }), cust('1003', { opted_in: false }), cust('2001', { business_id: 'other', marketing_blocked_at: STAMP })],
    contact_group_members: [], bookings: [], messages: []
  };
});

const call = async (handler, { query: q = {}, params = {}, businessId = 'b' } = {}) => {
  let out; let status; let failure;
  const res = { status: (s) => { status = s; return res; }, json: (b) => { out = b; return res; } };
  await handler({ query: q, params, user: { businessId } }, res, (err) => { failure = err; });
  if (failure) throw failure;
  return { status, body: out };
};

test('eligibility: a customer who stopped marketing messages is not broadcast eligible', () => {
  const base = { opted_in: true, is_blocked: false, opted_out_at: null };
  assert.equal(isBroadcastEligible(base), true);
  assert.equal(isBroadcastEligible({ ...base, marketing_blocked_at: undefined }), true); // row from before the column
  assert.equal(isBroadcastEligible({ ...base, marketing_blocked_at: null }), true);
  assert.equal(isBroadcastEligible({ ...base, marketing_blocked_at: STAMP }), false);
});

test('list: broadcastEligible=true leaves them out; each row says whether it is eligible and carries the time', async () => {
  const eligible = await call(getCustomers, { query: { broadcastEligible: 'true' } });
  assert.deepEqual(eligible.body.data.customers.map(c => c.id), ['1001']);
  const all = await call(getCustomers, {});
  const byId = Object.fromEntries(all.body.data.customers.map(c => [c.id, c]));
  assert.deepEqual([byId['1001'].broadcastEligible, byId['1002'].broadcastEligible], [true, false]);
  assert.equal(byId['1002'].marketingBlockedAt, STAMP);
  assert.equal(byId['1001'].marketingBlockedAt, null);
});

test('summary: the broadcastEligible count leaves them out', async () => {
  const { body } = await call(getCustomerSummary, {});
  assert.equal(body.data.broadcastEligible, 1);
  assert.equal(body.data.optedIn, 2);
});

test('customer page: marketingBlockedAt and broadcastEligible false', async () => {
  const { body } = await call(getCustomerById, { params: { id: '1002' } });
  assert.equal(body.data.customer.marketingBlockedAt, STAMP);
  assert.equal(body.data.customer.broadcastEligible, false);
});

test('resume: the owner lifts the block', async () => {
  const { status, body } = await call(resumeMarketing, { params: { id: '1002' } });
  assert.equal(status, 200);
  assert.equal(body.data.marketingBlockedAt, null);
  assert.equal(tables.customers.find(c => c.id === '1002').marketing_blocked_at, null);
});

test('resume: a customer who has not stopped marketing is a 400, an unknown one a 404', async () => {
  assert.equal((await call(resumeMarketing, { params: { id: '1001' } })).status, 400);
  assert.equal((await call(resumeMarketing, { params: { id: 'nope' } })).status, 404);
});

test('resume: another business\'s customer is a 404 and stays stopped', async () => {
  const { status } = await call(resumeMarketing, { params: { id: '2001' } });
  assert.equal(status, 404);
  assert.equal(tables.customers.find(c => c.id === '2001').marketing_blocked_at, STAMP);
});
