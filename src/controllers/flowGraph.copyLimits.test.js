// Run: node --test src/controllers/flowGraph.copyLimits.test.js
// Write-time limits on a reply node's list/button copy (edge label + description, button_text) and
// PUT /full's keep-what-was-omitted rule. Limits apply to NEW or CHANGED values only: a legacy
// over-limit row must still save untouched. In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const controller = require('./flowGraph.controller');

const { B1, B2, uuid } = h;
const LIST = uuid(300);
const BTN = uuid(301);
const TEXT = uuid(302);
const QNODE = uuid(303);
const OTHER_BIZ_NODE = uuid(304);
const LEGACY_EDGE = uuid(400);
const OTHER_BIZ_EDGE = uuid(401);
const RICH_EDGE = uuid(402);

const LONG_LABEL = 'L'.repeat(40);
const LONG_DESC = 'D'.repeat(90);
const LONG_BUTTON = 'B'.repeat(30);

let db;
test.beforeEach(() => {
  db = h.reset();
  db.flow_nodes = [
    { id: LIST, business_id: B1, node_type: 'reply', keyword: 'courses', match_type: 'contains', reply_kind: 'text', content_type: 'list', label: 'Pick a course', label_translations: { hi: 'कोर्स चुनें' }, is_active: true, button_text: LONG_BUTTON, button_text_translations: { hi: LONG_BUTTON } },
    { id: BTN, business_id: B1, node_type: 'reply', keyword: 'menu', match_type: 'contains', reply_kind: 'text', content_type: 'buttons', label: 'Menu', is_active: true },
    { id: TEXT, business_id: B1, node_type: 'reply', keyword: 'fees', match_type: 'contains', reply_kind: 'text', content_type: 'text', label: 'Fees', is_active: true },
    { id: QNODE, business_id: B1, node_type: 'question', field_key: 'name', content_type: 'text', label: 'Name?', options: [] },
    { id: OTHER_BIZ_NODE, business_id: B2, node_type: 'reply', keyword: 'other', content_type: 'list', label: 'Other' }
  ];
  db.flow_edges = [
    { id: LEGACY_EDGE, business_id: B1, from_node_id: LIST, to_node_id: TEXT, label: LONG_LABEL, label_translations: { hi: LONG_LABEL }, description: LONG_DESC, description_translations: { hi: LONG_DESC }, condition: null, preset: null, display_order: 0 },
    { id: OTHER_BIZ_EDGE, business_id: B2, from_node_id: OTHER_BIZ_NODE, to_node_id: OTHER_BIZ_NODE, label: 'x', display_order: 0 },
    { id: RICH_EDGE, business_id: B1, from_node_id: BTN, to_node_id: QNODE, label: 'Book', label_translations: { hi: 'बुक' }, description: 'Starts a booking', description_translations: { hi: 'बुकिंग' }, condition: { field: 'name', equals: 'x' }, preset: { field: 'source', value: 'menu' }, display_order: 0 }
  ];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'coaching' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const edge = (id) => db.flow_edges.find(e => e.id === id);
const node = (id) => db.flow_nodes.find(n => n.id === id);
const message = (out) => out.body.message || out.body.error || JSON.stringify(out.body);

// ---- createEdge ---------------------------------------------------------------------------

test('createEdge: a list row label over 24 is rejected naming the field and limit', async () => {
  const out = await call(controller.createEdge, { body: { fromNodeId: LIST, toNodeId: TEXT, label: 'x'.repeat(25) } });
  assert.equal(out.status, 400);
  assert.match(message(out), /label must be 24 characters or less/);
  assert.equal(db.flow_edges.length, 3);
});

test('createEdge: a buttons row label is limited to 20', async () => {
  const bad = await call(controller.createEdge, { body: { fromNodeId: BTN, toNodeId: TEXT, label: 'x'.repeat(21) } });
  assert.equal(bad.status, 400);
  assert.match(message(bad), /label must be 20 characters or less/);
  const ok = await call(controller.createEdge, { body: { fromNodeId: BTN, toNodeId: TEXT, label: 'x'.repeat(20) } });
  assert.equal(ok.status, 201);
});

test('createEdge: a description over 72 is rejected, even for a buttons parent; 72 is stored', async () => {
  const bad = await call(controller.createEdge, { body: { fromNodeId: BTN, toNodeId: TEXT, label: 'Hi', description: 'd'.repeat(73) } });
  assert.equal(bad.status, 400);
  assert.match(message(bad), /description must be 72 characters or less/);
  const ok = await call(controller.createEdge, {
    body: { fromNodeId: BTN, toNodeId: TEXT, label: 'Hi', description: 'd'.repeat(72), descriptionTranslations: { hi: 'अ' } }
  });
  assert.equal(ok.status, 201);
  const stored = db.flow_edges.find(e => e.label === 'Hi');
  assert.equal(stored.description, 'd'.repeat(72));
  assert.deepEqual(stored.description_translations, { hi: 'अ' });
});

test('createEdge: an over-long translation value is rejected naming language and limit', async () => {
  const out = await call(controller.createEdge, {
    body: { fromNodeId: LIST, toNodeId: TEXT, label: 'Fine', labelTranslations: { hi: 'x'.repeat(25) } }
  });
  assert.equal(out.status, 400);
  assert.match(message(out), /labelTranslations for language "hi" must be 24 characters or less/);
});

test('createEdge: a non-string label is rejected', async () => {
  const out = await call(controller.createEdge, { body: { fromNodeId: LIST, toNodeId: TEXT, label: 42 } });
  assert.equal(out.status, 400);
  assert.match(message(out), /label must be a string/);
});

// ---- updateEdge ---------------------------------------------------------------------------

test('updateEdge: a legacy over-limit row still saves when its copy is not changed', async () => {
  const out = await call(controller.updateEdge, {
    params: { id: LEGACY_EDGE },
    body: { label: LONG_LABEL, labelTranslations: { hi: LONG_LABEL }, description: LONG_DESC, descriptionTranslations: { hi: LONG_DESC }, displayOrder: 3 }
  });
  assert.equal(out.status, 200);
  assert.equal(edge(LEGACY_EDGE).display_order, 3);
  assert.equal(edge(LEGACY_EDGE).label, LONG_LABEL);
});

test('updateEdge: changing one field of a legacy row checks only that field', async () => {
  const okDescription = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { description: 'Short and sweet' } });
  assert.equal(okDescription.status, 200);
  assert.equal(edge(LEGACY_EDGE).label, LONG_LABEL, 'legacy label left alone');

  const badLabel = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { label: 'N'.repeat(30) } });
  assert.equal(badLabel.status, 400);
  assert.match(message(badLabel), /label must be 24 characters or less/);
  assert.equal(edge(LEGACY_EDGE).label, LONG_LABEL);

  const badDescription = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { description: 'd'.repeat(73) } });
  assert.equal(badDescription.status, 400);
});

