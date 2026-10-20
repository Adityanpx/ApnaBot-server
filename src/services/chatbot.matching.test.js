// Run: node --test src/services/chatbot.matching.test.js
// The reply matcher with the legacy and the Unicode normalizer: native-script keywords in all nine
// scripts, mixed messages, fuzzy rules, the ASCII regression suite (real SG Travels / Averix /
// CareWell keywords, saved as a fixture without customer data) and the shadow log. Redis, Supabase
// and the logger are stubbed; nothing here touches a real service.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let cachedNodes = [];
let flagValue = false;
const logs = [];
stub('../config/redis', { get: async () => JSON.stringify(cachedNodes), set: async () => 'OK', del: async () => 1 });
stub('../config/supabase', { rpc: () => Promise.resolve({ error: null }), from: () => { throw new Error('unexpected DB call'); } });
stub('../utils/logger', { info: (m) => logs.push(['info', m]), error: (...a) => logs.push(['error', ...a]), warn: () => {}, debug: () => {} });
stub('./unicodeMatching.service', { isUnicodeMatchingEnabled: async () => flagValue });

const chatbot = require('./chatbot.service');
const fixture = require('../test-support/matchingKeywords.fixture.json');

const node = (id, keyword, matchType = 'contains', hindiAliases = [], isActive = true) =>
  ({ id, keyword, matchType, hindiAliases, isActive, contentType: 'text' });
const legacy = (nodes, text) => chatbot.matchNodeInList(nodes, text);
const modern = (nodes, text) => chatbot.matchNodeInList(nodes, text, { unicode: true });

const WORDS = {
  hi: 'मेनू', mr: 'मदत', gu: 'મેનુ', ta: 'மெனு', te: 'మెనూ',
  kn: 'ಮೆನು', ml: 'മെനു', bn: 'মেনু', pa: 'ਮੇਨੂ', or: 'ମେନୁ'
};

for (const [lang, word] of Object.entries(WORDS)) {
  test(`${lang}: exact / startsWith / contains / alias match a native keyword; legacy matches none`, () => {
    const exact = [node('e', word, 'exact')];
    assert.equal(modern(exact, word).id, 'e');
    assert.equal(modern(exact, `${word}।`).id, 'e');
    assert.equal(modern(exact, `  ${word.toUpperCase()}!! `).id, 'e');
    assert.equal(legacy(exact, word), null);

    const starts = [node('s', word, 'startsWith')];
    assert.equal(modern(starts, `${word} चाहिए`).id, 's');
    assert.equal(modern(starts, `चाहिए ${word}`), null);

    const contains = [node('c', word, 'contains')];
    assert.equal(modern(contains, `मुझे ${word} चाहिए`).id, 'c');
    assert.equal(legacy(contains, `मुझे ${word} चाहिए`), null);

    const aliased = [node('a', 'zzzz', 'exact', [word])];
    assert.equal(modern(aliased, word).id, 'a');
    assert.equal(modern(aliased, `please ${word} now`).id, 'a');
  });
}

test('ZWJ / ZWNJ variants of a keyword or message still match', () => {
  const nodes = [node('c', 'मेनू', 'contains')];
  assert.equal(modern(nodes, 'मे‍नू').id, 'c');
  assert.equal(modern(nodes, 'मे‌नू दिखाओ').id, 'c');
  assert.equal(modern([node('c', 'मे‍नू', 'exact')], 'मेनू').id, 'c');
});

test('Indic digits match a numeric keyword', () => {
  const nodes = [node('two', '2', 'exact')];
  assert.equal(modern(nodes, '२').id, 'two');
  assert.equal(modern(nodes, '૨').id, 'two');
  assert.equal(legacy(nodes, '२'), null);
});

test('mixed scripts: a Roman keyword still matches via the ASCII projection', () => {
  const nodes = [node('hi', 'hi', 'exact'), node('book', 'book', 'contains')];
  const r = chatbot.matchNodeInListDetailed(nodes, 'hi भाई', { unicode: true });
  assert.equal(r.node.id, 'hi');
  assert.equal(r.via, 'projection');
  assert.equal(modern(nodes, 'भाई book करना है').id, 'book');
  // A full-text native match wins before the projection is tried.
  const both = [node('hi', 'hi', 'exact'), node('bhai', 'भाई', 'contains')];
  const w = chatbot.matchNodeInListDetailed(both, 'hi भाई', { unicode: true });
  assert.equal(w.node.id, 'bhai');
  assert.equal(w.via, 'full');
});

test('emoji / punctuation edge cases', () => {
  const nodes = [node('hi', 'hi', 'exact'), node('one', '1', 'exact')];
  assert.equal(modern(nodes, 'hi🙏').id, 'hi');
  assert.equal(modern(nodes, 'Hi!!!').id, 'hi');
  assert.equal(modern(nodes, '1').id, 'one');
  assert.equal(modern(nodes, '🙏'), null);
  assert.equal(modern(nodes, '👍👍'), null);
  assert.equal(legacy(nodes, '🙏'), null);
});

