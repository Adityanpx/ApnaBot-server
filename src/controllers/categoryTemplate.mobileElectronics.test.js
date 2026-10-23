// Run: node --test src/controllers/categoryTemplate.mobileElectronics.test.js
// templates/category/mobile_electronics.default.json is the starter flow Super Admin imports with
// POST /api/admin/category-templates/import-json. No database: the real importTemplateJson handler runs against the
// in-memory Supabase, then the rows go through the same structural checks a live graph gets (flowGraphValidation,
// the save path's own validation, Meta's interactive-message limits) and the copy-into-a-business write.
// Not covered here (needs the live DB): the flow_snapshots insert constraints, node_library/FK rows,
// src/scripts/verifyBookingGraph.js (reads a business's real flow rows), and the WhatsApp send itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: { getActiveSubscription: async () => null } };

const { importTemplateJson } = require('./categoryTemplate.controller');
const { writeBusinessGraphRows, withNodeDefaults, withEdgeDefaults } = require('../services/flowSnapshot.service');
const { saveFullGraph } = require('../services/flowGraph.service');
const validation = require('../utils/flowGraphValidation');
const { LIMITS } = require('../utils/textLimits');
const { GREETING_WORDS } = require('../utils/flowSpec');
const { toCamelCase } = require('../utils/caseConvert');

const FILE = path.join(__dirname, '..', '..', 'templates', 'category', 'mobile_electronics.default.json');
const template = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const { B1 } = h;

const byKeyword = (kw) => template.nodes.find((n) => n.keyword === kw);
const node = (id) => template.nodes.find((n) => n.id === id);
const outgoing = (id) => template.edges.filter((e) => e.from_node_id === id).sort((a, b) => a.display_order - b.display_order);
const titles = (n) => outgoing(n.id).map((e) => e.label);
const toNodeLabel = (e) => node(e.to_node_id);
const len = (s) => s.trim().length;

const A = byKeyword('hi');
const bookingTrigger = template.nodes.find((n) => n.reply_kind === 'booking_trigger');
const questions = template.nodes.filter((n) => n.node_type === 'question');
const replies = template.nodes.filter((n) => n.node_type === 'reply');

let db;
test.beforeEach(() => {
  db = h.reset();
  db.business_categories = [{ value: 'mobile_electronics', label: 'Mobile & Electronics', is_enabled: true, display_order: 158 }];
});

const callImport = async (body) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await importTemplateJson({ body }, res, (err) => { throw err; });
  return out;
};

test('importTemplateJson accepts the file as is and stores it as an active mobile_electronics category template', async () => {
  const { status, body } = await callImport(template);
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.data.category, 'mobile_electronics');
  assert.equal(body.data.name, 'Mobile & Electronics — Starter');
  const stored = db.flow_snapshots[0];
  assert.equal(stored.is_category_template, true);
  assert.equal(stored.business_id, null);
  assert.equal(stored.nodes.length, 14);
  assert.equal(stored.edges.length, 23);
});

test('the body shape is { category, name, description, nodes, edges } with only raw snake_case rows', () => {
  assert.deepEqual(Object.keys(template), ['category', 'name', 'description', 'nodes', 'edges']);
  assert.equal(typeof template.description, 'string');
  for (const n of template.nodes) {
    assert.ok(!Object.keys(n).some((k) => /[A-Z]/.test(k)), `node ${n.id} has a camelCase key`);
    assert.ok(['reply', 'question'].includes(n.node_type));
  }
  for (const e of template.edges) assert.ok(!Object.keys(e).some((k) => /[A-Z]/.test(k)));
});

test('ids are fixed, unique, valid UUIDs and every edge points at a node of the template', () => {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = [...template.nodes, ...template.edges].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach((id) => assert.match(id, uuidRe));
  const nodeIds = new Set(template.nodes.map((n) => n.id));
  for (const e of template.edges) {
    assert.ok(nodeIds.has(e.from_node_id) && nodeIds.has(e.to_node_id), `edge ${e.id}`);
    assert.equal(e.condition, null);
  }
});

test('withNodeDefaults / withEdgeDefaults leave nothing NOT NULL empty, and rows are uniform', () => {
  const filled = template.nodes.map(withNodeDefaults);
  for (const n of filled) {
    for (const col of ['node_type', 'content_type', 'label', 'hindi_aliases', 'options', 'required', 'is_computed', 'is_active', 'trigger_count', 'gallery_media_ids']) {
      assert.notEqual(n[col], undefined, `${n.id}.${col}`);
      assert.notEqual(n[col], null, `${n.id}.${col}`);
    }
    assert.equal(n.trigger_count, 0);
    assert.equal(n.is_active, true);
  }
  assert.equal(new Set(template.nodes.map((n) => Object.keys(n).sort().join())).size, 1, 'every node row has the same keys (bulk insert)');
  assert.equal(new Set(template.edges.map((e) => Object.keys(e).sort().join())).size, 1);
  template.edges.map(withEdgeDefaults).forEach((e) => assert.equal(typeof e.display_order, 'number'));
});