test('updateEdge: a new translation value on a legacy row is checked, the old ones are not', async () => {
  const bad = await call(controller.updateEdge, {
    params: { id: LEGACY_EDGE }, body: { labelTranslations: { hi: LONG_LABEL, mr: 'M'.repeat(30) } }
  });
  assert.equal(bad.status, 400);
  assert.match(message(bad), /labelTranslations for language "mr" must be 24 characters or less/);
});

test('updateEdge: label and description must be strings; null still clears the description', async () => {
  const badLabel = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { label: ['x'] } });
  assert.equal(badLabel.status, 400);
  assert.match(message(badLabel), /label must be a string/);
  const badDescription = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { description: 5 } });
  assert.equal(badDescription.status, 400);
  const cleared = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { description: null } });
  assert.equal(cleared.status, 200);
  assert.equal(edge(LEGACY_EDGE).description, null);
});

test('updateEdge: another business\'s edge is a 404 and is not touched', async () => {
  const out = await call(controller.updateEdge, { params: { id: OTHER_BIZ_EDGE }, body: { label: 'hacked' } });
  assert.equal(out.status, 404);
  assert.equal(edge(OTHER_BIZ_EDGE).label, 'x');
});

test('updateEdge: the write itself is filtered by business_id', async () => {
  const filters = [];
  const realFrom = h.state.fake.from;
  h.state.fake.from = (t) => {
    const q = realFrom(t);
    if (t !== 'flow_edges') return q;
    const realUpdate = q.update;
    q.update = (p) => {
      const chain = realUpdate(p);
      const realEq = chain.eq;
      chain.eq = (c, v) => { filters.push(c); return realEq(c, v); };
      return chain;
    };
    return q;
  };
  const out = await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { displayOrder: 1 } });
  assert.equal(out.status, 200);
  assert.ok(filters.includes('id') && filters.includes('business_id'));
});

test('updateEdge: display_order is unchanged when the body does not send it', async () => {
  edge(LEGACY_EDGE).display_order = 7;
  await call(controller.updateEdge, { params: { id: LEGACY_EDGE }, body: { description: 'New' } });
  assert.equal(edge(LEGACY_EDGE).display_order, 7);
});

// ---- reply node button_text ---------------------------------------------------------------

