// Run: node --test src/services/broadcastAudience.service.test.js
// Pure part only (normalizeAudience) — resolveAudience is checked against real data separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {} };
const { normalizeAudience } = require('./broadcastAudience.service');

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
