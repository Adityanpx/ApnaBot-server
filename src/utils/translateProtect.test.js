// Run: node --test src/utils/translateProtect.test.js
// Placeholders, *bold*, _italic_, emojis and line breaks must survive a machine translation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { protect, restore, padTerms, isFaithful, placeholdersOf } = require('./translateProtect');

const SAMPLE = '*Hello* {{customer_name}} 👋\n_Welcome_ to {{businessName}} & co <3';

test('protect -> restore is lossless for the formatting we care about', () => {
  assert.equal(restore(protect(SAMPLE)), SAMPLE);
});

test('placeholders are fenced from translation; their underscores never read as italic', () => {
  const html = protect('Hi {{customer_name}}, your {{booking_code}} is ready');
  assert.equal(html, 'Hi <span class="notranslate">{{customer_name}}</span>, your <span class="notranslate">{{booking_code}}</span> is ready');
  assert.deepEqual(placeholdersOf('{{a}} {{b}} {{a}}'), ['{{a}}', '{{b}}', '{{a}}']);
});

test('bold / italic / line breaks become tags and come back; snake_case words are left alone', () => {
  assert.equal(protect('*bold* and _it_\nnext'), '<b>bold</b> and <i>it</i><br>next');
  assert.equal(protect('use snake_case_name here'), 'use snake_case_name here');
  assert.equal(protect('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('restore handles what Azure does to the tags: padding inside <b>, uppercase tags, entities', () => {
  assert.equal(restore('<B> नमस्ते </B> <span class="notranslate">{{name}}</span>&nbsp;&amp;'), '*नमस्ते* {{name}} &');
  assert.equal(restore('एक<br />दो<BR>तीन'), 'एक\nदो\nतीन');
});

test('a faithful translation passes', () => {
  assert.equal(isFaithful(SAMPLE, '*नमस्ते* {{customer_name}} 👋\n_स्वागत है_ {{businessName}} & co <3'), null);
});

test('a translation that lost something is rejected, with the reason', () => {
  assert.equal(isFaithful(SAMPLE, '*नमस्ते* 👋\n_स्वागत है_ {{businessName}} & co <3'), 'Placeholder mismatch.');
  assert.equal(isFaithful('Hi {{a}}', 'नमस्ते {{b}}'), 'Placeholder mismatch.');
  assert.equal(isFaithful('Hi {{a}} {{a}}', 'नमस्ते {{a}}'), 'Placeholder mismatch.');
  assert.equal(isFaithful('*Hi*', 'नमस्ते'), 'Bold formatting lost.');
  assert.equal(isFaithful('_Hi_', 'नमस्ते'), 'Italic formatting lost.');
  assert.equal(isFaithful('Line one\nLine two', 'एक दो'), 'Line breaks changed.');
  assert.equal(isFaithful('Thanks 🙏', 'धन्यवाद'), 'Emoji changed.');
  assert.equal(isFaithful('Hi', '   '), 'Empty translation.');
  assert.equal(isFaithful('Hi', null), 'Empty translation.');
});

test('protect with terms: whole-word, case-sensitive matches are shielded, round-trip stays lossless', () => {
  const terms = ['menu', 'STOP', 'START', 'WhatsApp'];
  const text = 'Send *menu* or STOP on WhatsApp. RESTART, startup and menus change; {{menu_label}} stays.';
  const html = protect(text, { terms });
  assert.match(html, /<span class="notranslate">\*menu\*<\/span> or <span class="notranslate">STOP<\/span> on <span class="notranslate">WhatsApp<\/span>\./);
  assert.ok(!html.includes('<span class="notranslate">START</span>'), 'RESTART is not START');
  assert.ok(!html.includes('<span class="notranslate">menu</span>s'), 'menus is not menu');
  assert.equal((html.match(/notranslate/g) || []).length, 4, 'three terms (one of them bold) plus the one placeholder, none wrapped twice');
  assert.ok(!html.includes('<b>'), 'a bold term is lifted out whole, never left inside <b>');
  assert.equal(restore(html), text);
});

test('protect without terms is unchanged (empty list too)', () => {
  assert.equal(protect(SAMPLE, { terms: [] }), protect(SAMPLE));
  assert.equal(protect(SAMPLE, {}), protect(SAMPLE));
});

test('padTerms: a protected term glued to a letter of another script gets a space; Latin neighbours and non-terms are left alone', () => {
  const terms = ['menu', 'STOP', 'WhatsApp'];
  assert.equal(padTerms('WhatsAppપર અને STOPજવાબ', terms), 'WhatsApp પર અને STOP જવાબ');
  assert.equal(padTerms('મોકલો*menu*', terms), 'મોકલો *menu*');
  assert.equal(padTerms('*menu* મોકલો', terms), '*menu* મોકલો');
  assert.equal(padTerms('RESTART, menus and {{menu_x}}', terms), 'RESTART, menus and {{menu_x}}');
  assert.equal(padTerms('Hello', undefined), 'Hello');
  assert.equal(padTerms('WhatsAppપર', []), 'WhatsAppપર');
});
