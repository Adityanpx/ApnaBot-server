// Run: node --test src/services/broadcastAudience.service.test.js
// Pure part only (normalizeAudience) — resolveAudience is checked against real data separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };
const { normalizeAudience, AUDIENCE_FILTERS } = require('./broadcastAudience.service');

test('default / all_customers: no params (exactly as before)', () => {
  assert.deepEqual(normalizeAudience(undefined, undefined), { filter: 'all_customers', params: null });
  assert.deepEqual(normalizeAudience('all_customers', { form: 'demo' }), { filter: 'all_customers', params: null });
});

test('coaching_requests: defaults to either form, all courses, skipping closed requests', () => {
  assert.deepEqual(normalizeAudience('coaching_requests', undefined), { filter: 'coaching_requests', params: { form: 'any', course: null, skipClosed: true } });
  assert.deepEqual(normalizeAudience('coaching_requests', { form: 'demo', course: ' Abacus ', skipClosed: false }),
    { filter: 'coaching_requests', params: { form: 'demo', course: 'Abacus', skipClosed: false } });
  assert.deepEqual(normalizeAudience('coaching_requests', { course: '' }).params.course, null);
});

test('rejects unknown filters and bad params', () => {
  assert.match(normalizeAudience('vip', null).error, /audienceFilter must be one of/);
  assert.match(normalizeAudience('coaching_requests', { form: 'trial' }).error, /form must be one of: demo, admission, any/);
  assert.match(normalizeAudience('coaching_requests', { course: 5 }).error, /course must be text/);
  assert.match(normalizeAudience('coaching_requests', { skipClosed: 'yes' }).error, /skipClosed must be true or false/);
  assert.match(normalizeAudience('coaching_requests', []).error, /must be an object/);
});

test('groups: 1-20 group ids, de-duplicated, ids only', () => {
  const id = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  assert.deepEqual(normalizeAudience('groups', { groupIds: [id(1), id(2), id(1)] }), { filter: 'groups', params: { groupIds: [id(1), id(2)] } });
  assert.match(normalizeAudience('groups', undefined).error, /at least one group/);
  assert.match(normalizeAudience('groups', { groupIds: [] }).error, /at least one group/);
  assert.match(normalizeAudience('groups', { groupIds: 'x' }).error, /at least one group/);
  assert.match(normalizeAudience('groups', { groupIds: ['nope'] }).error, /must be group ids/);
  assert.match(normalizeAudience('groups', { groupIds: Array.from({ length: 21 }, (_, i) => id(i)) }).error, /at most 20 groups/);
  assert.equal(normalizeAudience('groups', { groupIds: Array.from({ length: 20 }, (_, i) => id(i)) }).params.groupIds.length, 20);
});

const cid = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('customers: ids are checked, de-duplicated and capped at 2000 (after de-duplication)', () => {
  assert.deepEqual(normalizeAudience('customers', { customerIds: [cid(1), cid(2), cid(1)] }), { filter: 'customers', params: { customerIds: [cid(1), cid(2)] } });
  assert.match(normalizeAudience('customers', undefined).error, /at least one customer/);
  assert.match(normalizeAudience('customers', { customerIds: [] }).error, /at least one customer/);
  assert.match(normalizeAudience('customers', { customerIds: 'x' }).error, /at least one customer/);
  assert.match(normalizeAudience('customers', { customerIds: ['nope'] }).error, /must be customer ids/);
  assert.match(normalizeAudience('customers', { customerIds: [cid(1), 5] }).error, /must be customer ids/);
  const ids = Array.from({ length: 2001 }, (_, i) => cid(i));
  assert.match(normalizeAudience('customers', { customerIds: ids }).error, /at most 2000 customers/);
  assert.equal(normalizeAudience('customers', { customerIds: ids.slice(0, 2000) }).params.customerIds.length, 2000);
  // 2,500 entries that are only 2,000 distinct customers are fine
  assert.equal(normalizeAudience('customers', { customerIds: [...ids.slice(0, 2000), ...ids.slice(0, 500)] }).params.customerIds.length, 2000);
});

test('segment: tags (ANY, exact), pipelineStages, activeWithinDays, neverMessaged — only the given keys are kept', () => {
  assert.deepEqual(normalizeAudience('segment', { tags: [' vip ', 'vip', 'diwali', ''] }), { filter: 'segment', params: { tags: ['vip', 'diwali'] } });
  assert.deepEqual(normalizeAudience('segment', { pipelineStages: ['new', 'new', 'lost'] }).params, { pipelineStages: ['new', 'lost'] });
  assert.deepEqual(normalizeAudience('segment', { activeWithinDays: 30 }).params, { activeWithinDays: 30 });
  assert.deepEqual(normalizeAudience('segment', { neverMessaged: true }).params, { neverMessaged: true });
  assert.deepEqual(normalizeAudience('segment', { tags: ['a'], pipelineStages: ['new'], activeWithinDays: 7 }).params, { tags: ['a'], pipelineStages: ['new'], activeWithinDays: 7 });
  // empty / false / null filters are "not set"
  assert.deepEqual(normalizeAudience('segment', { tags: [], pipelineStages: null, neverMessaged: false, activeWithinDays: 5 }).params, { activeWithinDays: 5 });
});

test('segment: bad input is an error, and a segment with no filter is refused', () => {
  assert.match(normalizeAudience('segment', undefined).error, /at least one filter/);
  assert.match(normalizeAudience('segment', {}).error, /at least one filter/);
  assert.match(normalizeAudience('segment', { tags: [], neverMessaged: false }).error, /at least one filter/);
  assert.match(normalizeAudience('segment', { tags: 'vip' }).error, /tags must be a list/);
  assert.match(normalizeAudience('segment', { tags: [1] }).error, /tags must be a list/);
  assert.match(normalizeAudience('segment', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).error, /at most 20 tags/);
  assert.match(normalizeAudience('segment', { tags: ['x'.repeat(101)] }).error, /longer than 100/);
  assert.match(normalizeAudience('segment', { pipelineStages: ['vip'] }).error, /pipelineStages must be a list of: new, contacted, converted, lost/);
  assert.match(normalizeAudience('segment', { pipelineStages: 'new' }).error, /pipelineStages must be a list/);
  for (const bad of [0, -1, 1.5, '7', 3651, NaN]) {
    assert.match(normalizeAudience('segment', { activeWithinDays: bad }).error, /activeWithinDays must be a whole number/, String(bad));
  }
  assert.equal(normalizeAudience('segment', { activeWithinDays: 3650 }).params.activeWithinDays, 3650);
  assert.match(normalizeAudience('segment', { neverMessaged: 'yes' }).error, /neverMessaged must be true or false/);
  assert.match(normalizeAudience('segment', { activeWithinDays: 7, neverMessaged: true }).error, /can't be combined/);
  assert.match(normalizeAudience('segment', []).error, /must be an object/);
});

test('segment: no VIP (or any other) filter — unknown keys are refused, not ignored', () => {
  assert.match(normalizeAudience('segment', { vip: true, tags: ['a'] }).error, /vip isn't a segment filter/);
  assert.match(normalizeAudience('segment', { tag: ['a'] }).error, /tag isn't a segment filter/);
});

test('every audience type is listed', () => {
  assert.deepEqual(AUDIENCE_FILTERS, ['all_customers', 'coaching_requests', 'groups', 'customers', 'segment']);
  assert.match(normalizeAudience('vip', null).error, /all_customers, coaching_requests, groups, customers, segment/);
});
