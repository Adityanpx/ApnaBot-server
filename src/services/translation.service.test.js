// Run: node --test src/services/translation.service.test.js
// Auto-translate: global cache, per-business monthly cap (reserve before the call, refund on failure),
// placeholder / formatting protection, "never overwrite a human translation", the auto-translated
// marker, template translation and the signup run. Azure's HTTP API is mocked (axios.post); the
// database is an in-memory stand-in for the few tables and two RPCs involved.
const test = require('node:test');
const assert = require('node:assert/strict');

let db;
let azureCalls;
let azureBehaviour;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const from = (table) => {
  const filters = []; let op = 'select'; let payload; let options = {};
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') { const m = matching(); m.forEach(r => Object.assign(r, JSON.parse(JSON.stringify(payload)))); return m; }
    if (op === 'upsert') {
      const keys = options.onConflict.split(',');
      for (const row of payload) {
        const existing = rows().find(r => keys.every(k => r[k] === row[k]));
        if (!existing) rows().push({ ...row });
        else if (!options.ignoreDuplicates) Object.assign(existing, row);
      }
      return [];
    }
    return matching();
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    order: () => q,
    update: (p) => { op = 'update'; payload = p; return q; },
    upsert: (p, o) => { op = 'upsert'; payload = p; options = o; return q; },
    maybeSingle: async () => ({ data: JSON.parse(JSON.stringify(run()[0] || null)), error: null }),
    single: async () => ({ data: JSON.parse(JSON.stringify(run()[0] || null)), error: null }),
    then: (resolve, reject) => Promise.resolve({ data: JSON.parse(JSON.stringify(run())), error: null }).then(resolve, reject)
  };
  return q;
};

// JS twin of reserve_translate_chars / refund_translate_chars (migration 20261024130000).
const rpc = async (name, args) => {
  db.usage = db.usage || {}; db.globalUsage = db.globalUsage || {};
  const bKey = `${args.p_business}:${args.p_month}`;
  if (name === 'reserve_translate_chars') {
    const g = db.globalUsage[args.p_month] || 0;
    if (args.p_global_cap != null && g + args.p_chars > args.p_global_cap) return { data: [{ result: 'global_cap', business_used: null, global_used: g }], error: null };
    let b = 0;
    if (args.p_count_business) {
      b = db.usage[bKey] || 0;
      if (args.p_cap != null && b + args.p_chars > args.p_cap) return { data: [{ result: 'business_cap', business_used: b, global_used: g }], error: null };
      db.usage[bKey] = b + args.p_chars; b += args.p_chars;
    }
    db.globalUsage[args.p_month] = g + args.p_chars;
    return { data: [{ result: 'ok', business_used: b, global_used: g + args.p_chars }], error: null };
  }
  if (name === 'refund_translate_chars') {
    if (args.p_count_business) db.usage[bKey] = Math.max((db.usage[bKey] || 0) - args.p_chars, 0);
    db.globalUsage[args.p_month] = Math.max((db.globalUsage[args.p_month] || 0) - args.p_chars, 0);
    return { data: null, error: null };
  }
  throw new Error(`unexpected rpc ${name}`);
};

stub('../config/supabase', { from, rpc });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('./chatbot.service', { invalidateRulesCache: async () => {} });

const axios = require('axios');
axios.post = async (url, body, opts) => {
  azureCalls.push({ url, texts: body.map(b => b.Text), to: opts.params.to, textType: opts.params.textType });
  return azureBehaviour(body, opts.params.to);
};
// Default "translation": prefix with the language, keep every tag and placeholder.
const prefixTranslate = (body, to) => ({ data: body.map(b => ({ translations: [{ text: `[${to}] ${b.Text}`, to }] })) });

const translation = require('./translation.service');
const flowTranslate = require('./flowTranslate.service');
const { autoTranslatedOf, nodeSlots, edgeSlots, businessSlots } = require('../utils/translationSlots');

const BIZ = '11111111-1111-1111-1111-111111111111';
const MONTH = translation.currentMonth();

