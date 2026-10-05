// Run: node --test src/utils/followup.templates.test.js
// #6 Phase 2: follow-ups accept media-header / header-variable / URL-button
// templates, with mapping entries for the header and the dynamic URL buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('./followup');

const utility = (over = {}) => ({
  id: 't1', name: 'pay_now', status: 'approved', category: 'UTILITY', send_support: 'ok', header_type: 'NONE',
  body_text: 'Hi {{1}}, pay for {{2}}', language: 'en_US', ...over
});
const bodyMap = [{ source: 'customer.name', fallback: 'there' }, { source: 'booking.code', fallback: '' }];
const validate = (mapping, templateRow, preset = 'payment_pending') =>
  f.validateAutomation({ preset, name: 'P', templateId: 't1', templateVariableMapping: mapping }, { templateRow });

const rich = utility({
  header_type: 'TEXT',
  meta_components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
    { type: 'BODY', text: 'Hi {{1}}, pay for {{2}}' },
    { type: 'BUTTONS', buttons: [
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' },
      { type: 'URL', text: 'Pay', url: 'https://x.com/{{1}}' }
    ] }
  ]
});
const richMap = [
  ...bodyMap,
  { target: 'header', source: 'customer.name', fallback: 'there' },
  { target: 'button', buttonIndex: 1, source: 'booking.code' }
];

test('a media-header template is accepted once media is attached (no header_type filter any more)', () => {
  for (const [header_type, header_media_url] of [['IMAGE', 'https://r2/x.jpeg'], ['VIDEO', 'https://r2/x.mp4'], ['DOCUMENT', 'https://r2/x.pdf']]) {
    const r = validate(bodyMap, utility({ header_type, header_media_url }));
    assert.ok(r.value, `${header_type}: ${r.error}`);
  }
  // legacy IMAGE templates keep working from header_image_url
  assert.ok(validate(bodyMap, utility({ header_type: 'IMAGE', header_image_url: 'https://r2/x.jpeg' })).value);
  // without media they're refused with the reason
  assert.match(validate(bodyMap, utility({ header_type: 'IMAGE' })).error, /can't be sent by ApnaBot yet.*header needs an image/);
  // and with the stored flag stale-ok but the media removed since
  assert.match(validate(bodyMap, utility({ header_type: 'VIDEO', send_support: 'ok' })).error, /header needs/);
});

test('header variable + dynamic URL button entries are validated and stored (body, header, then buttons)', () => {
  // sent in a scrambled order: body entries keep their order ({{1}}, {{2}}), the rest are normalised
  const r = validate([richMap[3], richMap[0], richMap[2], richMap[1]], rich);
  assert.ok(r.value, r.error);
  assert.deepEqual(r.value.template_variable_mapping, [
    { source: 'customer.name', fallback: 'there' },
    { source: 'booking.code', fallback: '' },
    { target: 'header', source: 'customer.name', fallback: 'there' },
    { target: 'button', buttonIndex: 1, source: 'booking.code', fallback: '' }
  ]);
});

test('header / button entries are required exactly where the template has variables', () => {
  assert.match(validate(richMap.filter(e => e.target !== 'header'), rich).error, /header has a variable/);
  assert.match(validate(richMap.filter(e => e.target !== 'button'), rich).error, /URL button 1/);
  assert.match(validate(richMap.map(e => (e.target === 'button' ? { ...e, buttonIndex: 0 } : e)), rich).error, /not a URL button with a variable/);
  assert.match(validate([...richMap, { ...richMap[3] }], rich).error, /more than one/);
  assert.match(validate(bodyMap.slice(0, 1).concat(richMap.slice(2)), rich).error, /exactly 2 entries/);
  // a template with no header variable refuses a header entry
  assert.match(validate([...bodyMap, { target: 'header', source: 'static', value: 'x' }], utility()).error, /no header variable/);
  // old body-only behaviour for body-only templates is untouched
  assert.ok(validate(bodyMap, utility()).value);
  assert.match(validate(bodyMap.slice(0, 1), utility()).error, /exactly 2 entries/);
});

test('button sources: static, or booking.code for booking follow-ups only', () => {
  const withButton = (source, extra = {}) => richMap.map(e => (e.target === 'button' ? { ...e, source, ...extra } : e));
  assert.ok(validate(withButton('static', { value: 'abc' }), rich).value);
  assert.ok(validate(withButton('booking.code'), rich).value);
  assert.match(validate(withButton('customer.name'), rich).error, /button 1\)\.source must be one of: static, booking.code/);
  assert.match(validate(withButton('booking.amount'), rich).error, /source must be one of/);
  assert.match(validate(withButton('static'), rich).error, /value is required/);
  // booking.code on a non-booking follow-up (win_back) is refused, as for body entries
  const marketing = { ...rich, category: 'MARKETING' };
  const winMap = [
    { source: 'customer.name' }, { source: 'business.name' },
    { target: 'header', source: 'customer.name' }, { target: 'button', buttonIndex: 1, source: 'booking.code' }
  ];
  assert.match(validate(winMap, marketing, 'win_back').error, /only available for booking follow-ups/);
  assert.ok(validate(winMap.map(e => (e.target === 'button' ? { ...e, source: 'static', value: 'promo' } : e)), marketing, 'win_back').value);
});

test('phone and static URL buttons need no mapping entries', () => {
  const plain = utility({ body_text: 'Hi {{1}}, pay for {{2}}', meta_components: [
    { type: 'BODY', text: 'Hi {{1}}, pay for {{2}}' },
    { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' }, { type: 'URL', text: 'Site', url: 'https://x.com' }] }
  ] });
  assert.ok(validate(bodyMap, plain).value);
});

test('copy code / flow / catalog / OTP buttons stay refused (unsupported_component)', () => {
  for (const type of ['COPY_CODE', 'FLOW', 'CATALOG', 'OTP']) {
    const t = utility({ meta_components: [{ type: 'BODY', text: 'Hi {{1}}, pay for {{2}}' }, { type: 'BUTTONS', buttons: [{ type, text: 'x' }] }] });
    assert.match(validate(bodyMap, t).error, /can't be sent by ApnaBot yet — it has buttons/, type);
  }
});

test('the template filter no longer asks for a body-only template', () => {
  const byKey = Object.fromEntries(f.presetsForWeb().map(p => [p.key, p]));
  assert.equal('headerType' in byKey.win_back.templateFilter, false);
});

test('renderTemplateParams returns body values only; renderTemplateValues adds header and buttons', () => {
  const business = { name: 'SG', displayName: 'SG Travels' };
  const booking = { booking_code: 'SG-1042', payment_amount: 1500 };
  assert.deepEqual(f.renderTemplateParams(richMap, business, { name: 'Asha' }, 'en_US', booking), ['Asha', 'SG-1042']);
  assert.deepEqual(f.renderTemplateValues(richMap, business, { name: 'Asha' }, 'en_US', booking), {
    body: ['Asha', 'SG-1042'], header: ['Asha'], buttons: { 1: 'SG-1042' }
  });
  // header falls back like a body variable when the customer has no name
  assert.deepEqual(f.renderTemplateValues(richMap, business, { name: '' }, 'en_US', booking).header, ['there']);
  // body-only mapping: nothing extra
  assert.deepEqual(f.renderTemplateValues(bodyMap, business, { name: 'Asha' }, 'en_US', booking), { body: ['Asha', 'SG-1042'], header: [], buttons: {} });
  assert.deepEqual(f.renderTemplateValues(null, business, null), { body: [], header: [], buttons: {} });
});