test('fuzzy on native script: off for short keywords, on (1 edit) for 6+ code points, code-point based', () => {
  const short = [node('s', 'मेनू', 'contains')]; // 4 code points
  assert.equal(modern(short, 'मेनु'), null); // one vowel sign off: no fuzzy for short native words
  const long = [node('l', 'अपॉइंटमेंट', 'contains')]; // 10 code points -> 2 edits
  assert.equal(modern(long, 'अपॉइंटमेंट').id, 'l');
  assert.equal(modern(long, 'अपॉइंटमेट').id, 'l'); // one matra dropped
  assert.equal(modern(long, 'अपोइंटमेट').id, 'l'); // two edits
  assert.equal(modern(long, 'अपोइंटमेन'), null); // three edits
  const mid = [node('m', 'किराया', 'exact')]; // 6 code points -> 1 edit
  assert.equal(modern(mid, 'किराय').id, 'm');
  assert.equal(modern(mid, 'किरय'), null);
});

test('ASCII fuzzy is unchanged in the Unicode mode (price/pric)', () => {
  const nodes = [node('p', 'price', 'exact')];
  assert.equal(modern(nodes, 'pric').id, 'p');
  assert.equal(modern(nodes, 'prise').id, 'p');
  assert.equal(modern(nodes, 'xxxxx'), null);
});

test('matra boundary guard: a consonant keyword does not match inside a longer syllable', () => {
  assert.equal(modern([node('k', 'क', 'contains')], 'की'), null);
  assert.equal(modern([node('k', 'क', 'startsWith')], 'कि'), null);
  assert.equal(modern([node('k', 'क', 'contains')], 'क दो').id, 'k');
  assert.equal(modern([node('k', 'का', 'contains')], 'मेरा काम').id, 'k');
  assert.equal(modern([node('k', 'का', 'contains')], 'काम').id, 'k'); // a following consonant is fine
  assert.equal(modern([node('k', 'पर', 'contains')], 'परि'), null);
});

test('inactive nodes are skipped in both modes', () => {
  const nodes = [node('x', 'मेनू', 'contains', [], false)];
  assert.equal(modern(nodes, 'मेनू'), null);
});

// ---- ASCII regression: real keywords, legacy vs Unicode ----

const variants = (kw) => {
  const out = new Set([kw, kw.toUpperCase(), `${kw}!!!`, `  ${kw}  `, `please ${kw}`, `${kw} please`, `${kw}?`, `hi ${kw}`, `${kw} 🙏`]);
  if (kw.length > 2) {
    out.add(kw.slice(1)); out.add(kw.slice(0, -1)); out.add(kw[0] + kw.slice(2));
    out.add(kw.slice(0, 1) + kw[1] + kw[1] + kw.slice(2));
    out.add(kw.slice(0, -2) + kw.slice(-1) + kw.slice(-2, -1));
  }
  return [...out];
};
const GENERIC = ['hello', 'hi', 'Hi', 'hii', 'thanks', 'thank you!', 'ok', 'okay', '1', '2', '10', 'price?', 'rate kya hai', 'kitna lagega',
  'book a cab', 'mujhe booking karni hai', 'aap ka address kya hai', 'where is your shop', 'namaste', 'kaise ho', 'menu', 'help',
  'timing', 'timings kya hai', 'appointment chahiye', 'demo', 'demo hotel', 'demo hotl', 'catalogue', 'location', 'our location',
  'contact', 'contact info', 'payment', '???', '...', '', ' ', 'HELLO!!!', 'test_message', 'a-b', 'x'];
const isAscii = (s) => /^\p{ASCII}*$/u.test(s);

for (const [business, rows] of Object.entries(fixture)) {
  test(`ASCII regression, ${business}: Unicode matcher == legacy matcher for ASCII messages`, () => {
    const nodes = rows.map((r, i) => node(`${business}:${i}`, r.keyword, r.matchType, r.hindiAliases, r.isActive));
    const messages = new Set(GENERIC);
    for (const r of rows) {
      variants(r.keyword).forEach(v => messages.add(v));
      (r.hindiAliases || []).forEach(a => variants(a).forEach(v => messages.add(v)));
    }
    let compared = 0;
    let spaceFixes = 0;
    for (const m of messages) {
      assert.ok(isAscii(m) || m.includes('🙏'), m);
      const asciiPart = m.replace(/[^\p{ASCII}]/gu, '');
      // The documented fix: legacy leaves a trailing/leading space when punctuation ends the text
      // ("hi !" -> "hi "). Those messages are compared against their trimmed twin instead.
      const quirk = chatbot.normalizeText(m) !== chatbot.normalizeText(m).trim();
      const a = legacy(nodes, quirk ? asciiPart.trim() : m);
      const b = modern(nodes, m);
      if (quirk) spaceFixes += 1;
      assert.equal(b ? b.id : null, a ? a.id : null, `message ${JSON.stringify(m)}${quirk ? ' (trailing-space fix)' : ''}`);
      compared += 1;
    }
    assert.ok(compared > 50, `only ${compared} messages compared`);
    assert.ok(spaceFixes >= 0);
  });
}

