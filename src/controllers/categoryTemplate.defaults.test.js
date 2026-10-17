// Run: node --test src/controllers/categoryTemplate.defaults.test.js
// Super Admin template endpoints: set/unset default (one default per category),
// node-texts (text only, never structure), preview, and the business-name warnings
// returned when cloning a template from a business. In-memory Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const { createFakeSupabase } = require('../test-support/fakeSupabase');
const ctl = require('./categoryTemplate.controller');

const node = (id, label, extra = {}) => ({
  id, node_type: 'reply', keyword: id, content_type: 'text', label, label_translations: null,
  options: [], hindi_aliases: [], required: false, ...extra
});
const edge = (id, from, to) => ({ id, from_node_id: from, to_node_id: to, condition_type: 'always', display_order: 0 });
const tpl = (id, category, over = {}) => ({
  id, category, name: id, is_category_template: true, is_default: false, is_active: true, business_id: null,
  nodes: [node('n1', 'Welcome to Sunrise Travels'), node('n2', 'Prices', { label_translations: { hi: 'सनराइज़ ट्रैवल्स की कीमतें' } }), node('n3', 'Bye')],
  edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n2', 'n3')],
  ...over
});

let fake;
// Mirrors supabase/migrations/20261021120000_flow_snapshots_default.sql#set_default_category_template.
const setDefaultRpc = ({ p_template_id }, db) => {
  const target = db.flow_snapshots.find((r) => r.id === p_template_id && r.is_category_template && r.is_active);
  if (!target) return null;
  db.flow_snapshots.filter((r) => r.is_category_template && r.category === target.category && r.is_default && r.id !== target.id)
    .forEach((r) => { r.is_default = false; });
  target.is_default = true;
  return target.category;
};
const supabase = require('../config/supabase');
const realFrom = supabase.from;
supabase.from = (t) => fake.from(t);
supabase.rpc = (n, a) => fake.rpc(n, a);
test.after(() => { supabase.from = realFrom; });

const reset = (rows) => {
  fake = createFakeSupabase({ rpc: { set_default_category_template: setDefaultRpc } });
  fake.db.flow_snapshots = rows;
  fake.db.businesses = [{ id: 'biz-1', name: 'Sunrise Travels', display_name: 'Sunrise' }];
  fake.db.flow_nodes = []; fake.db.flow_edges = [];
  fake.db.business_categories = [{ value: 'travels', label: 'Travels' }, { value: 'general', label: 'General' }];
};

const call = async (handler, { params = {}, body = {}, query = {} } = {}) => {
  const out = {};
  const res = { status: (c) => { out.status = c; return res; }, json: (p) => { out.body = p; return res; } };
  await handler({ params, body, query, user: { userId: 'admin' } }, res, (err) => { throw err; });
  return out;
};
const defaultsOf = (category) => fake.db.flow_snapshots.filter((r) => r.category === category && r.is_default).map((r) => r.id);

