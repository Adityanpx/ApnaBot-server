// Run: node --test src/controllers/flowGraph.formTitle.test.js
// A web-form reply's optional name (flow_nodes.form_title / form_title_translations): write-side
// validation on POST/PUT /reply-nodes and the batch save (PUT /full), and the batch save's
// keep-what-was-omitted rule (the save_flow_graph_full RPC rewrites every column). In-memory
// Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const controller = require('./flowGraph.controller');

const { B1, uuid } = h;
const FORM = uuid(500);
const TEXT = uuid(501);
const QNODE = uuid(502);

let db;
let rpcArgs;
test.beforeEach(() => {
  db = h.reset();
  rpcArgs = null;
  h.state.fake.rpc = async (name, args) => { rpcArgs = { name, ...args }; return { data: null, error: null }; };
  db.flow_nodes = [
    { id: FORM, business_id: B1, node_type: 'reply', keyword: 'enquiry', match_type: 'contains', reply_kind: 'web_form_trigger', content_type: 'text', label: 'Fill this form', is_active: true, form_title: 'Enquiry form', form_title_translations: { hi: 'पूछताछ फ़ॉर्म' } },
    { id: TEXT, business_id: B1, node_type: 'reply', keyword: 'fees', match_type: 'contains', reply_kind: 'text', content_type: 'text', label: 'Fees', is_active: true },
    { id: QNODE, business_id: B1, node_type: 'question', field_key: 'name', content_type: 'text', label: 'Name?', options: [] }
  ];
  db.flow_edges = [];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'coaching' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const node = (id) => db.flow_nodes.find(n => n.id === id);
const message = (out) => out.body.message || out.body.error || JSON.stringify(out.body);
const create = (body) => call(controller.createReplyNode, { body: { keyword: 'new form', label: 'Tap below', replyKind: 'web_form_trigger', ...body } });
const update = (id, body) => call(controller.updateReplyNode, { params: { id }, body });

// ---- POST /reply-nodes --------------------------------------------------------------------

test('POST: a web form reply stores a trimmed formTitle and its translations', async () => {
  const out = await create({ formTitle: '  Site visit  ', formTitleTranslations: { hi: ' साइट विज़िट ', mr: 'साइट भेट' } });
  assert.equal(out.status, 201);
  assert.equal(out.body.data.formTitle, 'Site visit');
  assert.deepEqual(out.body.data.formTitleTranslations, { hi: 'साइट विज़िट', mr: 'साइट भेट' });
  const stored = db.flow_nodes.find(n => n.keyword === 'new form');
  assert.deepEqual([stored.form_title, stored.form_title_translations], ['Site visit', { hi: 'साइट विज़िट', mr: 'साइट भेट' }]);
});

test('POST: no formTitle leaves the columns unset', async () => {
  await create({});
  const stored = db.flow_nodes.find(n => n.keyword === 'new form');
  assert.ok(stored.form_title === undefined || stored.form_title === null);
});

test('POST: 60 characters is accepted, 61 is rejected naming the limit', async () => {
  assert.equal((await create({ formTitle: 'x'.repeat(60) })).status, 201);
  const out = await create({ keyword: 'another', formTitle: 'x'.repeat(61) });
  assert.equal(out.status, 400);
  assert.match(message(out), /formTitle must be 60 characters or less/);
});

test('POST: a title is rejected on a node that is not a web form reply', async () => {
  for (const replyKind of [undefined, 'text', 'booking_trigger', 'payment_trigger']) {
    const out = await create({ replyKind, formTitle: 'Enquiry' });
    assert.equal(out.status, 400, String(replyKind));
    assert.match(message(out), /only apply to web form replies/);
  }
  const out = await create({ replyKind: 'text', formTitleTranslations: { hi: 'पूछताछ' } });
  assert.equal(out.status, 400);
  assert.match(message(out), /only apply to web form replies/);
  assert.equal(db.flow_nodes.length, 3, 'nothing was created');
});

test('POST: null / empty values are fine on any kind (a client may echo nulls)', async () => {
  const out = await create({ replyKind: 'text', formTitle: '', formTitleTranslations: {} });
  assert.equal(out.status, 201);
  assert.equal(out.body.data.formTitle, null);
  assert.equal(out.body.data.formTitleTranslations, null);
});

test('POST: formTitleTranslations is validated like the other translation maps', async () => {
  const badLang = await create({ formTitle: 'Enquiry', formTitleTranslations: { xx: 'x' } });
  assert.equal(badLang.status, 400);
  assert.match(message(badLang), /formTitleTranslations has an invalid language code "xx"/);
  const tooLong = await create({ formTitle: 'Enquiry', formTitleTranslations: { hi: 'अ'.repeat(61) } });
  assert.equal(tooLong.status, 400);
  assert.match(message(tooLong), /formTitleTranslations for language "hi" must be 60 characters or less/);
  const notString = await create({ formTitle: 'Enquiry', formTitleTranslations: { hi: 5 } });
  assert.equal(notString.status, 400);
  assert.match(message(notString), /values must be strings/);
  const notObject = await create({ formTitle: 'Enquiry', formTitleTranslations: 'hi' });
  assert.equal(notObject.status, 400);
  const nonStringTitle = await create({ formTitle: 7 });
  assert.equal(nonStringTitle.status, 400);
  assert.match(message(nonStringTitle), /formTitle must be a string/);
});

// ---- PUT /reply-nodes/:id -----------------------------------------------------------------

test('PUT: sets, replaces and clears the title; omitted keys are untouched', async () => {
  assert.equal((await update(FORM, { formTitle: 'Callback request' })).status, 200);
  assert.deepEqual([node(FORM).form_title, node(FORM).form_title_translations], ['Callback request', { hi: 'पूछताछ फ़ॉर्म' }]);

  await update(FORM, { label: 'New text' });
  assert.equal(node(FORM).form_title, 'Callback request');

  await update(FORM, { formTitleTranslations: { mr: 'कॉलबॅक' } });
  assert.deepEqual(node(FORM).form_title_translations, { mr: 'कॉलबॅक' });

  await update(FORM, { formTitle: '' });
  assert.equal(node(FORM).form_title, null);
  await update(FORM, { formTitleTranslations: null });
  assert.equal(node(FORM).form_title_translations, null);
});

test('PUT: null clears the title too', async () => {
  await update(FORM, { formTitle: null });
  assert.equal(node(FORM).form_title, null);
});

test('PUT: rejects a title over 60 characters and leaves the node alone', async () => {
  const out = await update(FORM, { formTitle: 'x'.repeat(61) });
  assert.equal(out.status, 400);
  assert.equal(node(FORM).form_title, 'Enquiry form');
});

test('PUT: rejects a title on a node whose replyKind is not web_form_trigger', async () => {
  const out = await update(TEXT, { formTitle: 'Fees form' });
  assert.equal(out.status, 400);
  assert.match(message(out), /only apply to web form replies/);
  assert.ok(!node(TEXT).form_title);
});

test('PUT: the kind that counts is the one after the write', async () => {
  // switching a text node to a web form in the same request is fine ...
  assert.equal((await update(TEXT, { replyKind: 'web_form_trigger', formTitle: 'Fees form' })).status, 200);
  assert.equal(node(TEXT).form_title, 'Fees form');
  // ... and setting a title while switching a form node away is not
  const out = await update(FORM, { replyKind: 'text', formTitle: 'Still a form?' });
  assert.equal(out.status, 400);
  assert.equal(node(FORM).reply_kind, 'web_form_trigger');
});

test('PUT: returns formTitle / formTitleTranslations (camelCase)', async () => {
  const out = await update(FORM, { label: 'x' });
  assert.equal(out.body.data.formTitle, 'Enquiry form');
  assert.deepEqual(out.body.data.formTitleTranslations, { hi: 'पूछताछ फ़ॉर्म' });
});

// ---- PUT /full -----------------------------------------------------------------------------

const formItem = (extra = {}) => ({ id: FORM, keyword: 'enquiry', replyKind: 'web_form_trigger', label: 'Fill this form', ...extra });
const textItem = (extra = {}) => ({ id: TEXT, keyword: 'fees', label: 'Fees', ...extra });
const questionItem = () => ({ id: QNODE, fieldKey: 'name', label: 'Name?' });
const fullSave = (replyNodes) => call(controller.saveFullGraph, { body: { replyNodes, questionNodes: [questionItem()], edges: [] } });
const upsertOf = (id) => rpcArgs.p_node_upserts.find(n => n.id === id);

test('PUT /full: a node saved without the keys keeps its stored title and translations', async () => {
  const out = await fullSave([formItem(), textItem()]);
  assert.equal(out.status, 200);
  assert.equal(upsertOf(FORM).form_title, 'Enquiry form');
  assert.deepEqual(upsertOf(FORM).form_title_translations, { hi: 'पूछताछ फ़ॉर्म' });
  assert.equal(upsertOf(TEXT).form_title, null);
  assert.equal(upsertOf(QNODE).form_title, null);
});

test('PUT /full: supplied keys replace, null clears, whole nodes echoed back are unchanged', async () => {
  await fullSave([formItem({ formTitle: ' Callback ', formTitleTranslations: { mr: 'कॉलबॅक' } }), textItem()]);
  assert.equal(upsertOf(FORM).form_title, 'Callback');
  assert.deepEqual(upsertOf(FORM).form_title_translations, { mr: 'कॉलबॅक' });

  await fullSave([formItem({ formTitle: null, formTitleTranslations: null }), textItem()]);
  assert.equal(upsertOf(FORM).form_title, null);
  assert.equal(upsertOf(FORM).form_title_translations, null);

  await fullSave([formItem({ formTitle: 'Enquiry form', formTitleTranslations: { hi: 'पूछताछ फ़ॉर्म' } }), textItem({ formTitle: null, formTitleTranslations: null })]);
  assert.equal(upsertOf(FORM).form_title, 'Enquiry form');
  assert.equal(upsertOf(TEXT).form_title, null);
});

test('PUT /full: a new web form node carries its title; a new text node omits to null', async () => {
  await fullSave([formItem(), textItem(), { keyword: 'brand new', replyKind: 'web_form_trigger', label: 'Hi', formTitle: 'Brand new form' }, { keyword: 'plain', label: 'Plain' }]);
  assert.equal(rpcArgs.p_node_upserts.find(n => n.keyword === 'brand new').form_title, 'Brand new form');
  assert.equal(rpcArgs.p_node_upserts.find(n => n.keyword === 'plain').form_title, null);
});

test('PUT /full: validation names the node and writes nothing', async () => {
  const tooLong = await fullSave([formItem({ formTitle: 'x'.repeat(61) }), textItem()]);
  assert.equal(tooLong.status, 400);
  assert.match(message(tooLong), /replyNodes\[0\]\.formTitle must be 60 characters or less/);
  assert.equal(rpcArgs, null);

  const wrongKind = await fullSave([formItem(), textItem({ formTitle: 'Fees form' })]);
  assert.equal(wrongKind.status, 400);
  assert.match(message(wrongKind), /replyNodes\[1\]\.formTitle \/ formTitleTranslations only apply to web form replies/);
  assert.equal(rpcArgs, null);

  const badTranslations = await fullSave([formItem({ formTitleTranslations: { zz: 'x' } }), textItem()]);
  assert.equal(badTranslations.status, 400);
  assert.match(message(badTranslations), /replyNodes\[0\]\.formTitleTranslations has an invalid language code "zz"/);
});

test('PUT /full: a stored title on a node switched away from web_form_trigger is kept, not re-validated', async () => {
  const out = await fullSave([formItem({ replyKind: 'text' }), textItem()]);
  assert.equal(out.status, 200);
  assert.equal(upsertOf(FORM).form_title, 'Enquiry form');
});
