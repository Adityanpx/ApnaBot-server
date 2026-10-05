// Run: node --test src/utils/templateButtonTap.actions.test.js
// #6 Phase 4b: quick-reply buttons at create time (buildComponentsFromInput /
// validateComponents / componentsForSubmit) and the button_actions an owner
// sets (buildButtonActions).
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAction, buildButtonActions } = require('./templateButtonTap');
const { buildComponentsFromInput, componentsForSubmit } = require('./templateBuild');
const { validateComponents } = require('./templateValidation');

const NODE = '33333333-3333-4333-8333-333333333333';
const tpl = (...buttons) => ({ meta_components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons }] });
const URL_BTN = { type: 'URL', text: 'Site', url: 'https://x.example.com' };
const quick = (text) => ({ type: 'QUICK_REPLY', text });

test('normalizeAction keeps known fields only and trims the keyword', () => {
  assert.deepEqual(normalizeAction({ type: 'keyword', keyword: ' price ', extra: 1 }), { type: 'keyword', keyword: 'price' });
  assert.deepEqual(normalizeAction({ type: 'node', nodeId: NODE, x: 1 }), { type: 'node', nodeId: NODE });
  assert.deepEqual(normalizeAction({ type: 'menu', y: 2 }), { type: 'menu' });
  assert.equal(normalizeAction({ type: 'keyword' }), null);
  assert.equal(normalizeAction('menu'), null);
});

test('buildButtonActions: index must be a quick-reply button; button text is stored', () => {
  const t = tpl(URL_BTN, quick('Prices'), quick('Stop'));
  assert.deepEqual(buildButtonActions(t, [
    { index: 2, action: { type: 'optout' } },
    { index: 1, action: { type: 'keyword', keyword: 'price' } }
  ]), { buttonActions: [
    { index: 1, text: 'Prices', action: { type: 'keyword', keyword: 'price' } },
    { index: 2, text: 'Stop', action: { type: 'optout' } }
  ] });
  assert.match(buildButtonActions(t, [{ index: 0, action: { type: 'menu' } }]).error, /not a quick-reply button/); // URL button
  assert.match(buildButtonActions(t, [{ index: 9, action: { type: 'menu' } }]).error, /not a quick-reply button/);
  assert.match(buildButtonActions(t, [{ index: '1', action: { type: 'menu' } }]).error, /not a quick-reply button/);
  assert.match(buildButtonActions(t, [{ index: 1, action: { type: 'menu' } }, { index: 1, action: { type: 'optout' } }]).error, /more than one entry/);
  assert.match(buildButtonActions(t, [{ index: 1, action: { type: 'explode' } }]).error, /Button 1: action must be/);
  assert.match(buildButtonActions(t, 'nope').error, /must be a list/);
  assert.match(buildButtonActions(tpl(), [{ index: 0, action: { type: 'menu' } }]).error, /not a quick-reply button/);
});

test('buildButtonActions: a null / missing action clears that button; [] clears all', () => {
  const t = tpl(quick('A'), quick('B'));
  assert.deepEqual(buildButtonActions(t, [{ index: 0, action: null }, { index: 1 }]), { buttonActions: [] });
  assert.deepEqual(buildButtonActions(t, []), { buttonActions: [] });
});

test('create input: QUICK_REPLY stored as { type, text }; action comes back separately, indexed by position', () => {
  const { components, errors, buttonActions } = buildComponentsFromInput({
    bodyText: 'Hi.',
    buttons: [
      { type: 'URL', text: 'Site', url: 'https://x.example.com' },
      { type: 'QUICK_REPLY', text: ' Prices ', action: { type: 'keyword', keyword: 'price' } },
      { type: 'QUICK_REPLY', text: 'Not now' }
    ]
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(components[1].buttons, [URL_BTN, quick(' Prices '), quick('Not now')]);
  assert.deepEqual(buttonActions, [{ index: 1, text: 'Prices', action: { type: 'keyword', keyword: 'price' } }]);
  assert.deepEqual(validateComponents(components), []);
});

test('create input: a malformed action is an error; no buttons -> no actions', () => {
  const { errors } = buildComponentsFromInput({ bodyText: 'Hi.', buttons: [{ type: 'QUICK_REPLY', text: 'Yes', action: { type: 'node' } }] });
  assert.match(errors[0], /Button 1: action must be/);
  assert.deepEqual(buildComponentsFromInput({ bodyText: 'Hi.' }).buttonActions, []);
});

test('validation: quick replies must be grouped before or after the URL / phone buttons', () => {
  const errorsFor = (...buttons) => validateComponents([{ type: 'BODY', text: 'Hi.' }, { type: 'BUTTONS', buttons }]);
  const phone = { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' };
  assert.deepEqual(errorsFor(quick('A'), quick('B'), URL_BTN), []);
  assert.deepEqual(errorsFor(URL_BTN, quick('A'), quick('B')), []);
  assert.deepEqual(errorsFor(phone, quick('A')), []);
  assert.deepEqual(errorsFor(quick('A'), phone), []);
  assert.match(errorsFor(quick('A'), URL_BTN, quick('B'))[0], /grouped together/);
  assert.match(errorsFor(quick('A'), phone, quick('B'))[0], /grouped together/);
  assert.match(errorsFor(quick('A'), quick('B'), quick('C'), quick('D'))[0], /at most 3 buttons/);
});

test('submit payload: a quick reply goes out as { type, text } only', () => {
  const row = { meta_components: [{ type: 'BODY', text: 'Hi.' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes', id: 'x', payload: 'y' }] }] };
  assert.deepEqual(componentsForSubmit(row)[1].buttons, [{ type: 'QUICK_REPLY', text: 'Yes' }]);
});
