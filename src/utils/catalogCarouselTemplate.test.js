// Run: node --test src/utils/catalogCarouselTemplate.test.js
// The catalogue broadcast's carousel template: names, wording, the JSON that creates it on Meta, and the
// components of one send. Pure.
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('./catalogCarouselTemplate');
const { validateComponents } = require('./templateValidation');
const { parseCatalogTapId, pageId, collectionOrderId } = require('./catalogIds');

const C1 = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BC = '7c1d5e84-2a63-4f0e-b1a9-5d8e3f6a7b92';

test('names: apnabot_catalog_v<version>_<cards>_<lang>_<buttons>, and the current version parses back', () => {
  assert.equal(t.TEMPLATE_VERSION, 2);
  assert.equal(t.templateName(3, 'en', 2), 'apnabot_catalog_v2_3_en_2');
  assert.equal(t.templateName(10, 'hi', 1), 'apnabot_catalog_v2_10_hi_1');
  assert.deepEqual(t.parseTemplateName('apnabot_catalog_v2_10_hi_1'), { cardCount: 10, lang: 'hi', buttonCount: 1 });
  // the unversioned names of the first (rejected) wording, and any other version, are not ours to look up
  for (const bad of ['apnabot_catalog_3_en_2', 'apnabot_catalog_v1_3_en_2', 'apnabot_catalog_v3_3_en_2', 'apnabot_catalog_v2_3_en', 'apnabot_catalog_v2_3_en_3', 'promo_3_en_2', 'apnabot_catalog_v2_x_en_2', null]) {
    assert.equal(t.parseTemplateName(bad), null, String(bad));
  }
});

test('a customer language maps to a template language; anything without wording gets English', () => {
  assert.equal(t.templateLanguageFor('hi'), 'hi');
  assert.equal(t.templateLanguageFor('mr'), 'mr');
  assert.equal(t.templateLanguageFor('en'), 'en');
  for (const other of [null, undefined, '', 'gu', 'ta', 'or', 'xx']) assert.equal(t.templateLanguageFor(other), 'en', String(other));
  assert.deepEqual([t.metaLanguageOf('en'), t.metaLanguageOf('hi'), t.metaLanguageOf('mr')], ['en_US', 'hi', 'mr']);
});

test('every language and button count passes the spec check, with the built-in labels', () => {
  for (const lang of t.TEMPLATE_LANGUAGES) {
    for (const buttons of [1, 2]) assert.deepEqual(t.validateSpec({ cardCount: 10, lang, buttonCount: buttons }), [], `${lang}/${buttons}`);
  }
  assert.deepEqual(t.buttonLabels('en', 2), ['View designs', 'Order']);
  assert.deepEqual(t.buttonLabels('en', 1), ['View designs']);
  assert.equal(t.buttonLabels('hi', 2).length, 2);
});

test('the spec check refuses a bad card count, language or button count', () => {
  assert.equal(t.validateSpec({ cardCount: 1, lang: 'en', buttonCount: 2 }).length, 1);
  assert.equal(t.validateSpec({ cardCount: 11, lang: 'en', buttonCount: 2 }).length, 1);
  assert.equal(t.validateSpec({ cardCount: 3, lang: 'gu', buttonCount: 2 }).length, 1);
  assert.equal(t.validateSpec({ cardCount: 3, lang: 'en', buttonCount: 3 }).length, 1);
});

test('the wording follows Meta body rules: one variable, never first or last', () => {
  for (const text of [...Object.values(t.GREETING), ...Object.values(t.CARD_BODY)]) {
    assert.equal((text.match(/\{\{\d+\}\}/g) || []).length, 1, text);
    assert.doesNotMatch(text.trim(), /^\{\{/);
    assert.doesNotMatch(text.trim(), /\}\}$/);
  }
  assert.equal(t.GREETING.en, 'Hi {{1}}, our new collection has just arrived. Swipe through the cards below and tap the button to see every design with its price \u{1F447}');
  assert.equal(t.CARD_BODY.en, 'New arrivals in {{1}}. Tap the button below to see all designs and prices.');
  assert.deepEqual(Object.keys(t.CARD_BODY).sort(), [...t.TEMPLATE_LANGUAGES].sort());
});