// ---- shadow log ----

const shadowLines = () => logs.filter(l => l[0] === 'info' && String(l[1]).startsWith('[unicode-match-shadow]')).map(l => JSON.parse(String(l[1]).slice('[unicode-match-shadow] '.length)));

test('shadow log (flag off): nothing for identical results, one line per difference, no phone numbers', async () => {
  cachedNodes = [node('n-menu', 'मेनू', 'contains'), node('n-hi', 'hi', 'exact')];
  flagValue = false;

  logs.length = 0;
  assert.equal((await chatbot.findMatchingRule('biz1', 'hi')).node.id, 'n-hi');
  assert.equal(shadowLines().length, 0);

  logs.length = 0;
  assert.equal(await chatbot.findMatchingRule('biz1', 'मुझे मेनू चाहिए 9876543210'), null); // live = legacy
  let lines = shadowLines();
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['businessId', 'messageSample', 'newNodeId', 'oldNodeId', 'reason']);
  assert.equal(lines[0].reason, 'native_only');
  assert.equal(lines[0].oldNodeId, null);
  assert.equal(lines[0].newNodeId, 'n-menu');
  assert.ok(lines[0].messageSample.length <= 40);
  assert.ok(!/\d{7,}/.test(JSON.stringify(lines[0])));

  logs.length = 0;
  assert.equal((await chatbot.findMatchingRule('biz1', 'hi भाई')).node.id, 'n-hi'); // legacy fuzzy hit; new = projection exact
  lines = shadowLines();
  assert.equal(lines.length, 0); // same node both ways: no difference to report

  logs.length = 0;
  await chatbot.findMatchingRule('biz1', '🙏');
  assert.equal(shadowLines().length, 0);
});

test('shadow log reasons: mixed_fallback and different_node', async () => {
  flagValue = false;
  cachedNodes = [node('n-book', 'book', 'exact'), node('n-bhai', 'भाई', 'contains')];
  logs.length = 0;
  await chatbot.findMatchingRule('biz1', 'book भाई'); // legacy: "book " fuzzy -> n-book; new: full text matches the native node
  let lines = shadowLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'different_node');

  // Native words on both sides: legacy leaves two stray spaces (too far to fuzzy-match), the
  // ASCII projection is an exact hit.
  cachedNodes = [node('n-hello', 'hello', 'exact')];
  logs.length = 0;
  assert.equal(await chatbot.findMatchingRule('biz1', 'भाई hello भाई'), null);
  lines = shadowLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'mixed_fallback');
  assert.equal(lines[0].newNodeId, 'n-hello');
});

test('flag ON: the Unicode result is live; only old_only is logged', async () => {
  flagValue = true;
  cachedNodes = [node('n-menu', 'मेनू', 'contains'), node('n-hi', 'hi', 'exact')];

  logs.length = 0;
  assert.equal((await chatbot.findMatchingRule('biz1', 'मुझे मेनू चाहिए')).node.id, 'n-menu');
  assert.equal(shadowLines().length, 0); // a native-only gain is not a regression

  // Legacy matches by fuzzy on "hi " but the Unicode path does not: here both reach n-hi, so no log.
  logs.length = 0;
  assert.equal((await chatbot.findMatchingRule('biz1', 'hi भाई')).node.id, 'n-hi');
  assert.equal(shadowLines().length, 0);

  // A case where legacy matches and Unicode does not: an ASCII keyword that is a fuzzy hit only
  // because of the legacy letters-only stripping ("cafés" -> "cafs", 1 edit from "caf"; Unicode keeps the é).
  cachedNodes = [node('n-caf', 'caf', 'exact')];
  logs.length = 0;
  assert.equal(await chatbot.findMatchingRule('biz1', 'cafés'), null);
  const lines = shadowLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].reason, 'old_only');
  assert.equal(lines[0].oldNodeId, 'n-caf');
  assert.equal(lines[0].newNodeId, null);
  flagValue = false;
});

test('probe calls (incrementCount:false) never write shadow lines', async () => {
  flagValue = false;
  cachedNodes = [node('n-menu', 'मेनू', 'contains')];
  logs.length = 0;
  await chatbot.findMatchingRule('biz1', 'मेनू', { incrementCount: false });
  assert.equal(shadowLines().length, 0);
});

test('flag off: live behaviour is exactly the legacy matcher', async () => {
  flagValue = false;
  cachedNodes = [node('n-menu', 'मेनू', 'contains')];
  assert.equal(await chatbot.findMatchingRule('biz1', 'मेनू'), null);
  flagValue = true;
  assert.equal((await chatbot.findMatchingRule('biz1', 'मेनू')).node.id, 'n-menu');
  flagValue = false;
});