test('nodes: reply rows have a keyword + match type; question rows a field_key; DB check constraints hold', () => {
  for (const n of replies) {
    assert.ok(n.keyword, `${n.id} keyword`);
    assert.ok(['exact', 'contains', 'startsWith'].includes(n.match_type));
    assert.ok(['text', 'booking_trigger', 'payment_trigger', 'web_form_trigger', 'handoff'].includes(n.reply_kind));
    assert.ok(['text', 'buttons', 'list', 'location', 'location_request', 'carousel', 'catalog'].includes(n.content_type));
    assert.equal(n.is_computed, false);
  }
  for (const q of questions) {
    assert.ok(q.field_key);
    assert.ok(['text', 'buttons', 'list', 'location_request'].includes(q.content_type));
    assert.ok(Number.isFinite(q.position_x) && Number.isFinite(q.position_y));
  }
  const keywords = replies.map((n) => n.keyword.toLowerCase());
  assert.equal(new Set(keywords).size, keywords.length, 'reply keywords are unique');
  const catalogs = template.nodes.filter((n) => n.content_type === 'catalog');
  assert.equal(catalogs.length, 1, 'at most one catalog node (partial unique index)');
});

test('A is the greeting node: keyword hi, exact, the other greeting words as aliases, a list', () => {
  assert.equal(A.match_type, 'exact');
  assert.deepEqual(A.hindi_aliases, GREETING_WORDS.filter((w) => w !== 'hi'));
  assert.equal(A.content_type, 'list');
  assert.equal(A.reply_kind, 'text');
  assert.match(A.label, /^Namaste \{\{customerName\}\} 🙏 Welcome to \{\{businessName\}\}!/);
  assert.deepEqual(titles(A), ['📱 Mobiles', '📺 TV & Appliances', '🪖 CSD / CPC Purchase', '💳 EMI & Finance', '🎁 Offers & Products', '📍 Visit Store', '👤 Talk to us']);
  assert.deepEqual(outgoing(A.id).map((e) => toNodeLabel(e).keyword), ['mobile', 'tv', 'csd', 'emi', 'offer', 'address', 'call']);
});

test('the specified nodes: keywords, match types, buttons and where each button leads', () => {
  const nav = (kw) => outgoing(byKeyword(kw).id).map((e) => [e.label, toNodeLabel(e).keyword]);
  assert.deepEqual(nav('mobile'), [['Send enquiry', 'send_enquiry'], ['Main menu', 'hi']]);
  assert.deepEqual(nav('tv'), [['Send enquiry', 'send_enquiry'], ['Main menu', 'hi']]);
  assert.deepEqual(nav('csd'), [['Documents needed', 'csd_documents'], ['Send enquiry', 'send_enquiry'], ['Main menu', 'hi']]);
  assert.deepEqual(nav('csd_documents'), [['Send enquiry', 'send_enquiry'], ['Main menu', 'hi']]);
  assert.deepEqual(nav('emi'), [['Send enquiry', 'send_enquiry'], ['Main menu', 'hi']]);
  assert.deepEqual(nav('address'), [['Main menu', 'hi']]);
  assert.deepEqual(nav('call'), []);
  assert.deepEqual(nav('offer'), []);
  for (const kw of ['mobile', 'tv', 'csd', 'emi', 'offer', 'address', 'call']) assert.equal(byKeyword(kw).match_type, 'contains', kw);
  assert.deepEqual(byKeyword('mobile').hindi_aliases, ['phone', 'smartphone', 'फोन', 'मोबाइल']);
  assert.deepEqual(byKeyword('csd').hindi_aliases, ['cpc', 'canteen', 'army', 'police', 'defence']);
  assert.deepEqual(byKeyword('emi').hindi_aliases, ['loan', 'finance', 'installment', 'किस्त']);
  assert.deepEqual(byKeyword('offer').hindi_aliases, ['price', 'rate', 'catalogue']);
  assert.deepEqual(byKeyword('address').hindi_aliases, ['location', 'shop', 'timing', 'पता']);
  assert.deepEqual(byKeyword('call').hindi_aliases, ['talk', 'person']);
});

test('G is the Catalogue reply (catalog content type, no buttons); I is the handoff reply with an empty label', () => {
  const g = byKeyword('offer');
  assert.deepEqual([g.node_type, g.content_type, g.reply_kind], ['reply', 'catalog', 'text']);
  assert.equal(outgoing(g.id).length, 0);
  const i = byKeyword('call');
  assert.deepEqual([i.reply_kind, i.content_type, i.label], ['handoff', 'text', '']);
  assert.equal(outgoing(i.id).length, 0);
});

