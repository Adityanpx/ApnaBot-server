// Run: node --test src/controllers/auth.ownerPhone.test.js
// POST /api/auth/register phone handling (REQUIRE_OWNER_PHONE off / on) and GET/PATCH /api/auth/me.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const config = { JWT_SECRET: 's1', JWT_REFRESH_SECRET: 's2', JWT_EXPIRY: '24h', JWT_REFRESH_EXPIRY: '30d', REQUIRE_OWNER_PHONE: false };
stub('../config/env', config);
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/email.service', { sendVerificationEmail: async () => {} });
stub('../utils/crypto', { generateResetToken: () => 't', generateOtp: () => '123456' });
stub('../config/redis', { set: async () => {}, get: async () => null, del: async () => {}, sadd: async () => {}, expire: async () => {}, srem: async () => {}, smembers: async () => [] });

let users; let inserted; let updated;
const from = () => {
  const filters = []; let mode = 'select'; let payload;
  const rows = () => users.filter((u) => filters.every(([c, v]) => u[c] === v));
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    insert: (row) => { mode = 'insert'; payload = row; return q; },
    update: (row) => { mode = 'update'; payload = row; return q; },
    maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
    single: async () => {
      if (mode === 'insert') {
        inserted = payload;
        const u = { id: 'new-user', business_id: null, ...payload };
        users.push(u);
        return { data: u, error: null };
      }
      if (mode === 'update') {
        updated = payload;
        const u = rows()[0];
        Object.assign(u, payload);
        return { data: { ...u }, error: null };
      }
      return { data: rows()[0] || null, error: null };
    },
    then: (resolve) => resolve({ data: null, error: null })
  };
  return q;
};
stub('../config/supabase', { from });

const auth = require('./auth.controller');

const call = async (handler, req) => {
  const out = { status: 200 };
  const res = { status: (c) => { out.status = c; return res; }, json: (b) => { out.body = b; return res; } };
  await handler({ headers: {}, ...req }, res, (e) => { throw e; });
  return out;
};
const reg = (extra = {}) => call(auth.register, { body: { name: 'Ravi', email: 'Ravi@Example.com', password: 'pw1234', ...extra } });

test.beforeEach(() => {
  config.REQUIRE_OWNER_PHONE = false;
  users = [{ id: 'u1', name: 'Asha', email: 'a@b.c', phone: '+919876543210', role: 'owner', business_id: 'b1' }];
  inserted = undefined; updated = undefined;
});

test('register: flag off, phone missing is accepted and stored null', async () => {
  const out = await reg();
  assert.equal(out.status, 201);
  assert.equal(inserted.phone, null);
  assert.equal(out.body.data.user.phone, null);
});

test('register: flag off, blank phone is treated as missing', async () => {
  assert.equal((await reg({ phone: '  ' })).status, 201);
  assert.equal(inserted.phone, null);
});

test('register: flag off, a present but invalid phone is a 400', async () => {
  for (const phone of ['12345', '5876543210', '+14155552671', 'abc']) {
    const out = await reg({ phone });
    assert.equal(out.status, 400, phone);
    assert.match(out.body.message, /valid 10-digit Indian mobile/);
  }
  assert.equal(inserted, undefined);
});

test('register: valid phone in any form is stored as +91XXXXXXXXXX', async () => {
  for (const phone of ['9876543210', '+919876543210', '09876543210']) {
    users = users.filter((u) => u.id === 'u1');
    inserted = undefined;
    const out = await reg({ phone });
    assert.equal(out.status, 201, phone);
    assert.equal(inserted.phone, '+919876543210');
    assert.equal(out.body.data.user.phone, '+919876543210');
  }
});

test('register: flag on, missing phone is a 400 "Phone number is required"', async () => {
  config.REQUIRE_OWNER_PHONE = true;
  for (const body of [{}, { phone: '' }, { phone: null }]) {
    const out = await reg(body);
    assert.equal(out.status, 400);
    assert.equal(out.body.message, 'Phone number is required');
  }
  assert.equal(inserted, undefined);
  assert.equal((await reg({ phone: '9876543210' })).status, 201);
});

test('GET /me returns the caller with phone', async () => {
  const out = await call(auth.getMe, { user: { userId: 'u1' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.user.phone, '+919876543210');
  assert.equal(out.body.data.user.email, 'a@b.c');
});

test('PATCH /me updates name and normalized phone; email and role are ignored', async () => {
  const out = await call(auth.updateMe, { user: { userId: 'u1' }, body: { name: '  New Name ', phone: '09123456789', email: 'evil@x.com', role: 'superadmin' } });
  assert.equal(out.status, 200);
  assert.deepEqual(updated, { name: 'New Name', phone: '+919123456789' });
  assert.equal(out.body.data.user.email, 'a@b.c');
  assert.equal(out.body.data.user.role, 'owner');
});

test('PATCH /me rejects an invalid phone and an empty name', async () => {
  assert.equal((await call(auth.updateMe, { user: { userId: 'u1' }, body: { phone: '123' } })).status, 400);
  assert.equal((await call(auth.updateMe, { user: { userId: 'u1' }, body: { name: '  ' } })).status, 400);
  assert.equal(updated, undefined);
});

test('PATCH /me cannot clear a phone that is set', async () => {
  for (const phone of ['', null, '  ']) {
    const out = await call(auth.updateMe, { user: { userId: 'u1' }, body: { phone } });
    assert.equal(out.status, 400, JSON.stringify(phone));
    assert.equal(out.body.message, 'Phone number cannot be removed');
  }
  assert.equal(updated, undefined);
  assert.equal(users[0].phone, '+919876543210');
});

test('PATCH /me with nothing to update (email only) is a 400', async () => {
  const out = await call(auth.updateMe, { user: { userId: 'u1' }, body: { email: 'x@y.z' } });
  assert.equal(out.status, 400);
});

test('PATCH /me can set a phone on a user who has none', async () => {
  users[0].phone = null;
  const out = await call(auth.updateMe, { user: { userId: 'u1' }, body: { phone: '9876543210' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.user.phone, '+919876543210');
});
