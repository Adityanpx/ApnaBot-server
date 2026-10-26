// Run: node --test src/routes/businessRequest.routes.test.js
// Unlisted-business requests end to end: recordRequest (row + team mail, never throws) and the
// superadmin GET / PUT /api/admin/business-requests. Real routes, controller, services and role
// middleware run; auth, logger, the DB and the Brevo client are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const tables = { users: [], businesses: [], business_requests: [] };
let failTable = null; // table name whose operations error
let sentMails = [];
let failMailTo = null;
let nextId = 1;
const logs = { warn: [], error: [] };
const config = {};

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Just enough of the supabase-js builder for the queries these services make.
const from = (table) => {
  const filters = [];
  let op = 'select'; let payload = null; let order = null; let rangeArgs = null; let wantCount = false;
  const exec = () => {
    if (failTable === table) return { data: null, error: new Error(`${table} down`), count: null };
    const matching = () => tables[table].filter((r) => filters.every((f) => f(r)));
    if (op === 'insert') {
      const row = { id: uuid(nextId++), status: 'new', notes: null, created_at: new Date(2026, 9, nextId).toISOString(), updated_at: null, ...payload };
      tables[table].push(row);
      return { data: row, error: null };
    }
    if (op === 'update') {
      const rows = matching();
      rows.forEach((r) => Object.assign(r, payload, { updated_at: '2026-10-30T00:00:00.000Z' }));
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    let rows = matching().map((r) => ({ ...r }));
    const count = rows.length;
    if (order) rows.sort((a, b) => (a[order] < b[order] ? 1 : -1));
    if (rangeArgs) rows = rows.slice(rangeArgs[0], rangeArgs[1] + 1);
    return { data: rows, error: null, count: wantCount ? count : null };
  };
  const q = {
    select: (_cols, opts) => { wantCount = !!(opts && opts.count); return q; },
    insert: (row) => { op = 'insert'; payload = row; return q; },
    update: (row) => { op = 'update'; payload = row; return q; },
    eq: (col, val) => { filters.push((r) => r[col] === val); return q; },
    in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return q; },
    order: (col) => { order = col; return q; },
    range: (a, b) => { rangeArgs = [a, b]; return q; },
    maybeSingle: async () => {
      const out = exec();
      if (out.error) return out;
      return { data: Array.isArray(out.data) ? (out.data[0] || null) : out.data, error: null };
    },
    then: (resolve) => resolve(exec())
  };
  return q;
};
stub('../config/supabase', { from });
stub('../config/env', config);
stub('../utils/logger', {
  info: () => {},
  warn: (...a) => logs.warn.push(a),
  error: (...a) => logs.error.push(a)
});
stub('../middleware/auth.middleware', {
  protect: (req, res, next) => {
    if (req.headers['x-anon']) return res.status(401).json({ success: false, message: 'No token provided' });
    req.user = { userId: 'admin-1', role: req.headers['x-role'] || 'superadmin' };
    next();
  }
});
// The Brevo client the real email.service builds on import.
stub('@getbrevo/brevo', {
  BrevoClient: class {
    constructor() {
      this.transactionalEmails = {
        sendTransacEmail: async (mail) => {
          const to = mail.to[0].email;
          if (failMailTo === to) throw new Error('brevo rejected');
          sentMails.push({ to, subject: mail.subject, html: mail.htmlContent });
        }
      };
    }
  }
});

const businessRequestService = require('../services/businessRequest.service');

const app = express();
app.use(express.json());
app.use('/api/admin/business-requests', require('./businessRequest.routes'));
app.use(require('../middleware/errorHandler.middleware'));

