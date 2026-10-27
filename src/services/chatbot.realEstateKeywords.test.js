// Run: node --test src/services/chatbot.realEstateKeywords.test.js
// Runs the real reply matcher (legacy and Unicode normalizer) over templates/category/real_estate.default.json's
// reply nodes: the short keywords must not fire inside common words, and the intended phrases must land on the
// right node. Aliases are always matched as plain substrings (chatbot.service.js), so the rules are checked here.
// Redis, Supabase and the logger are stubbed; nothing here touches a real service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/redis', {});
stub('../config/supabase', { rpc: () => Promise.resolve({ error: null }), from: () => { throw new Error('unexpected DB call'); } });
stub('../utils/logger', { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} });
stub('./unicodeMatching.service', { isUnicodeMatchingEnabled: async () => false });

const chatbot = require('./chatbot.service');
const { toCamelCase } = require('../utils/caseConvert');

const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'templates', 'category', 'real_estate.default.json'), 'utf8'));
const nodes = template.nodes.filter((n) => n.node_type === 'reply').map(toCamelCase);
const reversed = nodes.slice().reverse();

const modes = [
  ['legacy', (list, text) => chatbot.matchNodeInList(list, text)],
  ['unicode', (list, text) => chatbot.matchNodeInList(list, text, { unicode: true })]
];
const kw = (n) => (n ? n.keyword : null);

test('no keyword or alias under 4 letters is a Latin "contains" match, except buy / bhk', () => {
  const short = [];
  for (const n of nodes) {
    const typed = [n.keyword, ...n.hindiAliases].filter((w) => /^[\x00-\x7f]+$/.test(w));
    for (const w of typed) {
      const contains = n.matchType === 'contains' || w !== n.keyword;
      if (contains && w.replace(/[^a-z]/gi, '').length < 4) short.push(`${n.keyword}:${w}`);
    }
  }
  assert.deepEqual(short, ['hi:hey', 'hi:hii', 'hi:hlo', 'buy:buy', 'buy:bhk'], 'greeting aliases are the shared menu words, the rest are the two agreed exceptions');
});

test('"rent" is exact: it does not fire inside current / parent / different / apparent / transparent', () => {
  for (const [mode, match] of modes) {
    for (const text of ['current status', 'what is different', 'apparent reason', 'transparent pricing', 'parents will visit', 'my parent will come']) {
      const hit = kw(match(nodes, text));
      assert.notEqual(hit, 'rent', `${mode}: "${text}" -> ${hit}`);
      assert.equal(hit, null, `${mode}: "${text}"`);
    }
    assert.equal(kw(match(nodes, 'rent')), 'rent', mode);
    assert.equal(kw(match(nodes, 'Rental')), 'rent', mode);
  }
});

test('"please" / "remind me" / "premium" / "example" fire nothing (no lease / emi / map aliases)', () => {
  for (const [mode, match] of modes) {
    for (const text of ['please share details', 'remind me tomorrow', 'premium flats', 'for example', 'thanks', 'ok', 'roadmap']) {
      const hit = kw(match(nodes, text));
      assert.ok(hit === null || hit === 'buy', `${mode}: "${text}" -> ${hit}`);
      if (text !== 'premium flats') assert.equal(hit, null, `${mode}: "${text}"`);
    }
  }
});

test('buy / loan / call / address keywords land on their node, and "buyer" / "personal loan" are fine', () => {
  const expected = [
    ['buy', 'buy'], ['I want to buy', 'buy'], ['buyer', 'buy'], ['2bhk', 'buy'], ['plot', 'buy'], ['purchase', 'buy'],
    ['loan', 'loan'], ['home loan', 'loan'], ['personal loan', 'loan'], ['EMI loan', 'loan'], ['finance', 'loan'],
    ['call me', 'call'], ['talk to agent', 'call'], ['person', 'call'],
    ['address', 'address'], ['location', 'address'], ['office', 'address'], ['maps', 'address'], ['google map', 'address'],
    ['rent', 'rent'], ['rental', 'rent'], ['need a place on rent', 'rent'],
    ['site_visit', 'site_visit']
  ];
  for (const [mode, match] of modes) {
    for (const [text, node] of expected) assert.equal(kw(match(nodes, text)), node, `${mode}: "${text}"`);
  }
});

test('"home loan" goes to the loan node even though "home" is a Buy alias (keyword pass beats alias pass), in either node order', () => {
  for (const list of [nodes, reversed]) for (const [, match] of modes) assert.equal(kw(match(list, 'home loan')), 'loan');
});

test('KNOWN: a sentence with both a Buy alias and "for rent" resolves by node order, which the DB does not guarantee', () => {
  const hits = new Set();
  for (const list of [nodes, reversed]) for (const [, match] of modes) hits.add(kw(match(list, 'flat for rent')));
  assert.deepEqual([...hits].sort(), ['buy', 'rent']);
});