test.beforeEach(() => {
  process.env.AZURE_TRANSLATOR_KEY = 'k';
  process.env.AZURE_TRANSLATOR_REGION = 'centralindia';
  azureCalls = [];
  azureBehaviour = async (body, to) => prefixTranslate(body, to);
  db = {
    app_config: [], translation_cache: [], usage: {}, globalUsage: {},
    businesses: [{ id: BIZ, enabled_languages: ['en', 'hi', 'gu'], welcome_message: 'Welcome to {{businessName}}!', welcome_message_translations: null, stop_message: null, start_message: null, cancel_message: null, flow_fields: null, auto_translations: null, translation_status: null }],
    flow_nodes: [], flow_edges: [], flow_snapshots: []
  };
});

// ---------------------------------------------------------------- translateTexts

test('translates, protects placeholders / formatting on the way out, and charges source characters x languages', async () => {
  const text = '*Hi* {{customer_name}}\nSee you 👋';
  const result = await translation.translateTexts({ businessId: BIZ, texts: [text], to: ['hi', 'gu'], scope: 'owner' });

  assert.equal(azureCalls.length, 2, 'one request per language');
  assert.equal(azureCalls[0].textType, 'html');
  assert.equal(azureCalls[0].texts[0], '<b>Hi</b> <span class="notranslate">{{customer_name}}</span><br>See you 👋');
  assert.equal(result.translations.hi[0], `[hi] ${text}`);
  assert.equal(result.translations.gu[0], `[gu] ${text}`);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.charged, text.length * 2);
  assert.equal(db.usage[`${BIZ}:${MONTH}`], text.length * 2);
  assert.equal(result.usage.used, text.length * 2);
});

test('a repeat is served from the global cache: no Azure call, nothing charged', async () => {
  await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' });
  assert.equal(azureCalls.length, 1);
  const before = db.usage[`${BIZ}:${MONTH}`];

  const again = await translation.translateTexts({ businessId: BIZ, texts: ['Open today', 'Open today'], to: ['hi'], scope: 'owner' });
  assert.equal(azureCalls.length, 1, 'no second call');
  assert.deepEqual(again.translations.hi, ['[hi] Open today', '[hi] Open today']);
  assert.equal(again.charged, 0);
  assert.equal(again.cacheHits, 1);
  assert.equal(db.usage[`${BIZ}:${MONTH}`], before);

  // Another business gets the same cached text for free.
  const other = await translation.translateTexts({ businessId: '22222222-2222-2222-2222-222222222222', texts: ['Open today'], to: ['hi'], scope: 'owner' });
  assert.equal(other.charged, 0);
  assert.equal(azureCalls.length, 1);
});

test('protectTerms: the words stay as typed on the way out, and the shared cache is neither read nor written', async () => {
  db.translation_cache.push({ source_hash: translation.sha256('Send *menu* or STOP'), target_lang: 'hi', translated_text: 'STALE unprotected' });
  const result = await translation.translateTexts({ businessId: null, texts: ['Send *menu* or STOP'], to: ['hi'], scope: 'system', protectTerms: ['menu', 'STOP'] });
  assert.equal(azureCalls.length, 1, 'the cached pair was ignored');
  assert.equal(azureCalls[0].texts[0], 'Send <span class="notranslate">*menu*</span> or <span class="notranslate">STOP</span>');
  assert.equal(result.translations.hi[0], '[hi] Send *menu* or STOP');
  assert.equal(result.cacheHits, 0);
  assert.equal(db.translation_cache.length, 1, 'nothing written to the shared cache');
  assert.equal(db.translation_cache[0].translated_text, 'STALE unprotected');
});

test('only the languages missing from the cache are sent', async () => {
  await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' });
  azureCalls = [];
  const result = await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi', 'gu'], scope: 'owner' });
  assert.equal(azureCalls.length, 1);
  assert.equal(azureCalls[0].to, 'gu');
  assert.equal(result.charged, 'Open today'.length);
});

