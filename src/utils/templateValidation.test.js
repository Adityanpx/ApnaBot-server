// Run: node --test src/utils/templateValidation.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateName, validateCategory, validateLanguage, checkBodyVariables, checkButtonUrl, validateComponents, validateHeaderMedia
} = require('./templateValidation');

const MB = 1024 * 1024;
const body = (text, samples) => ({ type: 'BODY', text, ...(samples ? { example: { body_text: [samples] } } : {}) });
const errorsOf = (components, options) => validateComponents(components, options);

test('name: lowercase snake_case only', () => {
  assert.equal(validateName('booking_confirmed_2'), null);
  assert.match(validateName('Booking'), /lowercase_snake_case/);
  assert.match(validateName('has-dash'), /lowercase_snake_case/);
  assert.match(validateName(''), /required/);
  assert.match(validateName('a'.repeat(513)), /512/);
});

test('language is en_US | hi | mr; category MARKETING | UTILITY', () => {
  for (const l of ['en_US', 'hi', 'mr']) assert.equal(validateLanguage(l), null);
  assert.match(validateLanguage('fr'), /en_US, hi, mr/);
  assert.match(validateLanguage('en'), /en_US, hi, mr/);
  assert.equal(validateCategory('UTILITY'), null);
  assert.match(validateCategory('AUTHENTICATION'), /MARKETING, UTILITY/);
});

test('body variables: sequential, not at the start / end, not adjacent', () => {
  assert.deepEqual(checkBodyVariables('Hi {{1}}, your {{2}} is ready.'), { count: 2, errors: [] });
  assert.equal(checkBodyVariables('No variables').count, 0);
  assert.match(checkBodyVariables('Hi {{1}} and {{3}}.').errors[0], /in order with no gaps/);
  assert.match(checkBodyVariables('Hi {{2}}.').errors[0], /in order/);
  assert.match(checkBodyVariables('{{1}} is ready.').errors[0], /cannot start with a variable/);
  assert.match(checkBodyVariables('Your code is {{1}}').errors[0], /cannot end with a variable/);
  assert.match(checkBodyVariables('Hi {{1}}{{2}} there.').errors[0], /next to each other/);
  assert.equal(checkBodyVariables('Hi {{1}} {{2}} there.').errors.length, 0); // separated by a space: left to Meta
  assert.equal(checkBodyVariables('Hi {{1}}, again {{1}}.').count, 1); // repeating one variable is fine
});

test('body: required, 1024 max, samples must match the variable count (when given or required)', () => {
  assert.match(errorsOf([{ type: 'BODY', text: '  ' }])[0], /bodyText is required/);
  assert.match(errorsOf([body('a'.repeat(1025))])[0], /1024/);
  assert.deepEqual(errorsOf([body('Hi {{1}}.')]), []); // draft: samples may come later
  assert.match(errorsOf([body('Hi {{1}}.')], { requireExamples: true })[0], /1 variables \(\{\{1\}\}\) - provide exactly 1 sample/);
  assert.match(errorsOf([body('Hi {{1}} {{2}}.', ['a'])])[0], /exactly 2 sample/);
  assert.match(errorsOf([body('Hi {{1}}.', [' '])])[0], /exactly 1 sample/);
  assert.deepEqual(errorsOf([body('Hi {{1}}.', ['Sam'])], { requireExamples: true }), []);
  assert.deepEqual(errorsOf([body('No vars')], { requireExamples: true }), []);
});

test('text header: 60 chars, at most one variable ({{1}}), sample required at submit', () => {
  const h = (text, example) => ({ type: 'HEADER', format: 'TEXT', text, ...(example ? { example } : {}) });
  assert.deepEqual(errorsOf([h('Order update'), body('Hi.')]), []);
  assert.match(errorsOf([h('x'.repeat(61)), body('Hi.')])[0], /60/);
  assert.match(errorsOf([h('Hi {{1}} {{2}}'), body('Hi.')])[0], /at most one variable/);
  assert.match(errorsOf([h('Hi {{2}}'), body('Hi.')])[0], /at most one variable/);
  assert.match(errorsOf([h(''), body('Hi.')])[0], /needs text/);
  assert.match(errorsOf([h('Hi {{1}}'), body('Hi.')], { requireExamples: true })[0], /header variable/);
  assert.deepEqual(errorsOf([h('Hi {{1}}', { header_text: ['Sam'] }), body('Hi.')], { requireExamples: true }), []);
});

test('footer: 60 chars, no variables', () => {
  const f = (text) => ({ type: 'FOOTER', text });
  assert.deepEqual(errorsOf([body('Hi.'), f('Reply STOP to opt out')]), []);
  assert.match(errorsOf([body('Hi.'), f('x'.repeat(61))])[0], /60/);
  assert.match(errorsOf([body('Hi.'), f('Hi {{1}}')])[0], /cannot contain variables/);
});