test('set-default keeps exactly one default per category and leaves other categories alone', async () => {
  reset([tpl('a', 'travels', { is_default: true }), tpl('b', 'travels'), tpl('g', 'general', { is_default: true })]);
  const out = await call(ctl.setDefaultTemplate, { params: { id: 'b' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.category, 'travels');
  assert.deepEqual(defaultsOf('travels'), ['b']);
  assert.deepEqual(defaultsOf('general'), ['g']);
  await call(ctl.setDefaultTemplate, { params: { id: 'a' } });
  assert.deepEqual(defaultsOf('travels'), ['a']);
  await call(ctl.setDefaultTemplate, { params: { id: 'a' } }); // idempotent
  assert.deepEqual(defaultsOf('travels'), ['a']);
});

test('set-default refuses an unknown or inactive template and changes nothing', async () => {
  reset([tpl('a', 'travels', { is_default: true }), tpl('b', 'travels', { is_active: false })]);
  assert.equal((await call(ctl.setDefaultTemplate, { params: { id: 'b' } })).status, 404);
  assert.equal((await call(ctl.setDefaultTemplate, { params: { id: 'zzz' } })).status, 404);
  assert.deepEqual(defaultsOf('travels'), ['a']);
});

test('unset-default clears only that template', async () => {
  reset([tpl('a', 'travels', { is_default: true }), tpl('g', 'general', { is_default: true })]);
  const out = await call(ctl.unsetDefaultTemplate, { params: { id: 'a' } });
  assert.equal(out.status, 200);
  assert.deepEqual(defaultsOf('travels'), []);
  assert.deepEqual(defaultsOf('general'), ['g']);
  assert.equal((await call(ctl.unsetDefaultTemplate, { params: { id: 'zzz' } })).status, 404);
});

test('node-texts changes only label / label_translations; ids, order, other columns and edges are untouched', async () => {
  reset([tpl('a', 'travels')]);
  const before = JSON.parse(JSON.stringify(fake.db.flow_snapshots[0]));
  const out = await call(ctl.updateTemplateNodeTexts, {
    params: { id: 'a' },
    body: { nodes: [
      { id: 'n1', label: '  Welcome to {{businessName}}  ' },
      { id: 'n2', labelTranslations: { hi: '{{businessName}} की कीमतें', mr: 'किंमती' } }
    ] }
  });
  assert.equal(out.status, 200);
  const after = fake.db.flow_snapshots[0];
  assert.deepEqual(after.edges, before.edges);
  assert.deepEqual(after.nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.equal(after.nodes[0].label, 'Welcome to {{businessName}}');
  assert.deepEqual(after.nodes[1].label_translations, { hi: '{{businessName}} की कीमतें', mr: 'किंमती' });
  assert.equal(after.nodes[1].label, 'Prices');           // label not sent -> kept
  assert.deepEqual(after.nodes[2], before.nodes[2]);       // untouched node identical
  for (const i of [0, 1]) {                                // everything except the text columns identical
    const strip = (n) => { const c = { ...n }; delete c.label; delete c.label_translations; return c; };
    assert.deepEqual(strip(after.nodes[i]), strip(before.nodes[i]));
  }
});

test('node-texts rejects structural fields, unknown nodes, bad text and writes nothing', async () => {
  reset([tpl('a', 'travels')]);
  const before = JSON.stringify(fake.db.flow_snapshots[0]);
  const bad = [
    [{ id: 'n1' }],                                              // nothing to change
    [{ id: 'nope', label: 'x' }],                                // unknown node
    [{ id: 'n1', label: '   ' }],                                // empty text
    [{ id: 'n1', labelTranslations: { xx: 'x' } }],              // unknown language
    [{ id: 'n1', label: 'ok' }, { id: 'n1', label: 'dup' }],     // duplicate
    []
  ];
  for (const nodes of bad) {
    const out = await call(ctl.updateTemplateNodeTexts, { params: { id: 'a' }, body: { nodes } });
    assert.equal(out.status, 400, JSON.stringify(nodes));
  }
  assert.equal((await call(ctl.updateTemplateNodeTexts, { params: { id: 'zzz' }, body: { nodes: [{ id: 'n1', label: 'x' }] } })).status, 404);
  // keyword / node_type / edges sent alongside the text are ignored, never applied
  await call(ctl.updateTemplateNodeTexts, { params: { id: 'a' }, body: { nodes: [{ id: 'n1', label: 'New', keyword: 'hacked', node_type: 'question' }] } });
  assert.equal(fake.db.flow_snapshots[0].nodes[0].keyword, 'n1');
  assert.equal(fake.db.flow_snapshots[0].nodes[0].node_type, 'reply');
  assert.notEqual(before, JSON.stringify(fake.db.flow_snapshots[0])); // only the valid call wrote
});

test('GET /:id returns the full raw nodes and edges for preview', async () => {
  reset([tpl('a', 'travels', { is_default: true })]);
  const out = await call(ctl.getCategoryTemplate, { params: { id: 'a' } });
  assert.equal(out.status, 200);
  assert.equal(out.body.data.isDefault, true);
  assert.equal(out.body.data.nodes.length, 3);
  assert.ok('from_node_id' in out.body.data.edges[0]);      // raw snake_case, not renamed
  assert.equal((await call(ctl.getCategoryTemplate, { params: { id: 'zzz' } })).status, 404);
});

test('findBusinessNameWarnings flags nodes naming the business in text or translations (case-insensitive)', () => {
  const nodes = [
    node('n1', 'Welcome to Sunrise Travels'),
    node('n2', 'Prices', { label_translations: { hi: 'आपका SUNRISE में स्वागत है' } }),
    node('n3', 'Welcome to {{businessName}}'),
    node('n4', 'We run on time', { keyword: 'about' })
  ];
  const w = ctl.findBusinessNameWarnings(nodes, ['Sunrise Travels', 'Sunrise']);
  assert.deepEqual(w.map((x) => x.key).sort(), ['n1', 'n2']);
  assert.deepEqual(ctl.findBusinessNameWarnings(nodes, ['ab', null, '']), []); // too short / empty names ignored
});

test('cloneFromBusiness returns a warnings list for text that still names the source business', async () => {
  reset([]);
  fake.db.flow_nodes = [
    { business_id: 'biz-1', ...node('c1', 'Welcome to Sunrise Travels') },
    { business_id: 'biz-1', ...node('c2', 'Prices') }
  ];
  fake.db.flow_edges = [{ business_id: 'biz-1', ...edge('ce1', 'c1', 'c2') }];
  const out = await call(ctl.cloneFromBusiness, { body: { businessId: 'biz-1', category: 'travels', name: 'Clone' } });
  assert.equal(out.status, 201);
  assert.deepEqual(out.body.data.warnings.map((x) => x.key), ['c1']);
  assert.equal(fake.db.flow_snapshots.filter((r) => r.is_category_template).length, 1);
});