test('over the monthly cap: 429 with the agreed message, Azure is never called, nothing is counted', async () => {
  db.app_config.push({ key: 'translate_monthly_char_cap', value: '10' });
  await assert.rejects(
    translation.translateTexts({ businessId: BIZ, texts: ['This is far too long for ten characters'], to: ['hi'], scope: 'owner' }),
    (error) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'TRANSLATE_CAP_EXCEEDED');
      assert.equal(error.message, 'Monthly auto-translate limit reached, type it manually or wait until next month');
      return true;
    }
  );
  assert.equal(azureCalls.length, 0);
  assert.equal(db.usage[`${BIZ}:${MONTH}`] || 0, 0);
});

test('a cached text still works when the cap is spent (it costs nothing)', async () => {
  await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' });
  db.app_config.push({ key: 'translate_monthly_char_cap', value: '1' });
  const result = await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' });
  assert.equal(result.translations.hi[0], '[hi] Open today');
});

test('Azure failing: 503, and the reserved characters are given back', async () => {
  azureBehaviour = async () => { const e = new Error('boom'); e.response = { status: 400, data: { error: { code: 400000 } } }; throw e; };
  await assert.rejects(
    translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' }),
    (error) => error.statusCode === 503 && error.code === 'TRANSLATE_UNAVAILABLE'
  );
  assert.equal(db.usage[`${BIZ}:${MONTH}`], 0, 'refunded');
  assert.equal(db.globalUsage[MONTH], 0);
  assert.equal(db.translation_cache.length, 0);
});

test('not configured: 503 with a clear message and no database writes', async () => {
  delete process.env.AZURE_TRANSLATOR_KEY;
  await assert.rejects(
    translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'owner' }),
    (error) => error.statusCode === 503 && error.code === 'TRANSLATE_NOT_CONFIGURED' && /not configured/.test(error.message)
  );
  assert.equal(db.usage[`${BIZ}:${MONTH}`] || 0, 0);
});

test('a translation that lost a placeholder is dropped with a warning and is not cached', async () => {
  azureBehaviour = async (body, to) => ({ data: body.map(() => ({ translations: [{ text: 'नमस्ते', to }] })) });
  const result = await translation.translateTexts({ businessId: BIZ, texts: ['Hi {{customer_name}}'], to: ['hi'], scope: 'owner' });
  assert.deepEqual(result.translations.hi, [null]);
  assert.deepEqual(result.warnings, [{ index: 0, language: 'hi', reason: 'Placeholder mismatch.' }]);
  assert.equal(db.translation_cache.length, 0);
});

test('blank texts are returned as null and cost nothing; English and unknown targets are refused', async () => {
  const result = await translation.translateTexts({ businessId: BIZ, texts: ['', '   '], to: ['hi'], scope: 'owner' });
  assert.deepEqual(result.translations.hi, [null, null]);
  assert.equal(azureCalls.length, 0);
  await assert.rejects(translation.translateTexts({ businessId: BIZ, texts: ['x'], to: ['en'], scope: 'owner' }), (e) => e.statusCode === 400);
  await assert.rejects(translation.translateTexts({ businessId: BIZ, texts: ['x'], to: ['fr'], scope: 'owner' }), (e) => e.statusCode === 400);
});

test("'system' work (signup, Super Admin templates) leaves the owner's allowance alone but moves the global counter", async () => {
  const result = await translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'system' });
  assert.equal(result.charged, 10);
  assert.equal(db.usage[`${BIZ}:${MONTH}`] || 0, 0);
  assert.equal(db.globalUsage[MONTH], 10);
});

test('the global monthly cap stops everyone: 503, no Azure call', async () => {
  db.app_config.push({ key: 'translate_global_monthly_cap', value: '5' });
  await assert.rejects(
    translation.translateTexts({ businessId: BIZ, texts: ['Open today'], to: ['hi'], scope: 'system' }),
    (error) => error.statusCode === 503 && error.code === 'TRANSLATE_UNAVAILABLE'
  );
  assert.equal(azureCalls.length, 0);
});

