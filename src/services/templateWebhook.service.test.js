// Run: node --test src/services/templateWebhook.service.test.js
// Template webhook events → message_templates. The name fallback (a row that
// never got a meta_template_id) is scoped to the business that owns the
// event's WABA, so a same-named template of another business is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let templates; let businesses;
const from = (table) => {
  const rowsFor = () => (table === 'businesses' ? businesses : templates);
  const filters = []; let payload; let limitN;
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    update: (p) => { payload = p; return q; },
    limit: (n) => { limitN = n; return q; },
    maybeSingle: async () => {
      const hit = rowsFor().filter(r => filters.every(f => f(r)));
      if (hit.length > 1) return { data: null, error: { message: 'multiple rows' } };
      if (payload && hit[0]) Object.assign(hit[0], payload);
      return { data: hit[0] ? { ...hit[0] } : null, error: null };
    },
    then: (resolve, reject) => {
      const hit = rowsFor().filter(r => filters.every(f => f(r))).slice(0, limitN);
      return Promise.resolve({ data: hit, error: null }).then(resolve, reject);
    }
  };
  return q;
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const { updateTemplateForWebhook, qualityUpdateFields, categoryUpdateFields } = require('./templateWebhook.service');

test.beforeEach(() => {
  businesses = [{ id: 'bizA', waba_id: 'wabaA' }, { id: 'bizB', waba_id: 'wabaB' }];
  templates = [
    { id: 'tA', business_id: 'bizA', name: 'promo', language: 'en_US', meta_template_id: null, status: 'draft' },
    { id: 'tB', business_id: 'bizB', name: 'promo', language: 'en_US', meta_template_id: null, status: 'draft' }
  ];
});

test('name fallback only touches the business that owns the event\'s WABA', async () => {
  const { row, error } = await updateTemplateForWebhook({ name: 'promo', language: 'en_US', wabaId: 'wabaB' }, { status: 'approved' });
  assert.equal(error, null);
  assert.equal(row.id, 'tB');
  assert.equal(templates.find(t => t.id === 'tA').status, 'draft'); // the other business's same-named row is untouched
  assert.equal(templates.find(t => t.id === 'tB').status, 'approved');
});

test('name fallback does nothing when the WABA is unknown, missing or shared', async () => {
  for (const wabaId of ['unknown', undefined, null]) {
    const { row } = await updateTemplateForWebhook({ name: 'promo', language: 'en_US', wabaId }, { status: 'approved' });
    assert.equal(row, null, String(wabaId));
  }
  businesses.push({ id: 'bizC', waba_id: 'wabaA' }); // two businesses on one WABA: ambiguous
  const { row } = await updateTemplateForWebhook({ name: 'promo', language: 'en_US', wabaId: 'wabaA' }, { status: 'approved' });
  assert.equal(row, null);
  assert.ok(templates.every(t => t.status === 'draft'));
});

test('name fallback is also language-scoped when Meta sends the language, and skips registered rows', async () => {
  templates.push({ id: 'tA2', business_id: 'bizA', name: 'promo', language: 'hi', meta_template_id: null, status: 'draft' });
  const { row } = await updateTemplateForWebhook({ name: 'promo', language: 'hi', wabaId: 'wabaA' }, { status: 'approved' });
  assert.equal(row.id, 'tA2');
  assert.equal(templates.find(t => t.id === 'tA').status, 'draft');

  templates.find(t => t.id === 'tB').meta_template_id = 'mB';
  const none = await updateTemplateForWebhook({ name: 'promo', language: 'en_US', wabaId: 'wabaB' }, { status: 'approved' });
  assert.equal(none.row, null);
});

test('meta_template_id match is used first', async () => {
  templates.find(t => t.id === 'tA').meta_template_id = 'mA';
  const { row } = await updateTemplateForWebhook({ metaTemplateId: 'mA', name: 'promo', wabaId: 'wabaB' }, { quality_score: 'RED' });
  assert.equal(row.id, 'tA');
  assert.equal(templates.find(t => t.id === 'tB').quality_score, undefined);
});

test('quality update event → quality_score (uppercased); nothing to store without one', () => {
  assert.deepEqual(qualityUpdateFields({ new_quality_score: 'yellow', previous_quality_score: 'GREEN' }), { quality_score: 'YELLOW' });
  assert.equal(qualityUpdateFields({}), null);
  assert.equal(qualityUpdateFields(undefined), null);
});

test('category update event → category only for MARKETING / UTILITY', () => {
  assert.deepEqual(categoryUpdateFields({ new_category: 'UTILITY', previous_category: 'MARKETING' }), { category: 'UTILITY' });
  assert.deepEqual(categoryUpdateFields({ new_category: 'marketing' }), { category: 'MARKETING' });
  assert.equal(categoryUpdateFields({ new_category: 'AUTHENTICATION' }), null);
  assert.equal(categoryUpdateFields({ correct_category: 'UTILITY' }), null); // a heads-up, not a change
  assert.equal(categoryUpdateFields({}), null);
});
