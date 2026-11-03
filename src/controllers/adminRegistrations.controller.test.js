// Run: node --test src/controllers/adminRegistrations.controller.test.js
// Super Admin "registered, no business": owners with no business row, the filters, pagination,
// and the CSV export (formula-safe, logs who exported what).
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { users: [], businesses: [] };
const logs = [];

const from = (table) => {
  const filters = []; let rangeArgs = null;
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
    not: (c) => { filters.push((r) => r[c] !== null && r[c] !== undefined); return q; },
    or: (expr) => {
      const term = /name\.ilike\.%([^%]*)%/.exec(expr)[1].toLowerCase();
      filters.push((r) => ['name', 'email', 'phone'].some((k) => (r[k] || '').toLowerCase().includes(term)));
      return q;
    },
    order: () => q,
    range: (a, b) => { rangeArgs = [a, b]; return q; },
    then: (resolve) => {
      let data = tables[table].filter((r) => filters.every((f) => f(r)));
      if (rangeArgs) data = data.slice(rangeArgs[0], rangeArgs[1] + 1);
      return resolve({ data: data.map((r) => ({ ...r })), error: null });
    }
  };
  return q;
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: (m) => logs.push(m), warn: () => {}, error: () => {} });

const reg = require('./adminRegistrations.controller');

const call = async (handler, req) => {
  const out = { status: 200, headers: {} };
  const res = {
    status: (c) => { out.status = c; return res; },
    json: (b) => { out.body = b; return res; },
    send: (b) => { out.text = b; return res; },
    setHeader: (k, v) => { out.headers[k] = v; }
  };
  await handler({ user: { userId: 'admin-1' }, ...req }, res, (e) => { throw e; });
  return out;
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000 - 1000).toISOString();
const owner = (id, extra = {}) => ({
  id, name: id, email: `${id}@example.com`, phone: null, role: 'owner', is_verified: true, is_active: true,
  created_at: daysAgo(3), last_login_at: null, ...extra
});

test.beforeEach(() => {
  logs.length = 0;
  tables.users = [
    owner('has-biz'),
    owner('new-a', { created_at: daysAgo(1), phone: '+919876543210', last_login_at: '2026-11-01T10:00:00Z' }),
    owner('new-b', { created_at: daysAgo(10), is_verified: false }),
    owner('gone', { is_active: false }),
    { ...owner('staff-1'), role: 'staff' },
    { ...owner('root'), role: 'superadmin' }
  ];
  tables.businesses = [{ id: 'b1', owner_user_id: 'has-biz' }, { id: 'b2', owner_user_id: null }];
});

test('list: only owners without a business, inactive hidden, newest first', async () => {
  const out = await call(reg.listNoBusiness, { query: {} });
  assert.deepEqual(out.body.data.registrations.map((r) => r.id), ['new-a', 'new-b']);
  assert.equal(out.body.data.pagination.total, 2);
});

test('list: row fields - phone null, verified, days since, last login', async () => {
  const out = await call(reg.listNoBusiness, { query: {} });
  const [a, b] = out.body.data.registrations;
  assert.equal(a.phone, '+919876543210');
  assert.equal(a.verified, true);
  assert.equal(a.daysSince, 1);
  assert.equal(a.lastLoginAt, '2026-11-01T10:00:00Z');
  assert.equal(b.phone, null);
  assert.equal(b.verified, false);
  assert.equal(b.daysSince, 10);
  assert.equal(b.lastLoginAt, null);
});

test('list: includeInactive=true shows deactivated owners too', async () => {
  const out = await call(reg.listNoBusiness, { query: { includeInactive: 'true' } });
  assert.deepEqual(out.body.data.registrations.map((r) => r.id).sort(), ['gone', 'new-a', 'new-b']);
});

test('list: unverifiedOnly=true keeps only unverified owners', async () => {
  const out = await call(reg.listNoBusiness, { query: { unverifiedOnly: 'true' } });
  assert.deepEqual(out.body.data.registrations.map((r) => r.id), ['new-b']);
});

test('list: search matches name, email or phone', async () => {
  const byName = await call(reg.listNoBusiness, { query: { search: 'new-b' } });
  assert.deepEqual(byName.body.data.registrations.map((r) => r.id), ['new-b']);
  const byPhone = await call(reg.listNoBusiness, { query: { search: '98765' } });
  assert.deepEqual(byPhone.body.data.registrations.map((r) => r.id), ['new-a']);
});

test('list: page and limit slice the result', async () => {
  const out = await call(reg.listNoBusiness, { query: { page: '2', limit: '1' } });
  assert.deepEqual(out.body.data.registrations.map((r) => r.id), ['new-b']);
  assert.equal(out.body.data.pagination.total, 2);
  assert.equal(out.body.data.pagination.hasNextPage, false);
});

test('list: a business owned by someone else does not hide this owner', async () => {
  tables.businesses.push({ id: 'b3', owner_user_id: 'new-a' });
  const out = await call(reg.listNoBusiness, { query: {} });
  assert.deepEqual(out.body.data.registrations.map((r) => r.id), ['new-b']);
});

test('export: CSV headers, yes/no verified, empty cells for missing phone / login', async () => {
  const out = await call(reg.exportNoBusinessCsv, { query: {} });
  assert.match(out.headers['Content-Type'], /text\/csv/);
  assert.match(out.headers['Content-Disposition'], /attachment/);
  const lines = out.text.trim().split('\n');
  assert.equal(lines[0], 'Name,Email,Phone,Verified,Registered,Days since,Last login');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('new-a,new-a@example.com,+919876543210,yes,'));
  assert.ok(lines[2].includes(',,no,'));
});

test('export: a name that looks like a formula is neutralised', async () => {
  tables.users.push(owner('evil', { name: '=HYPERLINK("http://x")', created_at: daysAgo(0) }));
  const out = await call(reg.exportNoBusinessCsv, { query: {} });
  assert.ok(out.text.includes('"\'=HYPERLINK(""http://x"")"'));
});

test('export: logs user id, filters and row count', async () => {
  await call(reg.exportNoBusinessCsv, { query: { unverifiedOnly: 'true' } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /user=admin-1/);
  assert.match(logs[0], /"unverifiedOnly":true/);
  assert.match(logs[0], /rows=1/);
});