test('updateReplyNode: legacy over-limit buttonText saves unchanged, a changed value is checked', async () => {
  const unchanged = await call(controller.updateReplyNode, {
    params: { id: LIST }, body: { buttonText: LONG_BUTTON, buttonTextTranslations: { hi: LONG_BUTTON }, label: 'Pick a course!' }
  });
  assert.equal(unchanged.status, 200);
  assert.equal(node(LIST).label, 'Pick a course!');

  const changed = await call(controller.updateReplyNode, { params: { id: LIST }, body: { buttonText: 'B'.repeat(31) } });
  assert.equal(changed.status, 400);
  assert.match(message(changed), /buttonText must be 20 characters or less/);
  assert.equal(node(LIST).button_text, LONG_BUTTON);

  const ok = await call(controller.updateReplyNode, { params: { id: LIST }, body: { buttonText: 'See courses' } });
  assert.equal(ok.status, 200);
  assert.equal(node(LIST).button_text, 'See courses');
});

test('updateReplyNode: a new over-long buttonText translation is rejected', async () => {
  const out = await call(controller.updateReplyNode, { params: { id: BTN }, body: { buttonTextTranslations: { hi: 'b'.repeat(21) } } });
  assert.equal(out.status, 400);
  assert.match(message(out), /buttonTextTranslations for language "hi" must be 20 characters or less/);
});

test('createReplyNode: an over-long buttonText is rejected', async () => {
  const out = await call(controller.createReplyNode, { body: { keyword: 'brand new', label: 'Hello', buttonText: 'b'.repeat(21) } });
  assert.equal(out.status, 400);
  assert.match(message(out), /buttonText must be 20 characters or less/);
});

// ---- PUT /full ----------------------------------------------------------------------------

let rpcArgs;
const stubRpc = () => {
  rpcArgs = null;
  h.state.fake.rpc = async (name, args) => { rpcArgs = { name, ...args }; return { data: null, error: null }; };
};
const listNode = (extra = {}) => ({ id: LIST, keyword: 'courses', contentType: 'list', label: 'Pick a course', ...extra });
const btnNode = (extra = {}) => ({ id: BTN, keyword: 'menu', contentType: 'buttons', label: 'Menu', ...extra });
const textNode = () => ({ id: TEXT, keyword: 'fees', label: 'Fees' });
const questionNode = () => ({ id: QNODE, fieldKey: 'name', label: 'Name?' });
const fullSave = (replyNodes, edges) => call(controller.saveFullGraph, { body: { replyNodes, questionNodes: [questionNode()], edges } });
const upsertOf = (id) => rpcArgs.p_edge_upserts.find(e => e.id === id);
const nodeUpsertOf = (id) => rpcArgs.p_node_upserts.find(n => n.id === id);

test('PUT /full: an edge sent without description, translations, condition or preset keeps the stored ones', async () => {
  stubRpc();
  const out = await fullSave(
    [listNode(), btnNode(), textNode()],
    [{ id: LEGACY_EDGE, fromNodeId: LIST, toNodeId: TEXT, label: LONG_LABEL }, { id: RICH_EDGE, fromNodeId: BTN, toNodeId: QNODE, label: 'Book' }]
  );
  assert.equal(out.status, 200);
  const rich = upsertOf(RICH_EDGE);
  assert.equal(rich.description, 'Starts a booking');
  assert.deepEqual(rich.description_translations, { hi: 'बुकिंग' });
  assert.deepEqual(rich.label_translations, { hi: 'बुक' });
  assert.deepEqual(rich.condition, { field: 'name', equals: 'x' });
  assert.deepEqual(rich.preset, { field: 'source', value: 'menu' });
});

test('PUT /full: whole edge objects sent back (as GET /full returns them) are saved unchanged', async () => {
  stubRpc();
  const echoed = { id: RICH_EDGE, fromNodeId: BTN, toNodeId: QNODE, label: 'Book', labelTranslations: { hi: 'बुक' }, description: 'Starts a booking', descriptionTranslations: { hi: 'बुकिंग' }, condition: { field: 'name', equals: 'x' }, preset: { field: 'source', value: 'menu' } };
  await fullSave([listNode(), btnNode(), textNode()], [echoed]);
  assert.equal(upsertOf(RICH_EDGE).description, 'Starts a booking');
  assert.deepEqual(upsertOf(RICH_EDGE).preset, { field: 'source', value: 'menu' });
});

test('PUT /full: an explicit null still clears an edge field', async () => {
  stubRpc();
  await fullSave(
    [listNode(), btnNode(), textNode()],
    [{ id: RICH_EDGE, fromNodeId: BTN, toNodeId: QNODE, label: 'Book', description: null, descriptionTranslations: null, labelTranslations: null, preset: null, condition: null }]
  );
  const rich = upsertOf(RICH_EDGE);
  assert.equal(rich.description, null);
  assert.equal(rich.description_translations, null);
  assert.equal(rich.label_translations, null);
  assert.equal(rich.preset, null);
  assert.equal(rich.condition, null);
});

