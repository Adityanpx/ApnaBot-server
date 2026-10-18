// Run: node --test src/utils/carouselPayload.test.js
// Pure carousel planning: native Meta carousel vs the sequential fallback, languages, placeholders,
// plan caps, and the Graph API / chat-history payload shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planCarouselSend, buildCarouselPayload, summarizeCarousel, limitLineBreaks
} = require('./carouselPayload');
const { getLocalizedText } = require('./localization');

const media = (id, type = 'image') => [id, { id, url: `https://r2.test/${id}`, media_type: type }];
const MEDIA = new Map([media('m1'), media('m2'), media('m3'), media('v1', 'video')]);
const card = (n, extra = {}) => ({ media_id: `m${n}`, media_type: 'image', body: `Card ${n}`, body_translations: { hi: `कार्ड ${n}` }, ...extra });
const edge = (id, cardIndex, label, displayOrder = 0) => ({ id, nextKeyword: id, cardIndex, label, labelTranslations: { hi: `${label}-hi` }, displayOrder });

const plan = (over = {}) => planCarouselSend({
  node: { carouselCards: [card(1), card(2)] },
  edges: [edge('e1', 0, 'Book'), edge('e2', 1, 'Book')],
  mediaById: MEDIA, maxCards: 10, videoAllowed: false,
  localize: (rec, field) => getLocalizedText(rec, field, 'en'),
  ...over
});

test('2 cards with media and one button each: a native carousel', () => {
  const p = plan();
  assert.equal(p.native, true);
  assert.deepEqual(p.cards.map(c => [c.index, c.mediaUrl, c.text, c.buttons.map(b => b.nextKeyword)]), [
    [0, 'https://r2.test/m1', 'Card 1', ['e1']],
    [1, 'https://r2.test/m2', 'Card 2', ['e2']]
  ]);
});

test('text and button labels follow the customer language, falling back to the stored text', () => {
  const p = plan({ localize: (rec, field) => getLocalizedText(rec, field, 'hi') });
  assert.deepEqual(p.cards.map(c => [c.text, c.buttons[0].title]), [['कार्ड 1', 'Book-hi'], ['कार्ड 2', 'Book-hi']]);
  const mr = plan({ localize: (rec, field) => getLocalizedText(rec, field, 'mr') });
  assert.equal(mr.cards[0].text, 'Card 1');
});

test('placeholders in card text go through the template function', () => {
  const p = plan({ node: { carouselCards: [card(1, { body: 'Hi {{businessName}}', body_translations: null }), card(2)] }, template: (t) => t.replace('{{businessName}}', 'Sunrise') });
  assert.equal(p.cards[0].text, 'Hi Sunrise');
});

test('buttons are ordered by displayOrder and capped titles stay within 20 characters', () => {
  const p = plan({ edges: [edge('b', 0, 'Second one', 2), edge('a', 0, 'First one is a very long title', 1), edge('c', 1, 'x'), edge('d', 1, 'y')] });
  assert.deepEqual(p.cards[0].buttons.map(b => b.nextKeyword), ['a', 'b']);
  assert.ok(p.cards[0].buttons.every(b => b.title.length <= 20));
});

test('cards beyond the CURRENT plan limit are skipped', () => {
  const p = plan({
    node: { carouselCards: [card(1), card(2), card(3)] },
    edges: [edge('e1', 0, 'A'), edge('e2', 1, 'A'), edge('e3', 2, 'A')], maxCards: 2
  });
  assert.equal(p.cards.length, 2);
  assert.equal(p.skipped.overPlan, 1);
  assert.equal(p.native, true);
});

test('a card whose media no longer resolves is dropped from a native carousel when 2+ remain', () => {
  const p = plan({
    node: { carouselCards: [card(1), card(2, { media_id: 'gone' }), card(3)] },
    edges: [edge('e1', 0, 'A'), edge('e2', 1, 'A'), edge('e3', 2, 'A')]
  });
  assert.equal(p.native, true);
  assert.deepEqual(p.cards.map(c => c.index), [0, 2]);
  assert.equal(p.skipped.noMedia, 1);
});

test('fewer than 2 cards with media: the fallback keeps EVERY card so every button still routes', () => {
  const p = plan({
    node: { carouselCards: [card(1), card(2, { media_id: null }), card(3, { media_id: null })] },
    edges: [edge('e1', 0, 'A'), edge('e2', 1, 'B'), edge('e3', 2, 'C')]
  });
  assert.equal(p.native, false);
  assert.match(p.reason, /fewer than 2/);
  assert.deepEqual(p.cards.map(c => [c.mediaUrl, c.text, c.buttons[0].nextKeyword]), [
    ['https://r2.test/m1', 'Card 1', 'e1'], [null, 'Card 2', 'e2'], [null, 'Card 3', 'e3']
  ]);
});

