// Run: node --test src/services/broadcastAudience.resolve.test.js
// resolveAudience against an in-memory stand-in for the customers and
// bookings tables (eq / neq / in, including the 'fields->>course' JSON path).
const test = require('node:test');
const assert = require('node:assert/strict');

const tables = {
  customers: [
    { id: 'c1', business_id: 'b', whatsapp_number: '911', name: 'Asha', opted_in: true, is_blocked: false },
    { id: 'c2', business_id: 'b', whatsapp_number: '912', name: 'Ravi', opted_in: true, is_blocked: false },
    { id: 'c3', business_id: 'b', whatsapp_number: '913', name: 'Meena', opted_in: false, is_blocked: false }, // not opted in
    { id: 'c4', business_id: 'b', whatsapp_number: '914', name: 'Kiran', opted_in: true, is_blocked: true },   // blocked
    { id: 'c5', business_id: 'b', whatsapp_number: '915', name: 'Neha', opted_in: true, is_blocked: false },   // no request
    { id: 'c6', business_id: 'b', whatsapp_number: '917', name: 'Sunil', opted_in: true, is_blocked: false, opted_out_at: '2026-10-01T10:00:00Z' }, // sent STOP
    { id: 'x1', business_id: 'other', whatsapp_number: '916', name: 'Other', opted_in: true, is_blocked: false }
  ],
  bookings: [
    { customer_id: 'c1', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c1', business_id: 'b', form_key: 'admission', status: 'pending', fields: { course: 'Abacus' } }, // same parent twice
    { customer_id: 'c2', business_id: 'b', form_key: 'demo', status: 'cancelled', fields: { course: 'Vedic Maths' } }, // "Not interested"
    { customer_id: 'c3', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c4', business_id: 'b', form_key: 'admission', status: 'pending', fields: { course: 'Abacus' } },
    { customer_id: 'c5', business_id: 'b', form_key: null, status: 'pending', fields: {} },                         // chat booking
    { customer_id: 'c6', business_id: 'b', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } },     // opted out
    { customer_id: 'x1', business_id: 'other', form_key: 'demo', status: 'pending', fields: { course: 'Abacus' } }
  ]
};
const valueOf = (row, col) => {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  return m ? (row[m[1]] || {})[m[2]] : row[col];
};
const query = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => valueOf(r, c) === v); return q; },
    neq: (c, v) => { filters.push(r => valueOf(r, c) !== v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(valueOf(r, c))); return q; },
    // PostgREST `is null`: a missing column reads as null, like a row from before the column existed.
    is: (c, v) => { filters.push(r => (valueOf(r, c) ?? null) === v); return q; },
    then: (resolve) => resolve({ data: tables[table].filter(r => filters.every(f => f(r))), error: null })
  };
  return q;
};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { from: query } };
const { resolveAudience, normalizeAudience } = require('./broadcastAudience.service');

const names = async (filter, params) => {
  const a = normalizeAudience(filter, params);
  return (await resolveAudience('b', a.filter, a.params)).map(c => c.name).sort();
};

test('all customers: every opted-in, non-blocked, not-opted-out customer of this business', async () => {
  assert.deepEqual(await names('all_customers'), ['Asha', 'Neha', 'Ravi']);
});

test('a customer who sent STOP (opted_out_at set) is left out of every audience', async () => {
  assert.ok(!(await names('all_customers')).includes('Sunil'));
  assert.ok(!(await names('coaching_requests', { form: 'demo' })).includes('Sunil'));
  assert.ok(!(await names('coaching_requests', { form: 'any', course: 'Abacus', skipClosed: false })).includes('Sunil'));
});

test('parents with a request: opted-in only, closed requests skipped, each parent once', async () => {
  assert.deepEqual(await names('coaching_requests', { form: 'any' }), ['Asha']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', skipClosed: false }), ['Asha', 'Ravi']);
});

test('form and course filters', async () => {
  assert.deepEqual(await names('coaching_requests', { form: 'admission' }), ['Asha']);
  assert.deepEqual(await names('coaching_requests', { form: 'demo', skipClosed: false }), ['Asha', 'Ravi']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', course: 'Vedic Maths', skipClosed: false }), ['Ravi']);
  assert.deepEqual(await names('coaching_requests', { form: 'any', course: 'Chess' }), []);
});
