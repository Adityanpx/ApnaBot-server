// Run: node --test src/controllers/adminBusinessReports.controller.test.js
// Super Admin category summary and businesses CSV export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeAdminDb } = require('../test-support/fakeAdminBusinessDb');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const tables = { businesses: [], users: [], subscriptions: [] };
const logs = [];
stub('../config/supabase', createFakeAdminDb(tables));
stub('../utils/logger', { info: (m) => logs.push(m), warn: () => {}, error: () => {} });
stub('../services/businessCategory.service', {
  getAllCategories: async () => [
    { value: 'travels', label: 'Travels' },
    { value: 'salon', label: 'Salon' },
    { value: 'general', label: 'General' },
    { value: 'cab', label: 'Cab' },
    { value: 'multi_brand', label: 'Multi brand' }
  ]
});

const reports = require('./adminBusinessReports.controller');

const call = async (handler, req) => {
  const out = { status: 200, headers: {} };
  const res = {
    status: (c) => { out.status = c; return res; },
    json: (b) => { out.body = b; return res; },
    send: (b) => { out.text = b; return res; },
    setHeader: (k, v) => { out.headers[k] = v; }
  };
  await handler({ user: { userId: 'admin-1' }, query: {}, ...req }, res, (e) => { throw e; });
  return out;
};

const biz = (id, extra = {}) => ({
  id, name: `Biz ${id}`, city: 'Pune', owner_user_id: 'u1', business_category: 'travels', requested_category_text: null,
  sub_categories: [], whatsapp_number: '919284128827', is_whatsapp_connected: true, is_active: true,
  created_at: '2026-10-01T00:00:00Z', ...extra
});

test.beforeEach(() => {
  logs.length = 0;
  tables.businesses = [
    biz('b1'),
    biz('b2', { business_category: 'salon', owner_user_id: 'u2', is_whatsapp_connected: false, is_active: false, whatsapp_number: null }),
    biz('b3', { business_category: 'general', requested_category_text: 'Hotel', owner_user_id: 'u2' }),
    biz('b4', { business_category: 'multi_brand', sub_categories: ['cab', 'salon', 'oldcat'], owner_user_id: null }),
    biz('b5', { business_category: 'mystery' }),
    biz('b6', { business_category: 'travels' })
  ];
  tables.users = [
    { id: 'u1', name: 'Ravi', email: 'ravi@example.com', phone: '+919876543210', role: 'owner' },
    { id: 'u2', name: '=cmd|calc', email: 'asha@example.com', phone: null, role: 'owner' }
  ];
  tables.subscriptions = [
    { id: 's1', business_id: 'b1', status: 'active', end_date: '2027-01-01', created_at: '2026-01-01', plan: { id: 'p1', name: 'pro', display_name: 'Pro' } },
    { id: 's2', business_id: 'b3', status: 'trial', end_date: '2026-12-01', created_at: '2026-10-01', plan: { id: 'p2', name: 'trial', display_name: null } }
  ];
});

test('categorySummary: counts per category, biggest first, label from the table, raw value when unknown', async () => {
  const out = await call(reports.categorySummary, {});
  const { total, categories } = out.body.data;
  assert.equal(total, 6);
  assert.deepEqual(categories[0], { value: 'travels', label: 'Travels', count: 2 });
  assert.deepEqual(categories.find((c) => c.value === 'mystery'), { value: 'mystery', label: 'mystery', count: 1 });
  assert.equal(categories.find((c) => c.value === 'general').label, 'General');
  assert.equal(categories.reduce((n, c) => n + c.count, 0), 6);
});

test('categorySummary: ties sort by label', async () => {
  const out = await call(reports.categorySummary, {});
  assert.deepEqual(out.body.data.categories.slice(1).map((c) => c.label), ['General', 'Multi brand', 'mystery', 'Salon']);
});

test('export: CSV headers and attachment', async () => {
  const out = await call(reports.exportBusinessesCsv, {});
  assert.match(out.headers['Content-Type'], /text\/csv/);
  assert.match(out.headers['Content-Disposition'], /attachment/);
  assert.equal(out.text.split('\n')[0],
    'Business,Category,Category detail,Owner,Owner email,Owner phone,City,WhatsApp number,WhatsApp connected,Plan,Status,Active,Created');
  assert.equal(out.text.trim().split('\n').length, 7);
});

test('export: a full row - owner, phone left as-is, plan, status, yes / no', async () => {
  const out = await call(reports.exportBusinessesCsv, {});
  const line = out.text.split('\n').find((l) => l.startsWith('Biz b1,'));
  assert.equal(line, 'Biz b1,Travels,,Ravi,ravi@example.com,+919876543210,Pune,919284128827,yes,Pro,active,yes,2026-10-01T00:00:00Z');
});

test('export: no subscription gives empty plan and status; plan without display name falls back to its name', async () => {
  const out = await call(reports.exportBusinessesCsv, {});
  const b2 = out.text.split('\n').find((l) => l.startsWith('Biz b2,'));
  assert.ok(b2.includes(',no,,,no,'), b2);
  const b3 = out.text.split('\n').find((l) => l.startsWith('Biz b3,'));
  assert.ok(b3.includes(',yes,trial,trial,yes,'), b3);
});

test('export: category detail is the typed category for general and the sub-categories for multi_brand', async () => {
  const out = await call(reports.exportBusinessesCsv, {});
  const lines = out.text.split('\n');
  assert.ok(lines.find((l) => l.startsWith('Biz b3,')).startsWith('Biz b3,General,Hotel,'));
  assert.ok(lines.find((l) => l.startsWith('Biz b4,')).startsWith('Biz b4,Multi brand,Cab; Salon; oldcat,,,,'));
  assert.ok(lines.find((l) => l.startsWith('Biz b5,')).startsWith('Biz b5,mystery,,'));
});

test('export: an owner name that looks like a formula is neutralised', async () => {
  const out = await call(reports.exportBusinessesCsv, {});
  assert.ok(out.text.includes("'=cmd|calc"));
});

test('export: same filters as the list', async () => {
  const connected = await call(reports.exportBusinessesCsv, { query: { connected: 'false' } });
  assert.deepEqual(connected.text.trim().split('\n').slice(1).map((l) => l.split(',')[0]), ['Biz b2']);
  const searched = await call(reports.exportBusinessesCsv, { query: { search: 'ravi', businessCategory: 'travels' } });
  assert.deepEqual(searched.text.trim().split('\n').slice(1).map((l) => l.split(',')[0]), ['Biz b1', 'Biz b6']);
});

test('export: logs user id, filters and row count', async () => {
  await call(reports.exportBusinessesCsv, { query: { isActive: 'false' } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /businesses: user=admin-1/);
  assert.match(logs[0], /"isActive":false/);
  assert.match(logs[0], /rows=1/);
});
