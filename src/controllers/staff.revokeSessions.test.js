// Run: node --test src/controllers/staff.revokeSessions.test.js
// removeStaff and toggleStaff (deactivate) end the staff user's sessions;
// re-activating does not, a 404 does not, and a Redis failure does not fail
// the request. supabase and auth.service are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let member; // row returned by the staff lookup (null = not found)
let revoked; let revokeFails;
const chain = {
  select: () => chain, eq: () => chain, delete: () => chain, single: async () => ({ data: member, error: null }),
  update: (patch) => { member = { ...member, ...patch }; return chain; },
  maybeSingle: async () => ({ data: member }),
  then: (resolve) => resolve({ error: null })
};
stub('../config/supabase', { from: () => chain });
stub('../config/env', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/subscription.service', {});
stub('../services/auth.service', {
  buildPermissions: () => ({}),
  revokeAllSessions: async (id) => { if (revokeFails) throw new Error('redis down'); revoked.push(id); }
});

const { removeStaff, toggleStaff } = require('./staff.controller');

const call = async (handler) => {
  const out = { status: 200 };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  await handler({ params: { id: 's1' }, user: { businessId: 'b1' } }, res, (e) => { throw e; });
  return out;
};

test.beforeEach(() => {
  member = { id: 's1', name: 'S', email: 's@x.y', role: 'staff', is_active: true };
  revoked = []; revokeFails = false;
});

test('removeStaff revokes all of the removed user\'s sessions', async () => {
  assert.equal((await call(removeStaff)).status, 200);
  assert.deepEqual(revoked, ['s1']);
});

test('removeStaff on an unknown staff id revokes nothing', async () => {
  member = null;
  assert.equal((await call(removeStaff)).status, 404);
  assert.deepEqual(revoked, []);
});

test('toggleStaff deactivating revokes sessions', async () => {
  const out = await call(toggleStaff); // active -> inactive
  assert.equal(out.status, 200);
  assert.deepEqual(revoked, ['s1']);
});

test('toggleStaff re-activating does not revoke', async () => {
  member.is_active = false;
  assert.equal((await call(toggleStaff)).status, 200);
  assert.deepEqual(revoked, []);
});

test('a Redis failure during revoke does not fail the request', async () => {
  revokeFails = true;
  assert.equal((await call(removeStaff)).status, 200);
  assert.equal((await call(toggleStaff)).status, 200);
});