// Meta rejected "✨ {{1}} ✨" (subcode 2388293, Params Words Ratio Exceeds Limit). Its exact rule is not published; this is
// our approximation (fixed words per variable), so a wording change that is too variable-heavy fails here, not at Meta.
test('the words-to-variables pre-check: the rejected wording fails, every shipped wording passes', () => {
  assert.equal(t.fixedWordsPerVariable('✨ {{1}} ✨'), 0);
  assert.ok(t.fixedWordsPerVariable('✨ {{1}} ✨') < t.MIN_FIXED_WORDS_PER_VARIABLE);
  assert.ok(t.fixedWordsPerVariable('Hi {{1}}, {{2}} is here') < t.MIN_FIXED_WORDS_PER_VARIABLE);
  assert.equal(t.fixedWordsPerVariable('no variables here'), Infinity);
  for (const lang of t.TEMPLATE_LANGUAGES) {
    for (const [label, text] of [['greeting', t.GREETING[lang]], ['card body', t.CARD_BODY[lang]]]) {
      assert.ok(t.fixedWordsPerVariable(text) >= t.MIN_FIXED_WORDS_PER_VARIABLE, `${lang} ${label}: ${t.fixedWordsPerVariable(text)} fixed words`);
    }
  }
});

test('validateSpec refuses a variable-heavy wording (the error Meta gave on the first submit)', () => {
  const saved = { ...t.CARD_BODY };
  try {
    t.CARD_BODY.en = '✨ {{1}} ✨';
    const errors = t.validateSpec({ cardCount: 3, lang: 'en', buttonCount: 2 });
    assert.ok(errors.some((e) => /Params Words Ratio/.test(e)), errors.join(' | '));
    t.CARD_BODY.en = 'Hot new {{1}} now on sale today';   // 6 fixed words - passes the ratio
    assert.deepEqual(t.validateSpec({ cardCount: 3, lang: 'en', buttonCount: 2 }), []);
    t.CARD_BODY.en = 'Look {{1}} now';                    // 2 words: too variable-heavy
    assert.ok(t.validateSpec({ cardCount: 3, lang: 'en', buttonCount: 2 }).some((e) => /Params Words Ratio/.test(e)));
  } finally {
    Object.assign(t.CARD_BODY, saved);
  }
});

test('the card body fits 160 characters with the longest title + price, per language; only the value is cut', () => {
  for (const lang of t.TEMPLATE_LANGUAGES) {
    const longest = t.cardText('T'.repeat(300), 'P'.repeat(300), lang);
    assert.equal(longest.length, t.cardTextMax(lang), lang);
    const rendered = t.CARD_BODY[lang].replace('{{1}}', longest);
    assert.ok(rendered.length <= 160, `${lang}: ${rendered.length}`);
    assert.ok(rendered.startsWith(t.CARD_BODY[lang].split('{{1}}')[0]) && rendered.endsWith(t.CARD_BODY[lang].split('{{1}}')[1]), 'the fixed text is intact');
    assert.ok(t.cardTextMax(lang) >= 80, `${lang} leaves room for a realistic "Title · Price"`);
  }
  const realistic = t.cardText('Embroidered Cotton Kurta Set', 'From ₹1,499', 'en');
  assert.equal(realistic, 'Embroidered Cotton Kurta Set · From ₹1,499');
  assert.equal(t.CARD_BODY.en.replace('{{1}}', realistic).length < 160, true);
});

test('creation JSON: BODY + CAROUSEL with exactly N identical cards, a sample handle on each, MARKETING', () => {
  const handles = ['h1', 'h2', 'h3'];
  const payload = t.buildCreatePayload({ cardCount: 3, lang: 'en', buttonCount: 2, headerHandles: handles });
  assert.equal(payload.name, 'apnabot_catalog_v2_3_en_2');
  assert.equal(payload.category, 'MARKETING');
  assert.equal(payload.language, 'en_US');
  assert.deepEqual(payload.components.map(c => c.type), ['BODY', 'CAROUSEL']);
  assert.equal(payload.components[0].text, t.GREETING.en);
  assert.deepEqual(payload.components[0].example, { body_text: [['Priya']] });
  const { cards } = payload.components[1];
  assert.equal(cards.length, 3);
  cards.forEach((card, i) => {
    assert.deepEqual(card.components.map(c => c.type), ['HEADER', 'BODY', 'BUTTONS']);
    assert.deepEqual(card.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: [handles[i]] } });
    assert.equal(card.components[1].text, t.CARD_BODY.en);
    assert.equal(card.components[1].example.body_text[0].length, 1);
    assert.deepEqual(card.components[2].buttons, [{ type: 'QUICK_REPLY', text: 'View designs' }, { type: 'QUICK_REPLY', text: 'Order' }]);
  });
  // every card has the same components apart from its own sample handle
  const strip = (card) => JSON.stringify(card.components.map(c => (c.type === 'HEADER' ? { ...c, example: null } : c)));
  assert.equal(new Set(cards.map(strip)).size, 1);
  assert.deepEqual(validateComponents([payload.components[0]], { requireExamples: true }), []);
});

