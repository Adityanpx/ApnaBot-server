// Run: node --test src/utils/templateComponents.quickReply.test.js
// #6 Phase 4b: quick-reply buttons are sent with the "tpl:<templateId>:<index>"
// payload inbound button routing decodes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplateComponents, buildQuickReplyComponents } = require('./templateComponents');
const { parseTapPayload } = require('./templateButtonTap');

const ID = '0b3f6c1e-1111-4222-8333-944455556666';
const quick = (text) => ({ type: 'QUICK_REPLY', text });
const tpl = (...buttons) => ({ id: ID, header_type: 'NONE', meta_components: [{ type: 'BODY', text: 'Hi {{1}}' }, { type: 'BUTTONS', buttons }] });
const qr = (index) => ({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: `tpl:${ID}:${index}` }] });

test('one quick_reply component per quick-reply button, payload tpl:<id>:<index>', () => {
  const out = buildTemplateComponents(tpl(quick('Yes'), quick('No')), { body: ['Asha'] });
  assert.deepEqual(out, [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }, qr(0), qr(1)]);
  assert.deepEqual(parseTapPayload(out[1].parameters[0].payload), { templateId: ID, index: 0 });
});

test('the index is the position among ALL buttons, and URL / quick-reply components merge in index order', () => {
  const t = tpl({ type: 'URL', text: 'Track', url: 'https://x.example.com/{{1}}' }, quick('Yes'), quick('No'));
  const out = buildTemplateComponents(t, { body: ['A'], buttons: { 0: 'SG-1' } });
  assert.deepEqual(out.slice(1), [
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'SG-1' }] },
    qr(1),
    qr(2)
  ]);
  const quickFirst = tpl(quick('Yes'), { type: 'URL', text: 'Track', url: 'https://x.example.com/{{1}}' });
  assert.deepEqual(buildTemplateComponents(quickFirst, { body: ['A'], buttons: { 1: 'SG-1' } }).slice(1).map(c => c.index), ['0', '1']);
});

test('no quick replies, or no template id: nothing added (existing output unchanged)', () => {
  assert.deepEqual(buildQuickReplyComponents(tpl({ type: 'URL', text: 'Site', url: 'https://x.example.com' })), []);
  assert.deepEqual(buildQuickReplyComponents({ ...tpl(quick('Yes')), id: undefined }), []);
  assert.deepEqual(buildQuickReplyComponents(null), []);
  assert.deepEqual(buildTemplateComponents({ header_type: 'NONE' }, { body: ['x'] }), [{ type: 'body', parameters: [{ type: 'text', text: 'x' }] }]);
});

test('quickReplies given by the caller replace the derived ones (the broadcast worker has no template row)', () => {
  const out = buildTemplateComponents({ header_type: 'NONE' }, { body: ['x'], quickReplies: [qr(1), qr(0)] });
  assert.deepEqual(out.slice(1), [qr(0), qr(1)]);
  assert.deepEqual(buildTemplateComponents(tpl(quick('Yes')), { quickReplies: [] }), []);
});
