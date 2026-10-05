// Run: node --test src/utils/templateButtonTap.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTapPayload, parseTapPayload, isOptOutText, isValidAction, decideTap } = require('./templateButtonTap');

const TPL = '0b3f6c1e-1111-4222-8333-944455556666';
const tpl = (actions) => ({ id: TPL, button_actions: actions });

test('payload round-trips and stays short', () => {
  const p = buildTapPayload(TPL, 2);
  assert.equal(p, `tpl:${TPL}:2`);
  assert.ok(p.length < 50);
  assert.deepEqual(parseTapPayload(p), { templateId: TPL, index: 2 });
});

test('parseTapPayload: only our shape', () => {
  for (const bad of [null, undefined, '', 'Yes', 'tpl:', `tpl:${TPL}`, `tpl:${TPL}:x`, `tpl:nope:1`, `xtpl:${TPL}:1`, 5]) {
    assert.equal(parseTapPayload(bad), null, String(bad));
  }
});

test('isOptOutText: STOP words, Meta labels, case / spacing / trailing punctuation', () => {
  for (const t of ['stop', 'STOP', ' Stop. ', 'Unsubscribe', 'Stop promotions', 'stop  promotion', 'Opt out!']) assert.equal(isOptOutText(t), true, t);
  for (const t of ['Yes', 'Stop by tomorrow', 'stopping', '', null, undefined]) assert.equal(isOptOutText(t), false, String(t));
});

test('isValidAction', () => {
  assert.equal(isValidAction({ type: 'keyword', keyword: 'price' }), true);
  assert.equal(isValidAction({ type: 'keyword', keyword: '  ' }), false);
  assert.equal(isValidAction({ type: 'keyword', keyword: 'x'.repeat(101) }), false);
  assert.equal(isValidAction({ type: 'node', nodeId: 'abc' }), true);
  assert.equal(isValidAction({ type: 'node' }), false);
  assert.equal(isValidAction({ type: 'menu' }), true);
  assert.equal(isValidAction({ type: 'optout' }), true);
  assert.equal(isValidAction({ type: 'delete_everything' }), false);
  assert.equal(isValidAction(null), false);
});

test('decideTap: stored action wins (index AND text match)', () => {
  const template = tpl([{ index: 1, text: 'Prices', action: { type: 'keyword', keyword: 'price' } }]);
  assert.deepEqual(decideTap({ button: { payload: buildTapPayload(TPL, 1), text: 'Prices' }, template }),
    { kind: 'action', action: { type: 'keyword', keyword: 'price' } });
  assert.deepEqual(decideTap({ button: { payload: buildTapPayload(TPL, 1), text: ' Prices ' }, template }),
    { kind: 'action', action: { type: 'keyword', keyword: 'price' } });
});

test('decideTap: optout action', () => {
  const template = tpl([{ index: 0, text: 'No thanks', action: { type: 'optout' } }]);
  assert.deepEqual(decideTap({ button: { payload: buildTapPayload(TPL, 0), text: 'No thanks' }, template }), { kind: 'optout' });
});

test('decideTap: text changed at that index (Meta edited it) -> action ignored, falls back to the text', () => {
  const template = tpl([{ index: 0, text: 'Prices', action: { type: 'keyword', keyword: 'price' } }]);
  assert.deepEqual(decideTap({ button: { payload: buildTapPayload(TPL, 0), text: 'Rates' }, template }), { kind: 'text', text: 'Rates' });
});

test('decideTap: wrong index, no actions, malformed action -> text', () => {
  const button = { payload: buildTapPayload(TPL, 2), text: 'Yes' };
  assert.deepEqual(decideTap({ button, template: tpl([{ index: 0, text: 'Yes', action: { type: 'menu' } }]) }), { kind: 'text', text: 'Yes' });
  assert.deepEqual(decideTap({ button, template: tpl(null) }), { kind: 'text', text: 'Yes' });
  assert.deepEqual(decideTap({ button, template: null }), { kind: 'text', text: 'Yes' });
  assert.deepEqual(decideTap({ button, template: tpl([{ index: 2, text: 'Yes', action: { type: 'node' } }]) }), { kind: 'text', text: 'Yes' });
});

test('decideTap: our payload with an opt-out label and no action still opts out', () => {
  assert.deepEqual(decideTap({ button: { payload: buildTapPayload(TPL, 0), text: 'Stop promotions' }, template: null }), { kind: 'optout' });
});

test('decideTap: foreign payload = Meta default (the text); opt-out by payload or text', () => {
  assert.deepEqual(decideTap({ button: { payload: 'Yes please', text: 'Yes please' } }), { kind: 'text', text: 'Yes please' });
  assert.deepEqual(decideTap({ button: { payload: 'Stop promotions', text: 'Stop promotions' } }), { kind: 'optout' });
  assert.deepEqual(decideTap({ button: { payload: 'STOP', text: 'Never mind' } }), { kind: 'optout' });
  assert.deepEqual(decideTap({ button: { payload: 'whatever', text: 'Unsubscribe' } }), { kind: 'optout' });
  assert.deepEqual(decideTap({ button: { payload: 'only-payload' } }), { kind: 'text', text: 'only-payload' });
});

test('decideTap: nothing to act on -> null', () => {
  assert.equal(decideTap({ button: {} }), null);
  assert.equal(decideTap({ button: undefined }), null);
  assert.equal(decideTap({ button: { payload: buildTapPayload(TPL, 0) } }), null);
});
