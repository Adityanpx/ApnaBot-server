// Run: node --test src/services/broadcastAudience.marketingBlocked.test.js
// A customer who stopped MARKETING messages (customers.marketing_blocked_at) is left
// out of exactly the audiences that follow the marketing rule - everything except a
// UTILITY template - and shows up in the summary / skipped list as marketing_stopped.
// In-memory customers table; the SQL itself is checked by
// supabase/verification/verify_marketing_blocked.sql.
const test = require('node:test');
const assert = require('node:assert/strict');

const customers = [
  { id: 'ok', business_id: 'b', whatsapp_number: '919000000001', name: 'Asha', opted_in: true, is_blocked: false },
  { id: 'stopped', business_id: 'b', whatsapp_number: '919000000002', name: 'Ravi', opted_in: true, is_blocked: false, marketing_blocked_at: '2026-10-01T10:00:00Z' },
  { id: 'stopped-no-optin', business_id: 'b', whatsapp_number: '919000000003', name: 'Meena', opted_in: false, is_blocked: false, marketing_blocked_at: '2026-10-01T10:00:00Z' },
  { id: 'no-optin', business_id: 'b', whatsapp_number: '919000000004', name: 'Kiran', opted_in: false, is_blocked: false },
  { id: 'stopped-and-stop', business_id: 'b', whatsapp_number: '919000000005', name: 'Neha', opted_in: true, is_blocked: false, opted_out_at: '2026-10-02T10:00:00Z', marketing_blocked_at: '2026-10-01T10:00:00Z' },
  { id: 'other-biz', business_id: 'o', whatsapp_number: '919000000006', name: 'Other', opted_in: true, is_blocked: false, marketing_blocked_at: '2026-10-01T10:00:00Z' }
];

const query = () => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    order: () => q,
    range: () => q,
    then: (resolve) => resolve({ data: customers.filter(r => filters.every(f => f(r))), error: null })
  };
  return q;
};

// What the SQL does (the rules in the migration), written out for the mocked rpc.
const reasonOf = (c, requireOptIn) => {
  if (!/^[0-9]{8,15}$/.test(c.whatsapp_number)) return 'no_number';
  if (c.is_blocked !== false) return 'blocked';
  if (c.opted_out_at) return 'opted_out';
  if (requireOptIn && c.marketing_blocked_at) return 'marketing_stopped';
  if (requireOptIn && c.opted_in !== true) return 'not_opted_in';
  return null;
};
const rpcRows = (args) => customers.filter(c => c.business_id === args.p_business_id)
  .map(c => ({ customer_id: c.id, whatsapp_number: c.whatsapp_number, name: c.name, skip_reason: reasonOf(c, args.p_require_opt_in) }));
const rpc = (name, args) => {
  const rows = rpcRows(args);
  if (name === 'broadcast_audience_summary') {
    const n = (r) => rows.filter(x => x.skip_reason === r).length;
    return Promise.resolve({ data: { selected: rows.length, willReceive: rows.filter(x => !x.skip_reason).length,
      skipped: { no_number: n('no_number'), blocked: n('blocked'), opted_out: n('opted_out'), marketing_stopped: n('marketing_stopped'), not_opted_in: n('not_opted_in') } }, error: null });
  }
  let out = rows;
  const q = {
    eq: (c, v) => { out = out.filter(r => r[c] === v); return q; },
    not: (c, op, v) => { out = out.filter(r => (r[c] ?? null) !== v); return q; },
    order: () => q,
    range: () => q,
    then: (resolve) => resolve({ data: out, count: out.length, error: null })
  };
  return q;
};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query, rpc } };
const { resolveAudience, audienceSummary, audienceSkipped, SKIP_REASONS } = require('./broadcastAudience.service');

const ids = async (category) => (await resolveAudience('b', 'all_customers', null, category === undefined ? {} : { category })).map(c => c.id).sort();

test('MARKETING: a customer who stopped marketing messages is left out', async () => {
  assert.deepEqual(await ids('MARKETING'), ['ok']);
});

test('AUTHENTICATION, an unknown category and no category follow the same marketing rule', async () => {
  assert.deepEqual(await ids('AUTHENTICATION'), ['ok']);
  assert.deepEqual(await ids('something-new'), ['ok']);
  assert.deepEqual(await ids(), ['ok']);
  assert.deepEqual(await ids(null), ['ok']);
});

test('UTILITY: they still receive it - the block is the marketing rule only (STOP still wins)', async () => {
  assert.deepEqual(await ids('UTILITY'), ['no-optin', 'ok', 'stopped', 'stopped-no-optin']);
  assert.deepEqual(await ids('utility'), ['no-optin', 'ok', 'stopped', 'stopped-no-optin']);
});

test('the business is respected: another business\'s stopped customer changes nothing here', async () => {
  assert.ok(!(await ids('UTILITY')).includes('other-biz'));
});

test('summary: marketing_stopped is counted, before not_opted_in; UTILITY has none', async () => {
  const marketing = await audienceSummary('b', 'all_customers', null, { category: 'MARKETING' });
  assert.deepEqual(marketing, { selected: 5, willReceive: 1, skipped: { no_number: 0, blocked: 0, opted_out: 1, marketing_stopped: 2, not_opted_in: 1 } });
  const utility = await audienceSummary('b', 'all_customers', null, { category: 'UTILITY' });
  assert.deepEqual(utility, { selected: 5, willReceive: 4, skipped: { no_number: 0, blocked: 0, opted_out: 1, marketing_stopped: 0, not_opted_in: 0 } });
});

test('skipped list: the reason marketing_stopped is returned and can be filtered on', async () => {
  const all = await audienceSkipped('b', 'all_customers', null, { category: 'MARKETING' });
  assert.deepEqual(all.items.filter(i => i.reason === 'marketing_stopped').map(i => i.customerId).sort(), ['stopped', 'stopped-no-optin']);
  const only = await audienceSkipped('b', 'all_customers', null, { category: 'MARKETING', reason: 'marketing_stopped' });
  assert.equal(only.total, 2);
  assert.ok(only.items.every(i => i.reason === 'marketing_stopped' && /^91\*+\d{4}$/.test(i.number)));
  assert.equal((await audienceSkipped('b', 'all_customers', null, { category: 'UTILITY', reason: 'marketing_stopped' })).total, 0);
});

test('SKIP_REASONS lists marketing_stopped between opted_out and not_opted_in', () => {
  assert.deepEqual(SKIP_REASONS, ['no_number', 'blocked', 'opted_out', 'marketing_stopped', 'not_opted_in']);
});
