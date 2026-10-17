// Run: node --test src/services/defaultSetup.service.test.js
// applyDefaultSetup: a new business gets its category's default template graph (else the
// 'general' default) plus the category's flow_fields; never overwrites; never throws.
// In-memory Supabase; the real flow import / write code runs against it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

let fake; let invalidated; let tenantInvalidated; let failOn;
const stubModule = (file, exports) => {
  const p = require.resolve(file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stubModule(path.join(__dirname, '..', 'config', 'env.js'), { R2_PUBLIC_URL: 'https://r2.test' });
stubModule(path.join(__dirname, '..', 'utils', 'logger.js'), { info: () => {}, warn: () => {}, error: () => {} });
stubModule(path.join(__dirname, '..', 'config', 'supabase.js'), {
  from: (t) => {
    const q = fake.from(t);
    if (failOn && failOn.table === t) {
      const orig = q[failOn.op].bind(q);
      q[failOn.op] = (...args) => { orig(...args); return { ...q, then: (res) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(res) }; };
    }
    return q;
  },
  rpc: (n, a) => fake.rpc(n, a)
});
stubModule(path.join(__dirname, 'chatbot.service.js'), { invalidateRulesCache: async (id) => { invalidated.push(id); } });
stubModule(path.join(__dirname, 'tenant.service.js'), { invalidateTenantCache: async (id) => { tenantInvalidated.push(id); } });

const { applyDefaultSetup } = require('./defaultSetup.service');

const B = 'biz-1';
const node = (id, label, extra = {}) => ({ id, node_type: 'reply', keyword: id, content_type: 'text', label, ...extra });
const template = (id, category, name, over = {}) => ({
  id, category, name, is_category_template: true, is_default: true, is_active: true, business_id: null,
  nodes: [node('n1', `Hello from ${name}`), node('n2', 'Prices')],
  edges: [{ id: 'e1', from_node_id: 'n1', to_node_id: 'n2', condition_type: 'always' }],
  ...over
});
const FIELDS_TRAVELS = [{ key: 'name', label: 'Name' }];
const FIELDS_GENERAL = [{ key: 'phone', label: 'Phone' }];

const seed = (rows = {}) => {
  fake = createFakeSupabase({});
  fake.db.businesses = [{ id: B, business_category: 'travels', flow_fields: [], phone_number_id: null, seeded_from_template_name: null }];
  Object.assign(fake.db, rows);
};
const bizNodes = () => (fake.db.flow_nodes || []).filter((n) => n.business_id === B);

test.beforeEach(() => { invalidated = []; tenantInvalidated = []; failOn = null; });

test('a new business gets its category default template, form fields and seeded_from_template_name', async () => {
  seed({
    flow_snapshots: [template('t-travels', 'travels', 'Travels starter'), template('t-general', 'general', 'General starter')],
    business_category_templates: [
      { business_category: 'travels', flow_fields: FIELDS_TRAVELS },
      { business_category: 'general', flow_fields: FIELDS_GENERAL }
    ]
  });
  const result = await applyDefaultSetup(B);
  assert.equal(result.applied, true);
  assert.equal(result.templateId, 't-travels');
  assert.deepEqual(bizNodes().map((n) => n.label).sort(), ['Hello from Travels starter', 'Prices']);
  assert.equal((fake.db.flow_edges || []).filter((e) => e.business_id === B).length, 1);
  assert.notEqual(bizNodes()[0].id, 'n1'); // fresh ids, the template is shared across businesses
  assert.deepEqual(fake.db.businesses[0].flow_fields, FIELDS_TRAVELS);
  assert.equal(fake.db.businesses[0].seeded_from_template_name, 'Travels starter');
});

test('a business whose category has no default falls back to the general default (graph and form fields)', async () => {
  seed({
    flow_snapshots: [template('t-general', 'general', 'General starter')],
    business_category_templates: [{ business_category: 'general', flow_fields: FIELDS_GENERAL }]
  });
  const result = await applyDefaultSetup(B);
  assert.equal(result.templateId, 't-general');
  assert.equal(bizNodes().length, 2);
  assert.deepEqual(fake.db.businesses[0].flow_fields, FIELDS_GENERAL);
  assert.equal(fake.db.businesses[0].seeded_from_template_name, 'General starter');
});

test('a non-default or inactive template is not used; with no default and no general the business stays empty', async () => {
  seed({
    flow_snapshots: [
      template('t-travels', 'travels', 'Travels starter', { is_default: false }),
      template('t-general', 'general', 'General starter', { is_active: false })
    ]
  });
  const result = await applyDefaultSetup(B);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no_default_template');
  assert.equal(bizNodes().length, 0);
  assert.equal(fake.db.businesses[0].seeded_from_template_name, null);
  assert.deepEqual(fake.db.businesses[0].flow_fields, []);
});

test('a business that already has nodes is left completely alone (graph, flow_fields, seed marker)', async () => {
  seed({
    flow_snapshots: [template('t-travels', 'travels', 'Travels starter')],
    business_category_templates: [{ business_category: 'travels', flow_fields: FIELDS_TRAVELS }],
    flow_nodes: [{ id: 'mine', business_id: B, node_type: 'reply', keyword: 'hi', label: 'My own flow' }]
  });
  const result = await applyDefaultSetup(B);
  assert.deepEqual(result, { applied: false, reason: 'already_has_nodes' });
  assert.deepEqual(bizNodes().map((n) => n.id), ['mine']);
  assert.deepEqual(fake.db.businesses[0].flow_fields, []);
  assert.equal(fake.db.businesses[0].seeded_from_template_name, null);
  assert.deepEqual(invalidated, []);
});

test('running it twice is idempotent', async () => {
  seed({ flow_snapshots: [template('t-travels', 'travels', 'Travels starter')] });
  await applyDefaultSetup(B);
  const first = bizNodes().map((n) => n.id);
  const second = await applyDefaultSetup(B);
  assert.equal(second.reason, 'already_has_nodes');
  assert.deepEqual(bizNodes().map((n) => n.id), first);
});

test('existing flow_fields are never overwritten, but the graph is still seeded', async () => {
  const mine = [{ key: 'custom', label: 'Custom' }];
  seed({
    flow_snapshots: [template('t-travels', 'travels', 'Travels starter')],
    business_category_templates: [{ business_category: 'travels', flow_fields: FIELDS_TRAVELS }]
  });
  fake.db.businesses[0].flow_fields = mine;
  await applyDefaultSetup(B);
  assert.equal(bizNodes().length, 2);
  assert.deepEqual(fake.db.businesses[0].flow_fields, mine);
});

test('the rules cache is invalidated after a seed, and the tenant cache too when a number is connected', async () => {
  seed({ flow_snapshots: [template('t-travels', 'travels', 'Travels starter')] });
  fake.db.businesses[0].phone_number_id = 'pn-1';
  await applyDefaultSetup(B);
  assert.ok(invalidated.includes(B));
  assert.deepEqual(tenantInvalidated, ['pn-1']);
});

test('the rules cache is invalidated even when nothing was applicable (no default anywhere)', async () => {
  seed({});
  await applyDefaultSetup(B);
  assert.deepEqual(invalidated, [B]);
});

test('never throws: a failing graph write is logged, the partial graph is rolled back and the business stays empty', async () => {
  seed({ flow_snapshots: [template('t-travels', 'travels', 'Travels starter')] });
  failOn = { table: 'flow_edges', op: 'insert' };
  const result = await applyDefaultSetup(B);
  assert.deepEqual(result, { applied: false, reason: 'error' });
  assert.equal(bizNodes().length, 0);
  assert.equal(fake.db.businesses[0].seeded_from_template_name, null);
  assert.ok(invalidated.includes(B));
});

test('never throws on an unknown business', async () => {
  seed({});
  const result = await applyDefaultSetup('nope');
  assert.equal(result.applied, false);
});