test('copy only uses the four supported placeholders, and no prices or brands except the one example the owner asked for', () => {
  const allowed = new Set(['customerName', 'businessName', 'businessAddress', 'businessHours']);
  for (const n of template.nodes) {
    for (const [, name] of n.label.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(allowed.has(name), `${n.id}: {{${name}}}`);
  }
  assert.ok(!template.nodes.some((n) => /[₹$]|\bRs\.?\s?\d|\d+\s?(?:rs|rupees)\b/i.test(n.label)), 'no prices');
  const brandMentions = template.nodes.filter((n) => /samsung|apple|iphone|lg\b|sony|oneplus|vivo|oppo|xiaomi|redmi|realme/i.test(n.label));
  assert.deepEqual(brandMentions.map((n) => n.field_key), ['brandModel'], 'brands only in the model-question example');
});

test('Meta limits: ≤3 buttons per buttons node, ≤10 list rows, title / description / body lengths', () => {
  for (const n of replies) {
    const edges = outgoing(n.id);
    if (n.content_type === 'buttons') {
      assert.ok(edges.length >= 1 && edges.length <= LIMITS.MAX_BUTTONS, `${n.keyword}: ${edges.length} buttons`);
      edges.forEach((e) => assert.ok(len(e.label) <= LIMITS.BUTTON_TITLE, `${n.keyword} button "${e.label}"`));
      assert.ok(len(n.label) <= LIMITS.INTERACTIVE_BODY, `${n.keyword} body`);
    } else if (n.content_type === 'list') {
      assert.ok(edges.length >= 1 && edges.length <= LIMITS.MAX_LIST_ROWS, `${n.keyword}: ${edges.length} rows`);
      edges.forEach((e) => {
        assert.ok(len(e.label) <= LIMITS.LIST_ROW_TITLE, `row "${e.label}"`);
        if (e.description) assert.ok(len(e.description) <= LIMITS.LIST_ROW_DESCRIPTION);
      });
      assert.ok(len(n.label) <= LIMITS.INTERACTIVE_BODY);
    } else if (n.reply_kind === 'booking_trigger') {
      assert.equal(edges.length, 1, 'the trigger only leads to question 1');
    } else {
      assert.equal(edges.length, 0, `${n.keyword} (${n.content_type}) has no outgoing buttons`);
      assert.ok(len(n.label) <= LIMITS.TEXT_BODY);
    }
    if (['buttons', 'list'].includes(n.content_type)) {
      const labels = edges.map((e) => e.label.toLowerCase());
      assert.equal(new Set(labels).size, labels.length, `${n.keyword}: duplicate button titles`);
    }
  }
  assert.equal(template.nodes.find((n) => n.keyword === 'hi').button_text ?? null, null);
});

test('question nodes: a linear chain of supported field types with sane choices', () => {
  const chain = questions.slice().sort((a, b) => a.order - b.order);
  assert.deepEqual(chain.map((q) => [q.field_key, q.content_type]), [
    ['product', 'list'], ['brandModel', 'text'], ['purchaseType', 'buttons'], ['visitWhen', 'buttons']
  ]);
  assert.deepEqual(chain[0].options.map((o) => o.label), ['Mobile', 'TV', 'AC', 'Fridge', 'Washing machine', 'Other']);
  assert.deepEqual(chain[2].options.map((o) => o.label), ['CSD', 'CPC', 'Regular']);
  assert.deepEqual(chain[3].options.map((o) => o.label), ['Today', 'Tomorrow', 'This week']);
  assert.deepEqual(chain[1].options, []);
  assert.deepEqual(chain.map((q) => q.order), [0, 1, 2, 3]);
  for (const q of chain) {
    assert.equal(q.required, true);
    assert.ok(q.summary_label && !q.summary_label.includes('?'));
    assert.ok(len(q.label) <= (q.content_type === 'text' ? LIMITS.TEXT_BODY : LIMITS.INTERACTIVE_BODY));
    const max = q.options.length <= LIMITS.MAX_BUTTONS ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
    if (q.content_type === 'buttons') assert.ok(q.options.length <= LIMITS.MAX_BUTTONS);
    if (q.content_type === 'list') assert.ok(q.options.length >= 2 && q.options.length <= LIMITS.MAX_LIST_ROWS);
    q.options.forEach((o) => { assert.ok(len(o.label) <= max); assert.ok(o.value); });
  }
  const reserved = new Set([...require('../utils/flowSpec').RESERVED_FIELD_KEYS]);
  chain.forEach((q) => assert.ok(!reserved.has(q.field_key), `${q.field_key} is reserved`));
  assert.equal(new Set(chain.map((q) => q.field_key)).size, chain.length);
});

test('graph: every node is reachable from the greeting node A', () => {
  const seen = new Set([A.id]);
  const queue = [A.id];
  while (queue.length) {
    for (const e of outgoing(queue.shift())) if (!seen.has(e.to_node_id)) { seen.add(e.to_node_id); queue.push(e.to_node_id); }
  }
  assert.deepEqual(template.nodes.filter((n) => !seen.has(n.id)).map((n) => n.keyword || n.field_key), []);
});

test('graph: the booking_trigger has exactly one edge into the question chain, and it is the only way in', () => {
  const questionIds = new Set(questions.map((q) => q.id));
  const into = template.edges.filter((e) => questionIds.has(e.to_node_id) && !questionIds.has(e.from_node_id));
  assert.equal(into.length, 1);
  assert.equal(into[0].from_node_id, bookingTrigger.id);
  assert.equal(into[0].to_node_id, questions.find((q) => q.order === 0).id);
  assert.equal(template.nodes.filter((n) => n.reply_kind === 'booking_trigger').length, 1);
  assert.equal(outgoing(bookingTrigger.id).length, 1);
  assert.ok(template.edges.filter((e) => questionIds.has(e.from_node_id)).every((e) => questionIds.has(e.to_node_id)), 'questions only lead to questions');
});

test('flowGraphValidation: no cycles, no unreachable question nodes, the booking entry resolves', () => {
  const nodes = template.nodes.map(withNodeDefaults).map(toCamelCase);
  const edges = template.edges.map(withEdgeDefaults).map(toCamelCase);
  assert.deepEqual(validation.findCycles(nodes, edges), []);
  const entry = validation.resolveBookingTriggerEntryNodeIds(nodes, edges);
  assert.deepEqual(entry, [questions.find((q) => q.order === 0).id]);
  assert.deepEqual(validation.findUnreachableNodes(nodes, edges, entry), []);
  assert.deepEqual(validation.findFallbackSiblingNodeIds(nodes, edges, entry), []);
  assert.equal(validation.canEnterBookingQuestions(nodes, edges), true);
});

test('the owner-side save path accepts the graph (saveFullGraph validation, Catalogue reply excluded as it is per business)', async () => {
  const rpcCalls = [];
  h.state.fake.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: null, error: null }; };
  const g = byKeyword('offer');
  const rows = template.nodes.filter((n) => n.id !== g.id);
  const res = await saveFullGraph({
    businessId: B1,
    graphBusiness: { businessCategory: 'mobile_electronics', subCategories: [] },
    replyNodes: rows.filter((n) => n.node_type === 'reply').map(toCamelCase),
    questionNodes: rows.filter((n) => n.node_type === 'question').map(toCamelCase),
    edges: template.edges.filter((e) => e.to_node_id !== g.id).map(toCamelCase)
  });
  assert.equal(res.error ?? null, null);
  const call = rpcCalls.find((c) => c.name === 'save_flow_graph_full');
  assert.ok(call, 'reached the save RPC');
  assert.equal(call.args.p_node_upserts.length, 13);
});