// ---------------------------------------------------------------- flow translation

const replyNode = (extra = {}) => ({ id: 'n1', business_id: BIZ, node_type: 'reply', content_type: 'buttons', label: 'Choose an option', label_translations: null, auto_translations: null, ...extra });

test('fills only the empty slots: a human translation is never overwritten', async () => {
  db.flow_nodes = [
    replyNode({ id: 'n1', label_translations: { hi: 'अपना विकल्प चुनें' } }),
    replyNode({ id: 'n2', label: 'Our prices', content_type: 'text', label_translations: null })
  ];
  db.flow_edges = [
    { id: 'e1', business_id: BIZ, from_node_id: 'n1', to_node_id: 'n2', label: 'Prices', label_translations: { hi: 'दाम', gu: 'ભાવ' }, auto_translations: null }
  ];

  const result = await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });

  const n1 = db.flow_nodes.find(n => n.id === 'n1');
  const n2 = db.flow_nodes.find(n => n.id === 'n2');
  assert.deepEqual(n1.label_translations, { hi: 'अपना विकल्प चुनें' }, 'human text untouched');
  assert.equal(n1.auto_translations, null, 'and not marked as machine text');
  assert.deepEqual(n2.label_translations, { hi: '[hi] Our prices' });
  assert.deepEqual(db.flow_edges[0].label_translations, { hi: 'दाम', gu: 'ભાવ' });
  assert.equal(result.translated, 2, 'n2 label + the welcome message');
  assert.ok(result.alreadyTranslated >= 2);
  // Only the empty texts went to Azure.
  assert.deepEqual(azureCalls[0].texts.sort(), ['Our prices', 'Welcome to <span class="notranslate">{{businessName}}</span>!'].sort());
  assert.equal(db.businesses[0].welcome_message_translations.hi, '[hi] Welcome to {{businessName}}!');
  assert.equal(db.usage[`${BIZ}:${MONTH}`], 'Our prices'.length + 'Welcome to {{businessName}}!'.length);
});

test('machine-filled texts are marked, and a hand edit clears the mark by itself', async () => {
  db.flow_nodes = [replyNode({ id: 'n2', label: 'Our prices', content_type: 'text' })];
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });

  const node = db.flow_nodes[0];
  assert.deepEqual(autoTranslatedOf(node, nodeSlots(node)), { label: ['hi'] });

  node.label_translations = { ...node.label_translations, hi: 'हमारे दाम' }; // the owner edits it
  assert.deepEqual(autoTranslatedOf(node, nodeSlots(node)), {});

  const business = db.businesses[0];
  assert.deepEqual(autoTranslatedOf(business, businessSlots(business)), { welcomeMessage: ['hi'] });
});

test("a second run translates nothing new and costs nothing; another language only adds its own", async () => {
  db.flow_nodes = [replyNode({ id: 'n2', label: 'Our prices', content_type: 'text' })];
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });
  const used = db.usage[`${BIZ}:${MONTH}`];
  azureCalls = [];

  const again = await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });
  assert.equal(again.translated, 0);
  assert.equal(azureCalls.length, 0);
  assert.equal(db.usage[`${BIZ}:${MONTH}`], used);

  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'gu', scope: 'flow' });
  assert.deepEqual(db.flow_nodes[0].label_translations, { hi: '[hi] Our prices', gu: '[gu] Our prices' });
});

