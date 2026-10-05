// Run: node --test src/utils/templateSendSupport.test.js
// computeSendSupport on stored message_templates rows (the shape it is run on
// at send time). The Meta-listing wrapper is covered in templateSync.service.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeSendSupport } = require('./templateSendSupport');
const { effectiveSendSupport, isTemplateUsable } = require('./templateStatus');

const BODY = { type: 'BODY', text: 'Hi {{1}}' };
const row = (components, over = {}) => ({ meta_components: components, header_type: 'NONE', body_text: 'Hi {{1}}', ...over });
const buttons = (...list) => ({ type: 'BUTTONS', buttons: list });

test('buttons: URL (static or one variable) and PHONE_NUMBER are sendable', () => {
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'URL', text: 'Pay', url: 'https://pay.example.com' })])), 'ok');
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'URL', text: 'Pay', url: 'https://pay.example.com/{{1}}' })])), 'ok');
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' })])), 'ok');
  assert.equal(computeSendSupport(row([BODY, buttons(
    { type: 'URL', text: 'Pay', url: 'https://p.example.com/{{1}}' }, { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' })])), 'ok');
});

test('buttons: COPY_CODE, FLOW, CATALOG, OTP and anything else stay unsupported_component', () => {
  for (const type of ['COPY_CODE', 'FLOW', 'CATALOG', 'OTP', 'MPM', 'SPM', 'VOICE_CALL', 'SOMETHING_NEW']) {
    assert.equal(computeSendSupport(row([BODY, buttons({ type, text: 'x' })])), 'unsupported_component', type);
  }
  // one unsupported button spoils a mixed set
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'URL', text: 'Pay', url: 'https://x.com' }, { type: 'COPY_CODE', text: 'Yes' })])), 'unsupported_component');
});

test('buttons: QUICK_REPLY is sendable, alone or with URL / phone buttons', () => {
  const quick = { type: 'QUICK_REPLY', text: 'Yes' };
  assert.equal(computeSendSupport(row([BODY, buttons(quick)])), 'ok');
  assert.equal(computeSendSupport(row([BODY, buttons(quick, { type: 'URL', text: 'Pay', url: 'https://x.com' })])), 'ok');
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' }, quick, { type: 'QUICK_REPLY', text: 'No' })])), 'ok');
});

test('buttons: a URL with several variables, or no url at all, is unsupported_component', () => {
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'URL', text: 'x', url: 'https://x.com/{{1}}/{{2}}' })])), 'unsupported_component');
  assert.equal(computeSendSupport(row([BODY, buttons({ type: 'URL', text: 'x' })])), 'unsupported_component');
});

test('TEXT header: no variable or one positional variable is ok; two, or a named one, are not', () => {
  const h = (text) => row([{ type: 'HEADER', format: 'TEXT', text }, BODY], { header_type: 'TEXT' });
  assert.equal(computeSendSupport(h('Sale')), 'ok');
  assert.equal(computeSendSupport(h('Hi {{1}}')), 'ok');
  assert.equal(computeSendSupport(h('{{1}} {{2}}')), 'unsupported_component');
  assert.equal(computeSendSupport(h('Hi {{name}}')), 'unsupported_component');
});

test('media headers need media of the right type', () => {
  const h = (format, over) => row([{ type: 'HEADER', format }, BODY], { header_type: format, ...over });
  assert.equal(computeSendSupport(h('IMAGE')), 'needs_header_media');
  assert.equal(computeSendSupport(h('IMAGE', { header_media_url: 'https://r2/a.png' })), 'ok');
  assert.equal(computeSendSupport(h('IMAGE', { header_image_url: 'https://r2/a.jpeg' })), 'ok'); // legacy fallback
  assert.equal(computeSendSupport(h('IMAGE', { header_media_url: 'https://r2/a.webp' })), 'needs_header_media');
  assert.equal(computeSendSupport(h('VIDEO', { header_media_url: 'https://r2/a.mp4' })), 'ok');
  assert.equal(computeSendSupport(h('VIDEO', { header_image_url: 'https://r2/a.jpeg' })), 'needs_header_media'); // no cross-type fallback
  assert.equal(computeSendSupport(h('VIDEO', { header_media_url: 'https://r2/a.pdf' })), 'needs_header_media');
  assert.equal(computeSendSupport(h('DOCUMENT', { header_media_url: 'https://r2/a.pdf' })), 'ok');
  assert.equal(computeSendSupport(h('DOCUMENT')), 'needs_header_media');
  assert.equal(computeSendSupport(h('LOCATION')), 'unsupported_component');
});

test('an app-created template (no meta_components) is judged from header_type and body_text', () => {
  assert.equal(computeSendSupport({ header_type: 'NONE', body_text: 'Hi {{1}}' }), 'ok');
  assert.equal(computeSendSupport({ header_type: 'IMAGE', body_text: 'Hi', header_image_url: 'https://r2/x.jpeg' }), 'ok');
  assert.equal(computeSendSupport({ header_type: 'IMAGE', body_text: 'Hi', header_image_url: null }), 'needs_header_media');
});

test('effectiveSendSupport: a stale stored ok no longer sends once the row stopped being sendable', () => {
  const stale = { status: 'approved', send_support: 'ok', header_type: 'IMAGE', body_text: 'Hi', header_image_url: null, header_media_url: null };
  assert.equal(effectiveSendSupport(stale), 'needs_header_media');
  assert.equal(isTemplateUsable(stale), false);
  // and the stored value still blocks on its own
  assert.equal(effectiveSendSupport({ send_support: 'unsupported_component', header_type: 'NONE', body_text: 'Hi' }), 'unsupported_component');
  // copy-code button added in WhatsApp Manager and synced into meta_components, column not yet rewritten
  assert.equal(isTemplateUsable({ status: 'approved', send_support: 'ok', meta_components: [BODY, buttons({ type: 'COPY_CODE', text: 'Yes' })], body_text: 'Hi' }), false);
});