let server; let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/admin/business-requests`;
});
test.after(() => server.close());

test.beforeEach(() => {
  tables.users = [
    { id: 'u-owner', name: 'Asha <b>Patil</b>', email: 'asha@example.com', role: 'owner', is_active: true },
    { id: 'u-sa1', name: 'Suresh', email: 'suresh@example.com', role: 'superadmin', is_active: true },
    { id: 'u-sa2', name: 'Second', email: 'second@example.com', role: 'superadmin', is_active: true },
    { id: 'u-sa3', name: 'Left', email: 'left@example.com', role: 'superadmin', is_active: false }
  ];
  tables.businesses = [
    { id: 'b1', name: 'Rangoli Studio', business_category: 'general' },
    { id: 'b2', name: 'Petal Co', business_category: 'general' }
  ];
  tables.business_requests = [];
  failTable = null; sentMails = []; failMailTo = null; nextId = 1;
  logs.warn.length = 0; logs.error.length = 0;
  delete config.BUSINESS_REQUEST_NOTIFY_EMAIL;
});

const record = (over = {}) => businessRequestService.recordRequest({
  business: { id: 'b1', name: 'Rangoli Studio' }, userId: 'u-owner', requestedText: 'Rangoli artist', contactPhone: '919876543210', ...over
});
const get = (query = '', headers = {}) => fetch(`${base}${query}`, { headers });
const put = (id, body, headers = {}) => fetch(`${base}/${id}`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
});

// ── recordRequest ───────────────────────────────────────────────────────────

test('recordRequest: saves the row with the owner snapshot and mails every active superadmin', async () => {
  const result = await record();
  assert.deepEqual(result, { recorded: true, emailsSent: 2 });
  assert.equal(tables.business_requests.length, 1);
  const row = tables.business_requests[0];
  assert.equal(row.business_id, 'b1');
  assert.equal(row.requested_text, 'Rangoli artist');
  assert.equal(row.contact_phone, '919876543210');
  assert.equal(row.owner_name, 'Asha <b>Patil</b>');
  assert.equal(row.owner_email, 'asha@example.com');
  assert.equal(row.status, 'new');
  assert.deepEqual(sentMails.map((m) => m.to).sort(), ['second@example.com', 'suresh@example.com'], 'inactive superadmin is skipped');
});

test('recordRequest: the mail carries the request and phone, and owner-typed text is HTML-escaped', async () => {
  await record({ requestedText: '<script>alert(1)</script>' });
  const { subject, html } = sentMails[0];
  assert.match(subject, /New business request/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('919876543210'));
  assert.ok(html.includes('Asha &lt;b&gt;Patil&lt;/b&gt;'));
  assert.ok(html.includes('asha@example.com'));
});

test('recordRequest: BUSINESS_REQUEST_NOTIFY_EMAIL replaces the superadmin list (comma separated)', async () => {
  config.BUSINESS_REQUEST_NOTIFY_EMAIL = ' team@averix.test , ops@averix.test ';
  const result = await record();
  assert.equal(result.emailsSent, 2);
  assert.deepEqual(sentMails.map((m) => m.to), ['team@averix.test', 'ops@averix.test']);
});

test('recordRequest: never throws - a failed mail to one recipient still reaches the other', async () => {
  failMailTo = 'suresh@example.com';
  const result = await record();
  assert.deepEqual(result, { recorded: true, emailsSent: 1 });
  assert.equal(sentMails[0].to, 'second@example.com');
  assert.equal(tables.business_requests.length, 1);
});

test('recordRequest: never throws - the request is still saved when the recipient lookup fails', async () => {
  const original = tables.users;
  failTable = 'users';
  const result = await record();
  failTable = null;
  assert.equal(result.emailsSent, 0);
  assert.ok(logs.error.length > 0);
  assert.equal(tables.users, original);
});

test('recordRequest: never throws - a failed insert is logged and the team is still told', async () => {
  failTable = 'business_requests';
  const result = await record();
  assert.deepEqual(result, { recorded: false, emailsSent: 2 });
  assert.ok(logs.error.length > 0);
});

test('recordRequest: no recipient at all is a warning, not an error', async () => {
  tables.users = tables.users.filter((u) => u.role !== 'superadmin');
  const result = await record();
  assert.deepEqual(result, { recorded: true, emailsSent: 0 });
  assert.equal(logs.warn.length, 1);
});

// ── GET /api/admin/business-requests ─────────────────────────────────────────

const seedRequests = () => {
  tables.business_requests = [
    { id: uuid(101), business_id: 'b1', requested_text: 'Rangoli artist', contact_phone: '919876543210', owner_name: 'Asha', owner_email: 'asha@example.com', status: 'new', notes: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    { id: uuid(102), business_id: 'b2', requested_text: 'Florist', contact_phone: '919811111111', owner_name: 'Ravi', owner_email: 'ravi@example.com', status: 'contacted', notes: 'called', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' },
    { id: uuid(103), business_id: 'b1', requested_text: 'Mehendi', contact_phone: '919822222222', owner_name: 'Asha', owner_email: 'asha@example.com', status: 'new', notes: null, created_at: '2026-10-03T00:00:00Z', updated_at: '2026-10-03T00:00:00Z' }
  ];
};

test('admin: 401 without a token, 403 for owner and staff, on GET and PUT', async () => {
  seedRequests();
  assert.equal((await get('', { 'x-anon': '1' })).status, 401);
  assert.equal((await get('', { 'x-role': 'owner' })).status, 403);
  assert.equal((await get('', { 'x-role': 'staff' })).status, 403);
  assert.equal((await put(uuid(101), { status: 'contacted' }, { 'x-role': 'owner' })).status, 403);
  assert.equal((await put(uuid(101), { status: 'contacted' }, { 'x-anon': '1' })).status, 401);
  assert.equal(tables.business_requests[0].status, 'new', 'nothing was written');
});

test('GET: newest first, with business name / category joined and the signup snapshot', async () => {
  seedRequests();
  const body = await (await get()).json();
  assert.equal(body.success, true);
  assert.deepEqual(body.data.requests.map((r) => r.requestedText), ['Mehendi', 'Florist', 'Rangoli artist']);
  assert.deepEqual(body.data.requests[1], {
    id: uuid(102), _id: uuid(102), businessId: 'b2', requestedText: 'Florist', contactPhone: '919811111111',
    ownerName: 'Ravi', ownerEmail: 'ravi@example.com', status: 'contacted', notes: 'called',
    createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
    businessName: 'Petal Co', businessCategory: 'general'
  });
  assert.equal(body.data.pagination.total, 3);
});

test('GET: ?status filters and a bad status is a 400', async () => {
  seedRequests();
  const body = await (await get('?status=new')).json();
  assert.deepEqual(body.data.requests.map((r) => r.requestedText), ['Mehendi', 'Rangoli artist']);
  assert.equal(body.data.pagination.total, 2);
  assert.equal((await get('?status=done')).status, 400);
});

test('GET: pagination - page and limit, and a deleted business reads as a null name', async () => {
  seedRequests();
  const page2 = await (await get('?limit=2&page=2')).json();
  assert.deepEqual(page2.data.requests.map((r) => r.requestedText), ['Rangoli artist']);
  assert.equal(page2.data.pagination.totalPages, 2);
  assert.equal(page2.data.pagination.hasPrevPage, true);

  tables.businesses = tables.businesses.filter((b) => b.id !== 'b2');
  const all = await (await get()).json();
  assert.equal(all.data.requests.find((r) => r.requestedText === 'Florist').businessName, null);
});

test('GET: an empty queue is an empty list, not an error', async () => {
  const body = await (await get()).json();
  assert.deepEqual(body.data.requests, []);
  assert.equal(body.data.pagination.total, 0);
});

// ── PUT /api/admin/business-requests/:id ─────────────────────────────────────

test('PUT: status and notes are saved and the updated item comes back', async () => {
  seedRequests();
  const res = await put(uuid(101), { status: 'contacted', notes: '  Called, wants a florist flow ' });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.status, 'contacted');
  assert.equal(data.notes, 'Called, wants a florist flow');
  assert.equal(data.businessName, 'Rangoli Studio');
  assert.equal(tables.business_requests[0].status, 'contacted');
});

test('PUT: status alone or notes alone is fine; null or blank notes clear them', async () => {
  seedRequests();
  assert.equal((await put(uuid(102), { status: 'set_up' })).status, 200);
  assert.equal(tables.business_requests[1].notes, 'called', 'notes untouched when not sent');
  assert.equal((await put(uuid(102), { notes: null })).status, 200);
  assert.equal(tables.business_requests[1].notes, null);
  assert.equal((await put(uuid(102), { notes: '   ' })).status, 200);
  assert.equal(tables.business_requests[1].notes, null);
  assert.equal(tables.business_requests[1].status, 'set_up');
});

test('PUT: validation - unknown status, non-string notes, notes too long, empty body, unknown id', async () => {
  seedRequests();
  for (const bad of [{ status: 'done' }, { status: 5 }, { notes: 5 }, { notes: 'x'.repeat(2001) }, {}]) {
    assert.equal((await put(uuid(101), bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await put(uuid(999), { status: 'set_up' })).status, 404);
  assert.equal((await put('not-a-uuid', { status: 'set_up' })).status, 404);
  assert.equal(tables.business_requests[0].status, 'new');
  assert.equal((await put(uuid(101), { notes: 'x'.repeat(2000) })).status, 200);
});
