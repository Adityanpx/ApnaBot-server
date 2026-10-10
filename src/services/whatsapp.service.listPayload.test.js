// Run: node --test src/services/whatsapp.service.listPayload.test.js
// The interactive list message sendRuleListMessage builds for a reply node's list: the button that
// opens it, the rows (title + description) and how over-long text is cut at send time.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (file, exports) => {
  const p = require.resolve(file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub(path.join(__dirname, '..', 'config', 'env.js'), { GRAPH_API_VERSION: 'v99.0' });
stub(path.join(__dirname, '..', 'utils', 'crypto.js'), { decrypt: () => 'token' });
stub(path.join(__dirname, '..', 'utils', 'logger.js'), { info() {}, warn() {}, error() {} });

const axios = require('axios');
const whatsapp = require('./whatsapp.service');

let posted;
test.beforeEach(() => {
  posted = [];
  axios.post = async (url, body) => { posted.push({ url, body }); return { data: { messages: [{ id: 'wamid' }] } }; };
});

const send = (buttonLabel, options, bodyText = 'Pick one') =>
  whatsapp.sendRuleListMessage('pn1', 'enc', '9190000', bodyText, buttonLabel, options, null).then(() => posted[0].body.interactive);

test('list message: the given button label, row title and description', async () => {
  const interactive = await send('See courses', [{ nextKeyword: 'e1', label: 'Abacus', description: 'Ages 5-14' }]);
  assert.equal(interactive.type, 'list');
  assert.equal(interactive.action.button, 'See courses');
  assert.deepEqual(interactive.action.sections[0].rows, [{ id: 'e1', title: 'Abacus', description: 'Ages 5-14' }]);
});

test('list message: "Choose" when there is no button label', async () => {
  assert.equal((await send(undefined, [{ nextKeyword: 'e1', label: 'A' }])).action.button, 'Choose');
  assert.equal((await send('', [{ nextKeyword: 'e1', label: 'A' }])).action.button, 'Choose');
});

test('list message: a translated label and description are sent as given', async () => {
  const interactive = await send('कोर्स देखें', [{ nextKeyword: 'e1', label: 'अबॅकस', description: 'वय ५-१४' }]);
  assert.equal(interactive.action.button, 'कोर्स देखें');
  assert.deepEqual(interactive.action.sections[0].rows[0], { id: 'e1', title: 'अबॅकस', description: 'वय ५-१४' });
});

test('list message: a row without a description has no description key', async () => {
  const [row] = (await send('Choose', [{ nextKeyword: 'e1', label: 'A', description: null }])).action.sections[0].rows;
  assert.equal('description' in row, false);
});

test('list message: over-long values are cut to 20 / 24 / 72', async () => {
  const interactive = await send('b'.repeat(30), [{ nextKeyword: 'e1', label: 't'.repeat(40), description: 'd'.repeat(100) }]);
  assert.equal(interactive.action.button, 'b'.repeat(20));
  const [row] = interactive.action.sections[0].rows;
  assert.equal(row.title, 't'.repeat(24));
  assert.equal(row.description, 'd'.repeat(72));
});

test('list message: an emoji at the cut point is dropped whole, never split', async () => {
  const interactive = await send(
    `${'b'.repeat(19)}😀`,
    [{ nextKeyword: 'e1', label: `${'t'.repeat(23)}😀`, description: `${'d'.repeat(71)}😀` }]
  );
  const [row] = interactive.action.sections[0].rows;
  assert.equal(interactive.action.button, 'b'.repeat(19));
  assert.equal(row.title, 't'.repeat(23));
  assert.equal(row.description, 'd'.repeat(71));
  for (const text of [interactive.action.button, row.title, row.description]) {
    assert.ok(!/[\ud800-\udbff]$/.test(text), 'no dangling high surrogate');
  }
});

test('buttons message: titles are cut at 20 without splitting an emoji', async () => {
  await whatsapp.sendInteractiveButtons('pn1', 'enc', '9190000', 'Pick', [{ nextKeyword: 'e1', title: `${'t'.repeat(19)}😀` }], null);
  assert.equal(posted[0].body.interactive.action.buttons[0].reply.title, 't'.repeat(19));
});