test('creation JSON: a catalogue with no order action has one button per card; hi/mr use their locale', () => {
  const one = t.buildCreatePayload({ cardCount: 2, lang: 'hi', buttonCount: 1, headerHandles: ['a', 'b'] });
  assert.equal(one.name, 'apnabot_catalog_v2_2_hi_1');
  assert.equal(one.language, 'hi');
  assert.equal(one.components[1].cards[0].components[1].text, t.CARD_BODY.hi, 'each language\'s cards carry its own card body');
  assert.equal(one.components[1].cards[0].components[2].buttons.length, 1);
  assert.equal(t.buildCreatePayload({ cardCount: 2, lang: 'mr', buttonCount: 2, headerHandles: ['a', 'b'] }).language, 'mr');
});

test('creation JSON needs one handle per card', () => {
  assert.throws(() => t.buildCreatePayload({ cardCount: 3, lang: 'en', buttonCount: 2, headerHandles: ['a'] }), /3 sample header handles/);
});

test('the stored components carry no handles', () => {
  const stored = t.buildStoredComponents({ cardCount: 2, lang: 'en', buttonCount: 2 });
  assert.equal(stored[1].cards.length, 2);
  assert.equal(JSON.stringify(stored).includes('header_handle'), false);
});

test('card text is one plain line, "title · price", and fits the card', () => {
  assert.equal(t.cardText('Red Kurta', 'Rs 999'), 'Red Kurta · Rs 999');
  assert.equal(t.cardText('*Red*\nKurta', '  from\tRs 999 '), 'Red Kurta · from Rs 999');
  assert.equal(t.cardText('Red Kurta', null), 'Red Kurta');
  assert.equal(t.cardText('', ''), '');
  const long = t.cardText('A'.repeat(60), 'B'.repeat(30) + 'C'.repeat(200));
  assert.ok(long.length <= t.cardTextMax('en'));
  assert.doesNotMatch(long, /[\n\t*]/);
});

test('the customer name falls back per language', () => {
  assert.equal(t.greetingName('Asha  Rao', 'en'), 'Asha Rao');
  assert.equal(t.greetingName(null, 'en'), 'there');
  assert.equal(t.greetingName('   ', 'hi'), t.NAME_FALLBACK.hi);
  assert.equal(t.greetingName('x'.repeat(100), 'en').length, 60);
});

test('send components: name in the body, then per card the image id, the card text and the payloads', () => {
  const payloads = (id) => [`cat:${id}:p:0:b:${BC}`, `cat:${id}:order:b:${BC}`];
  const components = t.buildSendComponents({
    lang: 'en', customerName: 'Priya',
    cards: [{ mediaId: 'M1', text: 'Red Kurta', payloads: payloads(C1) }, { mediaId: 'M2', text: 'Blue Saree', payloads: payloads(C1) }]
  });
  assert.deepEqual(components[0], { type: 'body', parameters: [{ type: 'text', text: 'Priya' }] });
  assert.equal(components[1].type, 'carousel');
  assert.equal(components[1].cards.length, 2);
  assert.deepEqual(components[1].cards[1], {
    card_index: 1,
    components: [
      { type: 'header', parameters: [{ type: 'image', image: { id: 'M2' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Blue Saree' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: payloads(C1)[0] }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: payloads(C1)[1] }] }
    ]
  });
});

test('the payloads we send are the catalogue ids the bot routes, with the broadcast suffix', () => {
  assert.deepEqual(parseCatalogTapId(pageId(C1, 0, BC)), { kind: 'page', collectionId: C1, page: 0, broadcastId: BC });
  assert.deepEqual(parseCatalogTapId(collectionOrderId(C1, BC)), { kind: 'collection_order', collectionId: C1, broadcastId: BC });
});

test('send components with one button per card, and a missing name', () => {
  const components = t.buildSendComponents({ lang: 'hi', customerName: undefined, cards: [{ mediaId: 'M', text: 'x', payloads: ['cat:a'] }] });
  assert.equal(components[0].parameters[0].text, t.NAME_FALLBACK.hi);
  assert.equal(components[1].cards[0].components.filter(c => c.type === 'button').length, 1);
});

test('a carousel template can never be picked as a normal broadcast / follow-up template', () => {
  const { computeSendSupport } = require('./templateSendSupport');
  const { isTemplateUsable } = require('./templateStatus');
  const row = {
    status: 'approved', send_support: 'unsupported_component', header_type: 'NONE', body_text: t.GREETING.en,
    meta_components: t.buildStoredComponents({ cardCount: 3, lang: 'en', buttonCount: 2 })
  };
  assert.equal(computeSendSupport(row), 'unsupported_component', 'a recomputed value (the template sync) agrees with the stored one');
  assert.equal(isTemplateUsable(row), false);
  assert.equal(isTemplateUsable({ ...row, send_support: 'ok' }), false, 'even if the column were overwritten, the components still block it');
});