test('copying into a business: the Catalogue reply and its menu row are left out, everything else is written', async () => {
  const inserted = {};
  const supabasePath = require.resolve('../config/supabase');
  const original = require.cache[supabasePath].exports.from;
  require.cache[supabasePath].exports.from = (table) => ({ insert: async (rows) => { inserted[table] = rows; return { error: null }; } });
  try {
    await writeBusinessGraphRows(B1, template.nodes, template.edges, { reuseIds: false, resetTriggerCount: true });
  } finally {
    require.cache[supabasePath].exports.from = original;
  }
  assert.equal(inserted.flow_nodes.length, 13);
  assert.equal(inserted.flow_edges.length, 22);
  assert.ok(!inserted.flow_nodes.some((n) => n.content_type === 'catalog'));
  const menu = inserted.flow_nodes.find((n) => n.keyword === 'hi');
  const menuEdges = inserted.flow_edges.filter((e) => e.from_node_id === menu.id);
  assert.equal(menuEdges.length, 6, 'the list keeps 6 rows');
  assert.ok(!menuEdges.some((e) => e.label === '🎁 Offers & Products'));
  const newIds = new Set(inserted.flow_nodes.map((n) => n.id));
  assert.ok(inserted.flow_edges.every((e) => newIds.has(e.from_node_id) && newIds.has(e.to_node_id)), 'edges remapped to the new ids');
  assert.ok(inserted.flow_nodes.every((n) => n.business_id === B1 && n.trigger_count === 0));
});
