// Run: node --test src/utils/templateBuild.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComponentsFromInput, componentsForSubmit, buildMetaCreatePayload } = require('./templateBuild');
const { validateComponents } = require('./templateValidation');
const { computeSendSupport } = require('./templateSendSupport');

test('input -> stored components: text header with sample, body samples, footer, URL + phone buttons', () => {
  const { components, errors } = buildComponentsFromInput({
    header: { type: 'TEXT', text: 'Order {{1}}', textSample: 'SG1' },
    bodyText: 'Hi {{1}}, thanks.',
    variableSamples: ['Sam'],
    footerText: 'SG Travels',
    buttons: [
      { type: 'URL', text: 'Track', url: 'https://sg.example/t/{{1}}', dynamic: true, example: 'https://sg.example/t/SG1' },
      { type: 'URL', text: 'Site', url: 'https://sg.example' },
      { type: 'PHONE_NUMBER', text: 'Call', phone: '+919876543210' }
    ]
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(components, [
    { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['SG1'] } },
    { type: 'BODY', text: 'Hi {{1}}, thanks.', example: { body_text: [['Sam']] } },
    { type: 'FOOTER', text: 'SG Travels' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Track', url: 'https://sg.example/t/{{1}}', example: ['https://sg.example/t/SG1'] },
        { type: 'URL', text: 'Site', url: 'https://sg.example' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+919876543210' }
      ]
    }
  ]);
  assert.deepEqual(validateComponents(components, { requireExamples: true }), []);
});

test('input: media headers store just the format; NONE and no header store none', () => {
  for (const type of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
    const { components } = buildComponentsFromInput({ header: { type, mediaId: 'm1' }, bodyText: 'Hi.' });
    assert.deepEqual(components[0], { type: 'HEADER', format: type });
  }
  assert.equal(buildComponentsFromInput({ header: { type: 'NONE' }, bodyText: 'Hi.' }).components.length, 1);
  assert.equal(buildComponentsFromInput({ bodyText: 'Hi.' }).components.length, 1);
  assert.equal(buildComponentsFromInput({ bodyText: 'Hi.', footerText: '', buttons: [] }).components.length, 1);
});

test('input: samples for a body without variables are dropped (Meta rejects an example there)', () => {
  const { components } = buildComponentsFromInput({ bodyText: 'Hi.', variableSamples: ['x'] });
  assert.equal(components[0].example, undefined);
});

test('input shape errors: unknown button, dynamic without {{1}}, variable without dynamic, bad header type', () => {
  const run = (buttons) => buildComponentsFromInput({ bodyText: 'Hi.', buttons }).errors;
  assert.match(run([{ type: 'COPY_CODE', text: 'x' }])[0], /URL, PHONE_NUMBER or QUICK_REPLY/);
  assert.match(run([null])[0], /URL, PHONE_NUMBER or QUICK_REPLY/);
  assert.match(run([{ type: 'URL', text: 'x', url: 'https://a.example', dynamic: true }])[0], /must end with \{\{1\}\}/);
  assert.match(run([{ type: 'URL', text: 'x', url: 'https://a.example/{{1}}' }])[0], /set dynamic: true/);
  assert.match(buildComponentsFromInput({ header: { type: 'AUDIO' }, bodyText: 'Hi.' }).errors[0], /header.type must be/);
  assert.match(buildComponentsFromInput({ bodyText: 'Hi.', buttons: 'x' }).errors[0], /must be a list/);
});

test('created components make a template sendable: media attached = ok, none = needs_header_media', () => {
  const { components } = buildComponentsFromInput({
    header: { type: 'IMAGE', mediaId: 'm1' }, bodyText: 'Hi {{1}}.', variableSamples: ['a'],
    buttons: [{ type: 'URL', text: 'Go', url: 'https://a.example/{{1}}', dynamic: true, example: 'https://a.example/x' }, { type: 'PHONE_NUMBER', text: 'Call', phone: '+911234567890' }]
  });
  const row = { meta_components: components, header_type: 'IMAGE' };
  assert.equal(computeSendSupport(row), 'needs_header_media');
  assert.equal(computeSendSupport({ ...row, header_media_url: 'https://r2.example/a.jpeg' }), 'ok');
});

const base = { name: 'n', category: 'UTILITY', language: 'hi' };

test('Meta payload: IMAGE / VIDEO / DOCUMENT headers carry header_handle; order is header, body, footer, buttons', () => {
  for (const format of ['IMAGE', 'VIDEO', 'DOCUMENT']) {
    const row = {
      ...base,
      meta_components: [
        { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' }] },
        { type: 'FOOTER', text: 'Foot' },
        { type: 'BODY', text: 'Hi {{1}}.', example: { body_text: [['Sam']] } },
        { type: 'HEADER', format }
      ]
    };
    const payload = buildMetaCreatePayload(row, { headerHandle: 'H1' });
    assert.deepEqual(payload.components.map((c) => c.type), ['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
    assert.deepEqual(payload.components[0], { type: 'HEADER', format, example: { header_handle: ['H1'] } });
    assert.equal(payload.language, 'hi');
    assert.throws(() => buildMetaCreatePayload(row), /header_handle/);
  }
});

test('Meta payload: TEXT header example, URL button examples, phone button', () => {
  const row = {
    ...base,
    meta_components: [
      { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['SG1'] } },
      { type: 'BODY', text: 'Hi.' },
      { type: 'BUTTONS', buttons: [
        { type: 'URL', text: 'Track', url: 'https://sg.example/t/{{1}}', example: ['https://sg.example/t/SG1'] },
        { type: 'URL', text: 'Site', url: 'https://sg.example' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' }
      ] }
    ]
  };
  const { components } = buildMetaCreatePayload(row);
  assert.deepEqual(components[0], { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}', example: { header_text: ['SG1'] } });
  assert.deepEqual(components[2].buttons, row.meta_components[2].buttons);
});

test('Meta payload: only known fields go out (a synced row carries extras Meta must not get back)', () => {
  const row = {
    ...base,
    meta_components: [
      { type: 'BODY', text: 'Hi.', parameter_format: 'POSITIONAL' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://a.example', id: 'x' }] }
    ]
  };
  const { components } = buildMetaCreatePayload(row);
  assert.deepEqual(components, [
    { type: 'BODY', text: 'Hi.' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://a.example' }] }
  ]);
});

test('legacy rows (no meta_components): body from body_text + variable_samples, IMAGE header from header_type', () => {
  const body = { ...base, body_text: 'Hi {{1}}.', variable_samples: ['Sam'], header_type: 'NONE', meta_components: null };
  assert.deepEqual(buildMetaCreatePayload(body).components, [{ type: 'BODY', text: 'Hi {{1}}.', example: { body_text: [['Sam']] } }]);
  const image = { ...body, header_type: 'IMAGE' };
  assert.deepEqual(componentsForSubmit(image).map((c) => c.type), ['HEADER', 'BODY']);
  assert.equal(buildMetaCreatePayload(image, { headerHandle: 'H' }).components[0].example.header_handle[0], 'H');
});