test('cloned template cards (no media at all): text fallback with all card buttons', () => {
  const p = plan({
    node: { carouselCards: [card(1, { media_id: null }), card(2, { media_id: null })] },
    edges: [edge('e1', 0, 'Details'), edge('e1b', 0, 'Book'), edge('e2', 1, 'Details'), edge('e2b', 1, 'Book')]
  });
  assert.equal(p.native, false);
  assert.match(p.reason, /no card has resolvable media/);
  assert.deepEqual(p.cards.map(c => c.buttons.map(b => b.nextKeyword)), [['e1', 'e1b'], ['e2', 'e2b']]);
});

test('uneven button counts across cards (or 0 / 3 buttons) fall back instead of being sent natively', () => {
  const uneven = plan({ edges: [edge('e1', 0, 'A'), edge('e1b', 0, 'B'), edge('e2', 1, 'A')] });
  assert.equal(uneven.native, false);
  assert.equal(uneven.cards.length, 2);
  assert.equal(plan({ edges: [] }).native, false);
  assert.equal(plan({ edges: [edge('1', 0, 'a'), edge('2', 0, 'b'), edge('3', 0, 'c'), edge('4', 1, 'a'), edge('5', 1, 'b'), edge('6', 1, 'c')] }).native, false);
});

test('a video card needs the plan to allow video; otherwise it counts as having no media', () => {
  const node = { carouselCards: [card(1), { media_id: 'v1', media_type: 'video', body: 'Clip' }] };
  const edges = [edge('e1', 0, 'A'), edge('e2', 1, 'A')];
  assert.equal(plan({ node, edges, videoAllowed: false }).native, false);
  const ok = plan({ node, edges, videoAllowed: true });
  assert.equal(ok.native, true);
  assert.equal(ok.cards[1].mediaType, 'video');
});

test('a card whose stored media type disagrees with the library row is not used', () => {
  const p = plan({ node: { carouselCards: [card(1), card(2, { media_type: 'video' })] } });
  assert.equal(p.cards.filter(c => c.mediaUrl).length, 1);
  assert.equal(p.native, false);
});

test('card text is cut to 160 characters and 2 line breaks', () => {
  assert.equal(limitLineBreaks('a\nb\nc\nd\ne'), 'a\nb\nc d e');
  const p = plan({ node: { carouselCards: [card(1, { body: 'x'.repeat(200), body_translations: null }), card(2)] } });
  assert.equal(p.cards[0].text.length, 160);
});

test('buildCarouselPayload matches the Graph API shape', () => {
  const p = plan();
  const payload = buildCarouselPayload('Pick one', p.cards);
  assert.equal(payload.type, 'carousel');
  assert.deepEqual(payload.body, { text: 'Pick one' });
  assert.deepEqual(payload.action.cards[0], {
    card_index: 0, type: 'cta_url',
    header: { type: 'image', image: { link: 'https://r2.test/m1' } },
    body: { text: 'Card 1' },
    action: { buttons: [{ type: 'quick_reply', quick_reply: { id: 'e1', title: 'Book' } }] }
  });
  const noText = buildCarouselPayload('b', [{ index: 0, mediaType: 'video', mediaUrl: 'u', text: '', buttons: [{ nextKeyword: 'x', title: 'T' }] }]);
  assert.equal(noText.action.cards[0].body, undefined);
  assert.deepEqual(noText.action.cards[0].header, { type: 'video', video: { link: 'u' } });
});

test('summarizeCarousel keeps body, media, text and button labels per card', () => {
  const s = summarizeCarousel('Pick one', plan().cards);
  assert.equal(s.kind, 'carousel');
  assert.equal(s.body, 'Pick one');
  assert.deepEqual(s.cards[1], { mediaType: 'image', mediaUrl: 'https://r2.test/m2', text: 'Card 2', buttons: [{ id: 'e2', title: 'Book' }] });
});

test('buttons with no card_index (a buttons reply just switched to carousel) are ignored and counted', () => {
  const p = plan({ edges: [edge('e1', 0, 'Book'), edge('e2', 1, 'Book'), edge('old1', null, 'Old'), { id: 'old2', nextKeyword: 'old2', label: 'Older' }] });
  assert.equal(p.native, true, 'the unassigned ones do not break parity');
  assert.deepEqual(p.cards.map(c => c.buttons.map(b => b.nextKeyword)), [['e1'], ['e2']]);
  assert.equal(p.skipped.unassignedButtons, 2);
});
