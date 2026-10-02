// Run: node --test src/utils/flowSpecV2.test.js
// Pure — no Supabase/Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFlowSpecV2, compileFlowSpecV2 } = require('./flowSpecV2');
const { GREETING_WORDS, DX, DY } = require('./flowSpec');
const { validateFlowFields } = require('./flowFieldsValidation');

const page = (id) => ({ type: 'page', id });
const form = (id) => ({ type: 'form', id });
const MENU = { type: 'menu' };

const baseSpec = () => ({
  version: 2,
  greeting: { text: 'Welcome!' },
  menu: [
    { title: 'Courses', target: page('courses') },
    { title: 'Fees', target: page('fees') },
    { title: 'Free demo', target: form('demo') }
  ],
  pages: [
    { id: 'courses', text: 'Our courses:', keyword: 'course', list: [
      { title: 'Abacus', description: 'Age 6+', target: page('c_abacus') },
      { title: 'Vedic Maths', target: page('c_vedic') },
      { title: 'Main menu', target: MENU }
    ] },
    { id: 'c_abacus', text: 'Abacus details', buttons: [{ title: 'Free demo', target: form('demo') }, { title: 'Main menu', target: MENU }] },
    { id: 'c_vedic', text: 'Vedic details', buttons: [{ title: 'Main menu', target: MENU }] },
    { id: 'fees', text: 'Fees are ...', keyword: 'fees', aliases: ['charges'], buttons: [{ title: 'Main menu', target: MENU }] }
  ],
  forms: [
    { id: 'demo', text: 'Tap below', buttonText: 'Fill form', keyword: 'demo', fields: [
      { name: 'studentName', label: 'Student name', type: 'text', required: true },
      { name: 'course', label: 'Course', type: 'dropdown', options: ['Abacus', 'Vedic Maths'], required: true }
    ] }
  ]
});
const mutate = (fn) => { const s = baseSpec(); fn(s); return s; };
const rejects = (name, fn, pattern) => test(`rejects: ${name}`, () => {
  const err = validateFlowSpecV2(mutate(fn));
  assert.ok(err, 'expected an error');
  assert.match(err, pattern);
  assert.throws(() => compileFlowSpecV2(mutate(fn)), /Invalid FlowSpec v2/);
});

test('happy path compiles to reply nodes only', () => {
  assert.equal(validateFlowSpecV2(baseSpec()), null);
  const out = compileFlowSpecV2(baseSpec());
  assert.equal(out.questionNodes.length, 0);
  assert.ok(out.replyNodes.every(n => n.nodeType === 'reply'));
  const byId = new Map(out.replyNodes.map(n => [n.id, n]));

  const menu = byId.get('tmp:menu');
  assert.equal(menu.keyword, 'hi');
  assert.equal(menu.matchType, 'exact');
  assert.equal(menu.contentType, 'buttons');
  assert.deepEqual([...menu.hindiAliases].sort(), GREETING_WORDS.filter(w => w !== 'hi').sort());

  assert.equal(byId.get('tmp:page:courses').contentType, 'list');
  assert.equal(byId.get('tmp:page:courses').keyword, 'course');
  assert.equal(byId.get('tmp:page:c_abacus').contentType, 'buttons');
  assert.equal(byId.get('tmp:page:c_abacus').keyword, 'page_c_abacus');
  assert.equal(byId.get('tmp:page:c_abacus').matchType, 'exact');
  assert.deepEqual(byId.get('tmp:page:fees').hindiAliases, ['charges']);

  const demo = byId.get('tmp:form:demo');
  assert.equal(demo.replyKind, 'web_form_trigger');
  assert.equal(demo.contentType, 'text');
  assert.equal(demo.buttonText, 'Fill form');
  assert.equal(validateFlowFields(demo.formFields), null);
});

test('edges: menu, list rows (with descriptions), buttons, back to menu', () => {
  const out = compileFlowSpecV2(baseSpec());
  const from = (id) => out.edges.filter(e => e.fromNodeId === id);
  assert.deepEqual(from('tmp:menu').map(e => e.toNodeId), ['tmp:page:courses', 'tmp:page:fees', 'tmp:form:demo']);
  assert.deepEqual(from('tmp:page:courses').map(e => [e.label, e.description, e.displayOrder]),
    [['Abacus', 'Age 6+', 0], ['Vedic Maths', null, 1], ['Main menu', null, 2]]);
  assert.deepEqual(from('tmp:page:c_abacus').map(e => e.toNodeId), ['tmp:form:demo', 'tmp:menu']);
  assert.ok(out.edges.every(e => e.condition === null && e.preset === null));
});

test('every edge target exists; every node reachable from the menu or typable', () => {
  const out = compileFlowSpecV2(baseSpec());
  const ids = new Set(out.replyNodes.map(n => n.id));
  assert.ok(out.edges.every(e => ids.has(e.fromNodeId) && ids.has(e.toNodeId)));
  const reached = new Set(['tmp:menu']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of out.edges) if (reached.has(e.fromNodeId) && !reached.has(e.toNodeId)) { reached.add(e.toNodeId); grew = true; }
  }
  assert.deepEqual([...ids].filter(id => !reached.has(id)), []);
});

test('layout: BFS depth columns', () => {
  const out = compileFlowSpecV2(baseSpec());
  const pos = Object.fromEntries(out.replyNodes.map(n => [n.id, [n.positionX, n.positionY]]));
  assert.deepEqual(pos['tmp:menu'], [0, 0]);
  assert.deepEqual(pos['tmp:page:courses'], [DX, 0]);
  assert.deepEqual(pos['tmp:page:fees'], [DX, DY]);
  assert.deepEqual(pos['tmp:form:demo'], [DX, 2 * DY]);
  assert.equal(pos['tmp:page:c_abacus'][0], 2 * DX);
});