test('PUT /full: a new edge with the keys omitted gets null', async () => {
  stubRpc();
  await fullSave([listNode(), btnNode(), textNode()], [{ fromNodeId: BTN, toNodeId: TEXT, label: 'Fresh' }]);
  const fresh = rpcArgs.p_edge_upserts.find(e => e.label === 'Fresh');
  assert.equal(fresh.description, null);
  assert.equal(fresh.description_translations, null);
  assert.equal(fresh.label_translations, null);
  assert.equal(fresh.condition, null);
  assert.equal(fresh.preset, null);
});

test('PUT /full: a reply node sent without labelTranslations keeps them; null clears them', async () => {
  stubRpc();
  await fullSave([listNode(), btnNode(), textNode()], []);
  assert.deepEqual(nodeUpsertOf(LIST).label_translations, { hi: 'कोर्स चुनें' });

  stubRpc();
  await fullSave([listNode({ labelTranslations: null }), btnNode(), textNode()], []);
  assert.equal(nodeUpsertOf(LIST).label_translations, null);

  stubRpc();
  await fullSave([listNode({ labelTranslations: { hi: 'नया' } }), btnNode(), textNode()], []);
  assert.deepEqual(nodeUpsertOf(LIST).label_translations, { hi: 'नया' });
});

test('PUT /full: a new reply node omits labelTranslations to null', async () => {
  stubRpc();
  await fullSave([listNode(), btnNode(), textNode(), { keyword: 'brand new', label: 'Hello' }], []);
  const fresh = rpcArgs.p_node_upserts.find(n => n.keyword === 'brand new');
  assert.equal(fresh.label_translations, null);
});

test('PUT /full: a legacy over-limit edge and button text save when unchanged', async () => {
  stubRpc();
  const out = await fullSave(
    [listNode({ buttonText: LONG_BUTTON, buttonTextTranslations: { hi: LONG_BUTTON } }), btnNode(), textNode()],
    [{ id: LEGACY_EDGE, fromNodeId: LIST, toNodeId: TEXT, label: LONG_LABEL, labelTranslations: { hi: LONG_LABEL }, description: LONG_DESC, descriptionTranslations: { hi: LONG_DESC } }]
  );
  assert.equal(out.status, 200);
  assert.equal(upsertOf(LEGACY_EDGE).label, LONG_LABEL);
});

test('PUT /full: a changed legacy label, or a new over-limit edge, is rejected naming the edge', async () => {
  stubRpc();
  const changed = await fullSave(
    [listNode(), btnNode(), textNode()],
    [{ id: LEGACY_EDGE, fromNodeId: LIST, toNodeId: TEXT, label: 'N'.repeat(30) }]
  );
  assert.equal(changed.status, 400);
  assert.match(message(changed), /edges\[0\]\.label must be 24 characters or less/);
  assert.equal(rpcArgs, null, 'nothing is written');

  const fresh = await fullSave(
    [listNode(), btnNode(), textNode()],
    [{ id: LEGACY_EDGE, fromNodeId: LIST, toNodeId: TEXT, label: LONG_LABEL }, { fromNodeId: BTN, toNodeId: TEXT, label: 'x'.repeat(21) }]
  );
  assert.equal(fresh.status, 400);
  assert.match(message(fresh), /edges\[1\]\.label must be 20 characters or less/);
});

test('PUT /full: the parent content type comes from the same save for a brand-new reply node', async () => {
  stubRpc();
  const newList = { id: 'tmp-1', keyword: 'brand new', contentType: 'list', label: 'Pick' };
  const out = await fullSave(
    [listNode(), btnNode(), textNode(), newList],
    [{ fromNodeId: 'tmp-1', toNodeId: TEXT, label: 'x'.repeat(25) }]
  );
  assert.equal(out.status, 400);
  assert.match(message(out), /edges\[0\]\.label must be 24 characters or less/);

  const ok = await fullSave(
    [listNode(), btnNode(), textNode(), newList],
    [{ fromNodeId: 'tmp-1', toNodeId: TEXT, label: 'x'.repeat(24), description: 'd'.repeat(72) }]
  );
  assert.equal(ok.status, 200);
});

test('PUT /full: a new over-long description or button text is rejected', async () => {
  stubRpc();
  const description = await fullSave([listNode(), btnNode(), textNode()], [{ fromNodeId: BTN, toNodeId: TEXT, label: 'Hi', description: 'd'.repeat(73) }]);
  assert.equal(description.status, 400);
  assert.match(message(description), /edges\[0\]\.description must be 72 characters or less/);

  const button = await fullSave([listNode(), btnNode({ buttonText: 'b'.repeat(21) }), textNode()], []);
  assert.equal(button.status, 400);
  assert.match(message(button), /replyNodes\[1\]\.buttonText must be 20 characters or less/);
});