test('over the cap the whole run is refused before anything is written', async () => {
  db.app_config.push({ key: 'translate_monthly_char_cap', value: '5' });
  db.flow_nodes = [replyNode({ id: 'n2', label: 'Our prices', content_type: 'text' })];
  await assert.rejects(flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' }), (e) => e.statusCode === 429);
  assert.equal(db.flow_nodes[0].label_translations, null);
  assert.equal(azureCalls.length, 0);
});

test('a translated button title over WhatsApp\'s 20 characters is skipped (English stays), not cut', async () => {
  db.flow_nodes = [replyNode({ id: 'n1', label: 'Pick', label_translations: { hi: 'x' } })];
  db.flow_edges = [{ id: 'e1', business_id: BIZ, from_node_id: 'n1', to_node_id: 'n1', label: 'Prices', label_translations: null, auto_translations: null }];
  azureBehaviour = async (body, to) => ({ data: body.map(b => ({ translations: [{ text: b.Text.length < 20 ? `${b.Text} — बहुत लंबा अनुवाद यहाँ` : b.Text, to }] })) });

  const result = await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });
  assert.equal(db.flow_edges[0].label_translations, null);
  assert.deepEqual(result.skipped.find(s => s.slot === 'label').reason.startsWith('Translation is'), true);
});

test('choice-question options: a plain string becomes the {value,label,labelTranslations} shape the engine already reads', async () => {
  db.flow_nodes = [{
    id: 'q1', business_id: BIZ, node_type: 'question', content_type: 'buttons', is_computed: false, label: 'Trip type?', label_translations: { hi: 'यात्रा?' },
    options: ['One Way', { value: 'Round Trip', label: 'Round Trip', labelTranslations: { hi: 'आना-जाना' } }], auto_translations: null
  }];
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });
  const options = db.flow_nodes[0].options;
  assert.deepEqual(options[0], { value: 'One Way', label: 'One Way', labelTranslations: { hi: '[hi] One Way' } });
  assert.deepEqual(options[1].labelTranslations, { hi: 'आना-जाना' }, 'existing option translation untouched');
  assert.deepEqual(autoTranslatedOf(db.flow_nodes[0], nodeSlots(db.flow_nodes[0])), { 'options.0': ['hi'] });
});

test('carousel card bodies and booking-form labels / options are covered', async () => {
  db.flow_nodes = [replyNode({ id: 'c1', content_type: 'carousel', label: 'Look', label_translations: { hi: 'देखें' }, carousel_cards: [{ media_id: 'm', media_type: 'image', body: 'Sedan', body_translations: null }] })];
  db.businesses[0].flow_fields = [{ name: 'trip', label: 'Trip', type: 'dropdown', options: ['One Way'] }];
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow' });
  assert.deepEqual(db.flow_nodes[0].carousel_cards[0].body_translations, { hi: '[hi] Sedan' });
  assert.equal(db.businesses[0].flow_fields[0].labelTranslations.hi, '[hi] Trip');
  assert.equal(db.businesses[0].flow_fields[0].optionTranslations.hi['One Way'], '[hi] One Way');
});

test('a category template is filled in place, never counted against a business, and keeps existing translations', async () => {
  db.flow_snapshots = [{
    id: 'tpl1', is_category_template: true,
    nodes: [{ id: 'n1', node_type: 'reply', content_type: 'text', label: 'Hello there', label_translations: { gu: 'ગુજ' } }, { id: 'n2', node_type: 'reply', content_type: 'text', label: 'Prices', label_translations: null }],
    edges: []
  }];
  const result = await flowTranslate.translateTemplate({ template: db.flow_snapshots[0], lang: 'gu' });
  const nodes = db.flow_snapshots[0].nodes;
  assert.deepEqual(nodes[0].label_translations, { gu: 'ગુજ' });
  assert.deepEqual(nodes[1].label_translations, { gu: '[gu] Prices' });
  assert.deepEqual(autoTranslatedOf(nodes[1], nodeSlots(nodes[1])), { label: ['gu'] });
  assert.equal(result.translated, 1);
  assert.deepEqual(db.usage, {}, 'no business usage row');
  assert.equal(db.globalUsage[MONTH], 'Prices'.length);

  // Zero API calls for a business created from it afterwards: the second run is all cache / nothing missing.
  azureCalls = [];
  await flowTranslate.translateTemplate({ template: db.flow_snapshots[0], lang: 'gu' });
  assert.equal(azureCalls.length, 0);
});