test('4+ menu items become a list with descriptions', () => {
  const spec = mutate(s => {
    s.menu.push({ title: 'Contact us', description: 'Call or visit', target: page('fees') });
  });
  const out = compileFlowSpecV2(spec);
  assert.equal(out.replyNodes.find(n => n.id === 'tmp:menu').contentType, 'list');
  assert.ok(out.warnings.some(w => /WhatsApp list/.test(w)));
});

test('location: typed keyword + warning', () => {
  const spec = mutate(s => { s.location = { keyword: 'location' }; s.menu.push({ title: 'Location', target: { type: 'location' } }); });
  const out = compileFlowSpecV2(spec);
  const loc = out.replyNodes.find(n => n.contentType === 'location');
  assert.equal(loc.keyword, 'location');
  assert.equal(loc.label, '');
  assert.ok(out.warnings.some(w => /map location/.test(w)));
});

test('compile does not mutate input', () => {
  const s = baseSpec();
  const before = JSON.stringify(s);
  compileFlowSpecV2(s);
  assert.equal(JSON.stringify(s), before);
});

rejects('wrong version', s => { s.version = 1; }, /version must be 2/);
rejects('greeting over 1024', s => { s.greeting.text = 'x'.repeat(1025); }, /greeting.text must be 1024/);
rejects('more than 10 menu items', s => { for (let i = 0; i < 8; i++) s.menu.push({ title: `M${i}`, target: page('fees') }); }, /at most 10 items/);
rejects('menu button title over 20', s => { s.menu[0].title = 'x'.repeat(21); }, /20 characters or less \(button\)/);
rejects('description on a button menu', s => { s.menu[0].description = 'nope'; }, /only allowed on list rows/);
rejects('page with 4 buttons', s => { s.pages[1].buttons.push(...[1, 2].map(i => ({ title: `B${i}`, target: MENU }))); }, /at most 3 buttons/);
rejects('page with buttons and a list', s => { s.pages[0].buttons = [{ title: 'X', target: MENU }]; }, /buttons or a list, not both/);
rejects('list with 11 rows', s => { s.pages[0].list = Array.from({ length: 11 }, (_, i) => ({ title: `R${i}`, target: MENU })); }, /at most 10 rows/);
rejects('list row title over 24', s => { s.pages[0].list[0].title = 'x'.repeat(25); }, /24 characters or less \(list row\)/);
rejects('list row description over 72', s => { s.pages[0].list[0].description = 'x'.repeat(73); }, /72 characters/);
rejects('page with buttons: text over 1024', s => { s.pages[1].text = 'x'.repeat(1025); }, /text must be 1024/);
rejects('plain page text over 4096', s => { delete s.pages[1].buttons; s.pages[1].text = 'x'.repeat(4097); }, /text must be 4096/);
rejects('target to missing page', s => { s.menu[1].target = page('nope'); }, /page "nope" does not exist/);
rejects('target to missing form', s => { s.pages[1].buttons[0].target = form('nope'); }, /form "nope" does not exist/);
rejects('location target without spec.location', s => { s.menu.push({ title: 'Loc', target: { type: 'location' } }); }, /spec.location is not set/);
rejects('unreachable tap-only page', s => { s.pages.push({ id: 'orphan', text: 'x' }); }, /not linked from anywhere/);
rejects('form with no questions', s => { s.forms[0].fields = [{ name: 'n', label: 'Note', type: 'display_text' }]; }, /at least one question/);
rejects('form field invalid (dropdown with 1 option)', s => { s.forms[0].fields[1].options = ['Only']; }, /at least 2 non-empty options/);
rejects('form buttonText over 20', s => { s.forms[0].buttonText = 'x'.repeat(21); }, /buttonText must be 20/);
rejects('keyword under 4 chars', s => { s.pages[3].keyword = 'fee'; }, /at least 4 characters/);
rejects('keyword clashes with greeting', s => { s.pages[3].keyword = 'hello'; }, /greeting word "hello"/);
rejects('duplicate keyword', s => { s.pages[3].keyword = 'Course'; }, /duplicates the keyword/);
rejects('keyword collides with tap-only keyword', s => { s.forms[0].keyword = 'page_c_abacus'; }, /tap-only/);
rejects('aliases without keyword', s => { s.pages[1].aliases = ['abacus']; }, /aliases need a keyword/);
rejects('duplicate page id', s => { s.pages[2].id = 'c_abacus'; }, /duplicate/);
rejects('duplicate choice titles', s => { s.pages[1].buttons[1].title = 'free demo'; }, /duplicates another choice/);

test('page mediaId: a media id on a buttons/text page; never on a list page', () => {
  const photo = '11111111-2222-4333-8444-555555555555';
  const base = () => ({
    version: 2, greeting: { text: 'Hi' },
    menu: [{ title: 'A', target: { type: 'page', id: 'a' } }, { title: 'B', target: { type: 'page', id: 'b' } }],
    pages: [
      { id: 'a', text: 'Page A', buttons: [{ title: 'Main menu', target: { type: 'menu' } }] },
      { id: 'b', text: 'Page B', list: [{ title: 'Main menu', target: { type: 'menu' } }] }
    ],
    forms: []
  });
  const ok = base(); ok.pages[0].mediaId = photo;
  assert.equal(validateFlowSpecV2(ok), null);
  assert.equal(compileFlowSpecV2(ok).replyNodes.find(n => n.label === 'Page A').mediaId, photo);
  const onList = base(); onList.pages[1].mediaId = photo;
  assert.match(validateFlowSpecV2(onList), /a list page can't have an image/);
  const bad = base(); bad.pages[0].mediaId = 'not-an-id';
  assert.match(validateFlowSpecV2(bad), /mediaId must be a media id/);
});
