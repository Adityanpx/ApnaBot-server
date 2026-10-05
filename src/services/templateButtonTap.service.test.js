// Run: node --test src/services/templateButtonTap.service.test.js
// resolveButtonTap against an in-memory stand-in for Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TPL = '0b3f6c1e-1111-4222-8333-944455556666';
const NODE = '33333333-3333-4333-8333-333333333333';

let db; let failTemplates;
const from = (table) => {
  const filters = [];
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    maybeSingle: async () => {
      if (table === 'message_templates' && failTemplates) return { data: null, error: { message: 'column button_actions does not exist' } };
      return { data: db[table].find(r => filters.every(f => f(r))) || null, error: null };
    }
  };
  return q;
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
const { resolveButtonTap } = require('./templateButtonTap.service');

const payload = `tpl:${TPL}:0`;
test.beforeEach(() => {
  failTemplates = false;
  db = {
    message_templates: [{ id: TPL, business_id: BIZ, button_actions: [{ index: 0, text: 'Book', action: { type: 'node', nodeId: NODE } }] }],
    flow_nodes: [{ id: NODE, business_id: BIZ, node_type: 'question', is_active: true }]
  };
});

test('node action -> the node (question)', async () => {
  const r = await resolveButtonTap(BIZ, { payload, text: 'Book' });
  assert.equal(r.kind, 'node');
  assert.equal(r.node.id, NODE);
  assert.equal(r.node.nodeType, 'question');
});

test('node action -> reply node, active', async () => {
  db.flow_nodes[0].node_type = 'reply';
  assert.equal((await resolveButtonTap(BIZ, { payload, text: 'Book' })).kind, 'node');
});

test('node gone / inactive reply / unsupported type / other business -> the button text', async () => {
  const text = { kind: 'text', text: 'Book' };
  db.flow_nodes[0].is_active = false; db.flow_nodes[0].node_type = 'reply';
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), text);
  db.flow_nodes[0].is_active = true; db.flow_nodes[0].node_type = 'trigger';
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), text);
  db.flow_nodes[0].node_type = 'question'; db.flow_nodes[0].business_id = OTHER;
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), text);
  db.flow_nodes = [];
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), text);
});

test("another business's template payload is unknown: the button text, never that template's action", async () => {
  assert.deepEqual(await resolveButtonTap(OTHER, { payload, text: 'Book' }), { kind: 'text', text: 'Book' });
});

test('template lookup failing (column missing before the migration) still opts out on an opt-out label', async () => {
  failTemplates = true;
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), { kind: 'text', text: 'Book' });
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Stop promotions' }), { kind: 'optout' });
});

test('keyword / optout / menu actions need no node lookup', async () => {
  db.message_templates[0].button_actions = [
    { index: 0, text: 'Book', action: { type: 'keyword', keyword: 'price' } },
    { index: 1, text: 'No more', action: { type: 'optout' } }
  ];
  db.flow_nodes = [];
  assert.deepEqual(await resolveButtonTap(BIZ, { payload, text: 'Book' }), { kind: 'action', action: { type: 'keyword', keyword: 'price' } });
  assert.deepEqual(await resolveButtonTap(BIZ, { payload: `tpl:${TPL}:1`, text: 'No more' }), { kind: 'optout' });
});

test('foreign payload: no template lookup at all', async () => {
  failTemplates = true; // would be logged if it were queried
  assert.deepEqual(await resolveButtonTap(BIZ, { payload: 'Yes', text: 'Yes' }), { kind: 'text', text: 'Yes' });
  assert.equal(await resolveButtonTap(BIZ, {}), null);
});
