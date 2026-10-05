// Run: node --test src/controllers/messageTemplate.buttonActions.test.js
// #6 Phase 4b: quick-reply buttons on create (POST /api/message-templates) and
// PUT /api/message-templates/:id/button-actions. In-memory Supabase; Meta and
// the other services are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = 'b1';
const OTHER = 'b2';
const NODE = '33333333-3333-4333-8333-333333333333';
let db; let inserts; let updates;

const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const matching = () => db[table].filter((r) => filters.every(([c, v]) => r[c] === v));
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push([c, v]); return q; },
    insert: (row) => { op = 'insert'; inserts.push(row); payload = { id: 't-new', status: 'draft', ...row }; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    maybeSingle: async () => ({ data: matching()[0] || null, error: null }),
    single: async () => {
      if (op === 'insert') return { data: payload, error: null };
      const row = matching()[0];
      updates.push(payload);
      Object.assign(row, payload);
      return { data: row, error: null };
    }
  };
  return q;
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../config/env', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { decrypt: (x) => x });
stub('../services/business.service', {});
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.example' });
const { createMessageTemplate, setButtonActions } = require('./messageTemplate.controller');

const run = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: BIZ }, params: {}, body: {}, ...req }, res, (err) => { throw err; });
  return res;
};
const create = (body) => run(createMessageTemplate, { body });
const put = (id, body) => run(setButtonActions, { params: { id }, body });

const synced = (over = {}) => ({
  id: 't1', business_id: BIZ, name: 'promo', status: 'approved', source: 'meta_sync', meta_deleted_at: null, button_actions: null,
  meta_components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Site', url: 'https://x.example.com' }, { type: 'QUICK_REPLY', text: 'Prices' }, { type: 'QUICK_REPLY', text: 'Stop' }] }],
  ...over
});

test.beforeEach(() => {
  inserts = []; updates = [];
  db = {
    message_templates: [synced()],
    flow_nodes: [
      { id: NODE, business_id: BIZ, node_type: 'question' },
      { id: 'reply-1', business_id: BIZ, node_type: 'reply' },
      { id: 'trigger-1', business_id: BIZ, node_type: 'trigger' },
      { id: 'foreign', business_id: OTHER, node_type: 'reply' }
    ]
  };
});

// ── create ──

test('create: quick replies with actions - components, button_actions and send_support ok', async () => {
  const res = await create({
    name: 'promo_qr', bodyText: 'Hi there.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
      { type: 'QUICK_REPLY', text: 'Book', action: { type: 'node', nodeId: NODE } },
      { type: 'QUICK_REPLY', text: 'Not now' }
    ]
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(inserts[0].meta_components[1].buttons.map((b) => b.type), ['QUICK_REPLY', 'QUICK_REPLY', 'QUICK_REPLY']);
  assert.deepEqual(inserts[0].button_actions, [
    { index: 0, text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
    { index: 1, text: 'Book', action: { type: 'node', nodeId: NODE } }
  ]);
  assert.equal(inserts[0].send_support, 'ok');
});

test('create: no actions -> no button_actions key at all (inserts keep working before the migration)', async () => {
  await create({ name: 'plain_qr', bodyText: 'Hi there.', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] });
  assert.equal('button_actions' in inserts[0], false);
  await create({ name: 'no_buttons', bodyText: 'Hi there.' });
  assert.equal('button_actions' in inserts[1], false);
});

test('create: a node action must be a reply or question node of this business', async () => {
  for (const nodeId of ['trigger-1', 'foreign', 'missing']) {
    const res = await create({ name: 'bad_node', bodyText: 'Hi there.', buttons: [{ type: 'QUICK_REPLY', text: 'Go', action: { type: 'node', nodeId } }] });
    assert.equal(res.statusCode, 400, nodeId);
    assert.match(res.body.message, /Button 0: the chosen flow node was not found/);
  }
  assert.equal((await create({ name: 'ok_node', bodyText: 'Hi there.', buttons: [{ type: 'QUICK_REPLY', text: 'Go', action: { type: 'node', nodeId: 'reply-1' } }] })).statusCode, 201);
  assert.equal(inserts.length, 1);
});

test('create: an action that is not one of the four types, or ungrouped quick replies, is a 400', async () => {
  const badAction = await create({ name: 'bad_action', bodyText: 'Hi there.', buttons: [{ type: 'QUICK_REPLY', text: 'Go', action: { type: 'explode' } }] });
  assert.equal(badAction.statusCode, 400);
  assert.match(badAction.body.message, /Button 1: action must be/);
  const ungrouped = await create({
    name: 'ungrouped', bodyText: 'Hi there.',
    buttons: [{ type: 'QUICK_REPLY', text: 'A' }, { type: 'URL', text: 'Site', url: 'https://x.example.com' }, { type: 'QUICK_REPLY', text: 'B' }]
  });
  assert.equal(ungrouped.statusCode, 400);
  assert.match(ungrouped.body.message, /grouped together/);
  assert.equal(inserts.length, 0);
});

// ── PUT /:id/button-actions ──

test('set: stores actions with the button text; response is the camelCase template', async () => {
  const res = await put('t1', { actions: [
    { index: 1, action: { type: 'keyword', keyword: ' price ' } },
    { index: 2, action: { type: 'optout' } }
  ] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.message_templates[0].button_actions, [
    { index: 1, text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
    { index: 2, text: 'Stop', action: { type: 'optout' } }
  ]);
  assert.deepEqual(res.body.data.buttonActions, db.message_templates[0].button_actions);
});

test('set: replaces the whole list; an empty list or null actions clear it (stored as null)', async () => {
  await put('t1', { actions: [{ index: 1, action: { type: 'menu' } }] });
  await put('t1', { actions: [{ index: 2, action: { type: 'menu' } }] });
  assert.deepEqual(db.message_templates[0].button_actions.map((a) => a.index), [2]);
  await put('t1', { actions: [{ index: 2, action: null }] });
  assert.equal(db.message_templates[0].button_actions, null);
  await put('t1', { actions: [{ index: 1, action: { type: 'menu' } }] });
  await put('t1', { actions: [] });
  assert.equal(db.message_templates[0].button_actions, null);
});

test('set: a node action is checked against this business\'s flow', async () => {
  const bad = await put('t1', { actions: [{ index: 1, action: { type: 'node', nodeId: 'foreign' } }] });
  assert.equal(bad.statusCode, 400);
  assert.equal(updates.length, 0);
  assert.equal((await put('t1', { actions: [{ index: 1, action: { type: 'node', nodeId: NODE } }] })).statusCode, 200);
});

test('set: 404 for a missing / other business\'s template; 400 for a URL button, a bad index, a bad action or a non-list', async () => {
  assert.equal((await put('nope', { actions: [] })).statusCode, 404);
  db.message_templates.push(synced({ id: 't2', business_id: OTHER }));
  assert.equal((await put('t2', { actions: [] })).statusCode, 404);
  for (const actions of [[{ index: 0, action: { type: 'menu' } }], [{ index: 7, action: { type: 'menu' } }], [{ index: 1, action: { type: 'wat' } }], 'x', undefined]) {
    const res = await put('t1', { actions });
    assert.equal(res.statusCode, 400, JSON.stringify(actions));
  }
  assert.equal(updates.length, 0);
});

test('set: works on a synced template of any status (e.g. approved, soft-deleted keeps metaDeleted)', async () => {
  db.message_templates[0].meta_deleted_at = '2026-10-01T00:00:00Z';
  const res = await put('t1', { actions: [{ index: 1, action: { type: 'menu' } }] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.metaDeleted, true);
});