test('signup: every non-English language is marked pending first, then done; the canvas can read the status', async () => {
  db.flow_nodes = [replyNode({ id: 'n2', label: 'Our prices', content_type: 'text' })];
  const { statusSummary, isTranslating } = require('../utils/translationStatus');

  const { started, done } = await flowTranslate.startNewBusinessTranslation(BIZ);
  assert.equal(started, true);
  // The marks are in place by the time the caller continues (before the background work finishes).
  assert.deepEqual(statusSummary(db.businesses[0].translation_status), { hi: 'pending', gu: 'pending' });
  assert.equal(isTranslating(statusSummary(db.businesses[0].translation_status)), true);

  await done;
  assert.deepEqual(statusSummary(db.businesses[0].translation_status), { hi: 'done', gu: 'done' });
  assert.deepEqual(db.flow_nodes[0].label_translations, { hi: '[hi] Our prices', gu: '[gu] Our prices' });
  assert.equal(db.usage[`${BIZ}:${MONTH}`] || 0, 0, "the new owner's allowance is not spent");
});

test('signup with Azure down: marked failed (so the canvas unlocks), English fallback stays, nothing throws', async () => {
  azureBehaviour = async () => { throw Object.assign(new Error('down'), { response: { status: 400 } }); };
  db.flow_nodes = [replyNode({ id: 'n2', label: 'Our prices', content_type: 'text' })];
  const { done } = await flowTranslate.startNewBusinessTranslation(BIZ);
  const results = await done;
  assert.ok(results.hi.error);
  const { statusSummary } = require('../utils/translationStatus');
  assert.deepEqual(statusSummary(db.businesses[0].translation_status), { hi: 'failed', gu: 'failed' });
});

test('signup without Azure configured: nothing started, no status written', async () => {
  delete process.env.AZURE_TRANSLATOR_REGION;
  const { started } = await flowTranslate.startNewBusinessTranslation(BIZ);
  assert.equal(started, false);
  assert.equal(db.businesses[0].translation_status, null);
});

test('a stale pending status reads as failed so the canvas is never locked for good', () => {
  const { statusSummary } = require('../utils/translationStatus');
  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  assert.deepEqual(statusSummary({ hi: { status: 'pending', at: old }, gu: { status: 'pending', at: fresh } }), { hi: 'failed', gu: 'pending' });
  assert.deepEqual(statusSummary(null), {});
});

test('edge slots take their title limit from the parent (list rows 24, buttons 20)', () => {
  const list = edgeSlots({ label: 'Prices', description: 'See all' }, { node_type: 'reply', content_type: 'list' });
  assert.deepEqual(list.map(s => [s.id, s.max]), [['label', 24], ['description', 72]]);
  const buttons = edgeSlots({ label: 'Prices' }, { node_type: 'reply', content_type: 'buttons' });
  assert.equal(buttons[0].max, 20);
});

// ---------------------------------------------------------------- Catalogue
const { shapeSettingsAuto, shapeCollectionAuto, shapeItemAuto } = require('../utils/translationSlots');

const seedCatalogue = () => {
  db.catalogs = [{ id: 'cat1', business_id: BIZ, auto_translations: null, settings: { enabled: true, text: 'Our catalogue', emptyText: 'Coming soon', viewButtonLabel: 'View designs', textTranslations: null,
    orderAction: { type: 'message', text: 'Thanks for ordering', textTranslations: null } } }];
  db.catalog_collections = [{ id: 'col1', business_id: BIZ, title: 'Silk Sarees', title_translations: null, body: 'Pure silk', body_translations: { hi: 'human body' }, price_label: 'From 999', price_label_translations: null, auto_translations: null }];
  db.catalog_items = [
    { id: 'it1', business_id: BIZ, collection_id: 'col1', design_no: 'A-102', price_text: '1,499', caption: 'Soft cotton', caption_translations: null, auto_translations: null },
    { id: 'it2', business_id: BIZ, collection_id: 'col1', design_no: 'A-103', price_text: '999', caption: null, caption_translations: null, auto_translations: null }
  ];
  db.flow_nodes = [
    { id: 'n1', business_id: BIZ, node_type: 'reply', content_type: 'text', keyword: 'faq', label: 'We open at 9', label_translations: null, auto_translations: null },
    { id: 'n2', business_id: BIZ, node_type: 'reply', content_type: 'catalog', keyword: 'catalogue', label: 'Our catalogue', label_translations: null, auto_translations: null }
  ];
};