test('button URL: https, no shorteners, dynamic only as one trailing {{1}} with an example', () => {
  assert.equal(checkButtonUrl('https://sg.example/track'), null);
  assert.equal(checkButtonUrl('https://sg.example/track/{{1}}'), null);
  assert.match(checkButtonUrl('http://sg.example'), /https/);
  assert.match(checkButtonUrl('sg.example'), /https/);
  assert.match(checkButtonUrl('https://bit.ly/abc'), /shorteners/);
  assert.match(checkButtonUrl('https://www.tinyurl.com/abc'), /shorteners/);
  assert.match(checkButtonUrl('https://sg.example/{{1}}/x'), /very end/);
  assert.match(checkButtonUrl('https://sg.example/{{2}}'), /very end/);
  assert.match(checkButtonUrl('https://sg.example/{{1}}{{2}}'), /only one variable/);
  assert.match(checkButtonUrl('https://localhost/x'), /valid web address/);
  assert.match(checkButtonUrl(''), /required/);
});

test('buttons: limits, text length, phone format, dynamic URL example', () => {
  const url = (text, u, example) => ({ type: 'URL', text, url: u, ...(example ? { example } : {}) });
  const phone = (text, p) => ({ type: 'PHONE_NUMBER', text, phone_number: p });
  const buttons = (...b) => [body('Hi.'), { type: 'BUTTONS', buttons: b }];

  assert.deepEqual(errorsOf(buttons(url('Track', 'https://sg.example/t/{{1}}', ['https://sg.example/t/SG1']), phone('Call us', '+919876543210'))), []);
  assert.ok(errorsOf(buttons(url('a', 'https://a.example'), url('b', 'https://b.example'), phone('c', '+911234567890'), phone('d', '+911234567891'))).some((e) => /at most 3 buttons/.test(e)));
  assert.ok(errorsOf(buttons(url('a', 'https://a.example'), url('b', 'https://b.example'), url('c', 'https://c.example'))).some((e) => /at most 2 URL/.test(e)));
  assert.ok(errorsOf(buttons(phone('a', '+911234567890'), phone('b', '+911234567891'))).some((e) => /at most 1 phone/.test(e)));
  assert.match(errorsOf(buttons(url('x'.repeat(26), 'https://a.example')))[0], /at most 25/);
  assert.match(errorsOf(buttons(url('', 'https://a.example')))[0], /text is required/);
  assert.match(errorsOf(buttons(url('Same', 'https://a.example'), phone('same', '+911234567890')))[0], /different/);
  assert.match(errorsOf(buttons(phone('Call', '9876543210')))[0], /international format/);
  assert.match(errorsOf(buttons(phone('Call', '+0123456789')))[0], /international format/);
  assert.match(errorsOf(buttons(url('Track', 'https://sg.example/t/{{1}}')))[0], /needs an example/);
  assert.match(errorsOf(buttons(url('Track', 'https://sg.example/t/{{1}}', ['https://other.example/x'])))[0], /needs an example/);
  assert.match(errorsOf(buttons({ type: 'COPY_CODE', text: 'Yes' }))[0], /only URL, PHONE_NUMBER and QUICK_REPLY/);
  assert.deepEqual(errorsOf(buttons({ type: 'QUICK_REPLY', text: 'Yes' })), []);
  assert.match(errorsOf(buttons({ type: 'QUICK_REPLY', text: '' }))[0], /text is required/);
  assert.match(errorsOf(buttons({ type: 'QUICK_REPLY', text: 'x'.repeat(26) }))[0], /at most 25/);
  assert.match(errorsOf(buttons({ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'yes' }))[0], /different/);
  assert.match(errorsOf([body('Hi.'), { type: 'BUTTONS', buttons: [] }])[0], /at least one button/);
});

test('every problem is reported, not just the first', () => {
  const errors = errorsOf([body('{{1}} hi {{3}}'), { type: 'FOOTER', text: 'x {{1}}' }]);
  assert.ok(errors.length >= 3, errors.join(' | '));
});

test('header media: type, extension and size per header format', () => {
  const m = (over) => ({ media_type: 'image', r2_key: 'business-media/a.jpeg', file_size_bytes: MB, ...over });
  assert.equal(validateHeaderMedia(m(), 'IMAGE'), null);
  assert.equal(validateHeaderMedia(m({ r2_key: 'x/a.png', file_size_bytes: 5 * MB }), 'IMAGE'), null);
  assert.match(validateHeaderMedia(m({ r2_key: 'x/a.webp' }), 'IMAGE'), /JPG or PNG/);
  assert.match(validateHeaderMedia(m({ file_size_bytes: 5 * MB + 1 }), 'IMAGE'), /at most 5 MB/);
  assert.equal(validateHeaderMedia(m({ media_type: 'video', r2_key: 'x/v.mp4', file_size_bytes: 16 * MB }), 'VIDEO'), null);
  assert.match(validateHeaderMedia(m({ media_type: 'video', r2_key: 'x/v.mp4', file_size_bytes: 16 * MB + 1 }), 'VIDEO'), /at most 16 MB/);
  assert.match(validateHeaderMedia(m({ media_type: 'video', r2_key: 'x/v.webm' }), 'VIDEO'), /MP4 video/);
  assert.equal(validateHeaderMedia(m({ media_type: 'document', r2_key: 'x/f.pdf', file_size_bytes: 10 * MB }), 'DOCUMENT'), null);
  assert.match(validateHeaderMedia(m({ media_type: 'document', r2_key: 'x/f.pdf', file_size_bytes: 10 * MB + 1 }), 'DOCUMENT'), /at most 10 MB/);
  assert.match(validateHeaderMedia(m(), 'VIDEO'), /MP4 video/); // an image picked for a video header
  assert.match(validateHeaderMedia(m(), 'TEXT'), /does not have an image, video or document header/);
});
