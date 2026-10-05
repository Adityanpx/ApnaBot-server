// Run: node --test src/utils/templateComponents.test.js
// Step A of #6 Phase 2: the builder must produce byte-for-byte what the senders
// built inline before. The LEGACY_* functions below are verbatim copies of that
// old code (broadcast.controller.js sendBroadcast, broadcast.worker.js
// resolveRecipientComponents, windowAwareSend.service.js), kept as the oracle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTemplateComponents, buildBodyComponents } = require('./templateComponents');

// broadcast.controller.js (before)
const LEGACY_CONTROLLER = (templateRow, templateVariables) => {
  const components = templateVariables.length > 0
    ? [{ type: 'body', parameters: templateVariables.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];
  if (templateRow.header_type === 'IMAGE') {
    components.unshift({ type: 'header', parameters: [{ type: 'image', image: { link: templateRow.header_image_url } }] });
  }
  return components;
};

// windowAwareSend.service.js (before)
const LEGACY_WINDOW_AWARE = (templateParams) =>
  templateParams.length > 0 ? [{ type: 'body', parameters: templateParams.map(t => ({ type: 'text', text: t })) }] : [];

// broadcast.worker.js resolveRecipientComponents (before), after value resolution
const LEGACY_WORKER_BODY = (texts) => {
  const parameters = texts.map((text) => ({ type: 'text', text: String(text) }));
  return parameters.length > 0 ? [{ type: 'body', parameters }] : [];
};

const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

const BODY_ONLY = { header_type: 'NONE', header_image_url: null };
const NO_HEADER_FIELD = {};
const IMAGE = { header_type: 'IMAGE', header_image_url: 'https://cdn.example.com/offer.jpg' };
const IMAGE_NO_URL = { header_type: 'IMAGE', header_image_url: null };

const VARIABLE_SETS = [[], ['Ravi'], ['Ravi', '₹500', 'SG-1042'], ['a "quoted" \\ value', 'नमस्ते'], ['7', '0']];

test('controller path: body-only templates are identical to the old code', () => {
  for (const tpl of [BODY_ONLY, NO_HEADER_FIELD]) {
    for (const vars of VARIABLE_SETS) {
      same(buildTemplateComponents(tpl, { body: vars }), LEGACY_CONTROLLER(tpl, vars));
    }
  }
});

test('controller path: IMAGE header templates are identical to the old code', () => {
  for (const tpl of [IMAGE, IMAGE_NO_URL]) {
    for (const vars of VARIABLE_SETS) {
      same(buildTemplateComponents(tpl, { body: vars }), LEGACY_CONTROLLER(tpl, vars));
    }
  }
});

test('controller path: non-string stored variables are stringified like before', () => {
  same(buildTemplateComponents(IMAGE, { body: [1, 2.5] }), LEGACY_CONTROLLER(IMAGE, [1, 2.5]));
});

test('windowAwareSend path: body-only template + string params identical', () => {
  for (const vars of VARIABLE_SETS) {
    same(buildTemplateComponents(BODY_ONLY, { body: vars }), LEGACY_WINDOW_AWARE(vars));
  }
});

test('worker path: per-recipient body identical', () => {
  for (const vars of VARIABLE_SETS) same(buildBodyComponents(vars), LEGACY_WORKER_BODY(vars));
});

test('worker path: shared header + per-recipient body = what the old worker sent', () => {
  const header = buildTemplateComponents(IMAGE, { body: [] });
  const headerComponent = header.find((c) => c.type === 'header');
  const old = [LEGACY_CONTROLLER(IMAGE, []).find((c) => c.type === 'header'), ...LEGACY_WORKER_BODY(['Ravi'])];
  same([headerComponent, ...buildBodyComponents(['Ravi'])], old);
});

test('missing / empty values produce no body component', () => {
  assert.deepEqual(buildTemplateComponents(BODY_ONLY), []);
  assert.deepEqual(buildTemplateComponents(BODY_ONLY, {}), []);
  assert.deepEqual(buildBodyComponents(undefined), []);
});

test('header comes first, then body', () => {
  const out = buildTemplateComponents(IMAGE, { body: ['x'] });
  assert.deepEqual(out.map((c) => c.type), ['header', 'body']);
});