test('catalogue: titles, card text, price labels, captions and the settings texts are translated; design numbers and prices never', async () => {
  seedCatalogue();
  const result = await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow', only: 'catalog' });
  const sent = azureCalls.flatMap(c => c.texts).sort();
  assert.deepEqual(sent, ['Coming soon', 'From 999', 'Our catalogue', 'Silk Sarees', 'Soft cotton', 'Thanks for ordering', 'View designs']);
  assert.equal(result.translated, 7);
  const [col] = db.catalog_collections;
  assert.equal(col.title_translations.hi, '[hi] Silk Sarees');
  assert.equal(col.price_label_translations.hi, '[hi] From 999');
  assert.equal(col.body_translations.hi, 'human body', 'a human translation is never overwritten');
  assert.equal(db.catalog_items[0].caption_translations.hi, '[hi] Soft cotton');
  assert.equal(db.catalog_items[1].caption_translations, null, 'no caption, nothing to translate');
  const settings = db.catalogs[0].settings;
  assert.equal(settings.textTranslations.hi, '[hi] Our catalogue');
  assert.equal(settings.viewButtonLabelTranslations.hi, '[hi] View designs');
  assert.equal(settings.orderAction.textTranslations.hi, '[hi] Thanks for ordering');
  assert.equal(settings.enabled, true, 'the other settings are untouched');
});

test('catalogue: the auto-translated badges are reported until the text is hand-edited', async () => {
  seedCatalogue();
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow', only: 'catalog' });
  assert.deepEqual(shapeCollectionAuto(db.catalog_collections[0]), { title: ['hi'], priceLabel: ['hi'] });
  assert.deepEqual(shapeItemAuto(db.catalog_items[0]), { caption: ['hi'] });
  assert.deepEqual(shapeSettingsAuto(db.catalogs[0]), { text: ['hi'], emptyText: ['hi'], viewButtonLabel: ['hi'], 'orderAction.text': ['hi'] });
  db.catalog_items[0].caption_translations = { hi: 'my own words' };
  assert.deepEqual(shapeItemAuto(db.catalog_items[0]), {});
});

test('catalogue only: the rest of the flow and the welcome message are not translated, and the catalogue node is never a flow slot', async () => {
  seedCatalogue();
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow', only: 'catalog' });
  assert.equal(db.flow_nodes[0].label_translations, null);
  assert.equal(db.businesses[0].welcome_message_translations, null);
  assert.equal(azureCalls.some(c => c.texts.includes('We open at 9')), false);

  azureCalls = [];
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'gu', scope: 'flow' });   // the whole flow also covers the Catalogue
  const sent = azureCalls.flatMap(c => c.texts);
  assert.ok(sent.includes('We open at 9') && sent.includes('Silk Sarees') && sent.some(t => t.startsWith('Welcome to')));
  assert.equal(sent.filter(t => t === 'Our catalogue').length, 1, 'once, from the settings, not again from the node');
  assert.equal(db.flow_nodes[1].label_translations, null, 'the catalogue node keeps no translation of its own');
});

test('catalogue: a second run translates nothing', async () => {
  seedCatalogue();
  await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow', only: 'catalog' });
  azureCalls = [];
  const again = await flowTranslate.translateBusinessFlow({ businessId: BIZ, lang: 'hi', scope: 'flow', only: 'catalog' });
  assert.equal(again.translated, 0);
  assert.equal(azureCalls.length, 0);
});
