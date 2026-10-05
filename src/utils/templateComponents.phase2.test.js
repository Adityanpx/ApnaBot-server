// Run: node --test src/utils/templateComponents.phase2.test.js
// #6 Phase 2 (Step B): media headers, a TEXT header variable, URL / phone buttons.
// The byte-for-byte equality with the pre-refactor senders is templateComponents.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplateComponents, headerMediaOf } = require('./templateComponents');

test('IMAGE header: header_media_url wins over the legacy header_image_url', () => {
  const tpl = { header_type: 'IMAGE', header_media_url: 'https://r2/new.png', header_image_url: 'https://r2/old.jpeg' };
  assert.deepEqual(buildTemplateComponents(tpl, {}), [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://r2/new.png' } }] }]);
  assert.deepEqual(buildTemplateComponents({ ...tpl, header_media_url: null }, {}),
    [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://r2/old.jpeg' } }] }]);
});

test('VIDEO header', () => {
  const tpl = { header_type: 'VIDEO', header_media_url: 'https://r2/clip.mp4' };
  assert.deepEqual(buildTemplateComponents(tpl, { body: ['x'] }), [
    { type: 'header', parameters: [{ type: 'video', video: { link: 'https://r2/clip.mp4' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'x' }] }
  ]);
});

test('DOCUMENT header carries the filename (when there is one)', () => {
  const tpl = { header_type: 'DOCUMENT', header_media_url: 'https://r2/a.pdf', header_media_filename: 'Fee structure.pdf' };
  assert.deepEqual(buildTemplateComponents(tpl, {}),
    [{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://r2/a.pdf', filename: 'Fee structure.pdf' } }] }]);
  assert.deepEqual(buildTemplateComponents({ ...tpl, header_media_filename: null }, {}),
    [{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://r2/a.pdf' } }] }]);
});

test('a VIDEO / DOCUMENT header never falls back to header_image_url', () => {
  const out = buildTemplateComponents({ header_type: 'VIDEO', header_image_url: 'https://r2/img.jpeg' }, {});
  assert.equal(out[0].parameters[0].video.link, null);
});

test('media override replaces the stored link and filename', () => {
  const tpl = { header_type: 'DOCUMENT', header_media_url: 'https://r2/a.pdf', header_media_filename: 'a.pdf' };
  assert.deepEqual(buildTemplateComponents(tpl, {}, { link: 'https://r2/b.pdf', filename: 'b.pdf' })[0].parameters[0].document,
    { link: 'https://r2/b.pdf', filename: 'b.pdf' });
});

test('TEXT header with one variable gives a header text parameter; none given gives no header component', () => {
  const tpl = { header_type: 'TEXT' };
  assert.deepEqual(buildTemplateComponents(tpl, { header: ['Ravi'], body: ['x'] }), [
    { type: 'header', parameters: [{ type: 'text', text: 'Ravi' }] },
    { type: 'body', parameters: [{ type: 'text', text: 'x' }] }
  ]);
  assert.deepEqual(buildTemplateComponents(tpl, { body: ['x'] }).map(c => c.type), ['body']);
  // header values are ignored for a template without a TEXT header
  assert.deepEqual(buildTemplateComponents({ header_type: 'NONE' }, { header: ['Ravi'] }), []);
});

test('dynamic URL buttons: one component per index, string index, after the body, in index order', () => {
  const out = buildTemplateComponents({ header_type: 'NONE' }, { body: ['x'], buttons: { 2: 'abc', 0: 'SG-1' } });
  assert.deepEqual(out, [
    { type: 'body', parameters: [{ type: 'text', text: 'x' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'SG-1' }] },
    { type: 'button', sub_type: 'url', index: '2', parameters: [{ type: 'text', text: 'abc' }] }
  ]);
});

test('static URL and phone buttons add nothing (no button values given)', () => {
  assert.deepEqual(buildTemplateComponents({ header_type: 'NONE' }, { body: ['x'], buttons: {} }),
    [{ type: 'body', parameters: [{ type: 'text', text: 'x' }] }]);
});

test('image header + body + URL button together: header, body, button in that order', () => {
  const tpl = { header_type: 'IMAGE', header_media_url: 'https://r2/x.jpeg' };
  assert.deepEqual(buildTemplateComponents(tpl, { body: ['a', 'b'], buttons: { 1: 'code' } }).map(c => c.type), ['header', 'body', 'button']);
});

test('headerMediaOf: what the chat record shows', () => {
  assert.deepEqual(headerMediaOf({ header_type: 'VIDEO', header_media_url: 'https://r2/v.mp4' }), { type: 'video', link: 'https://r2/v.mp4' });
  assert.deepEqual(headerMediaOf({ header_type: 'IMAGE', header_image_url: 'https://r2/i.jpeg' }), { type: 'image', link: 'https://r2/i.jpeg' });
  assert.equal(headerMediaOf({ header_type: 'TEXT' }), null);
  assert.equal(headerMediaOf({ header_type: 'NONE' }), null);
  assert.equal(headerMediaOf({ header_type: 'IMAGE' }), null);
});
