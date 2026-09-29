// Run: node --test src/utils/flowSpec.test.js
// Pure — no Supabase/Redis. Source-text drift checks read the two files the
// duplicated constants come from without requiring them (requiring either
// would open real Redis/Supabase connections).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  validateFlowSpec, compileFlowSpec, GREETING_WORDS, RESERVED_TRAVEL_FIELD_KEYS, LIMITS, DX, DY
} = require('./flowSpec');
const {
  findCycles, findUnreachableNodes, resolveBookingTriggerEntryNodeIds, canEnterBookingQuestions
} = require('./flowGraphValidation');

const clinicSpec = () => ({
  version: 1,
  greeting: { text: 'Welcome to CareWell Clinic! How can we help you today?' },
  menu: [
    { id: 'book', title: 'Book appointment', action: { type: 'booking' } },
    { id: 'timings', title: 'Clinic timings', action: { type: 'faq', faqId: 'timings' } },
    { id: 'contact', title: 'Talk to us', action: { type: 'contact' } }
  ],
  faqs: [
    { id: 'timings', answer: 'We are open Mon-Sat, 9am-7pm.', backToMenu: true },
    { id: 'fees', keyword: 'consultation fee', aliases: ['fees kitni'], answer: 'Consultation is Rs 500.' }
  ],
  booking: {
    keyword: 'appointment',
    intro: "Let's book your visit.",
    fields: [
      { key: 'patientName', label: 'Patient name?', type: 'text' },
      { key: 'visitType', label: 'Visit type?', type: 'choice', options: [
        { value: 'New', label: 'New patient' }, { value: 'Follow-up', label: 'Follow-up' }
      ] },
      { key: 'address', label: 'Share your location', type: 'location', required: false }
    ]
  },
  contact: { keyword: 'contact', text: 'Call us on 98xxxxxx or wait for our team to reply.' }
});

const mutate = (fn) => { const s = clinicSpec(); fn(s); return s; };
const rejects = (name, fn, pattern) => test(`rejects: ${name}`, () => {
  const error = validateFlowSpec(mutate(fn));
  assert.ok(error, 'expected a validation error');
  assert.match(error, pattern);
  assert.throws(() => compileFlowSpec(mutate(fn)), /Invalid FlowSpec/);
});

// Flattens the compiled payload into loadGraph's { nodes, edges } shape.
const asGraph = ({ replyNodes, questionNodes, edges }) => ({
  nodes: [...replyNodes, ...questionNodes],
  edges: edges.map((e, i) => ({ ...e, id: `e${i}` }))
});

// ---- drift guards for duplicated constants ----

test('GREETING_WORDS matches webhook.controller.js GREETING_KEYWORDS', () => {
  const src = fs.readFileSync(path.join(__dirname, '../controllers/webhook.controller.js'), 'utf8');
  const m = src.match(/const GREETING_KEYWORDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'GREETING_KEYWORDS declaration not found');
  const live = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...GREETING_WORDS].sort(), live.sort());
});

test('RESERVED_TRAVEL_FIELD_KEYS matches flowGraph.service.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/flowGraph.service.js'), 'utf8');
  const m = src.match(/const RESERVED_TRAVEL_FIELD_KEYS = \[([^\]]*)\]/);
  assert.ok(m, 'RESERVED_TRAVEL_FIELD_KEYS declaration not found');
  const live = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...RESERVED_TRAVEL_FIELD_KEYS].sort(), live.sort());
});

// ---- happy path ----

test('happy path: valid spec compiles', () => {
  assert.equal(validateFlowSpec(clinicSpec()), null);
  const out = compileFlowSpec(clinicSpec());

  const menu = out.replyNodes.find(n => n.id === 'tmp:menu');
  assert.equal(menu.keyword, 'hi');
  assert.equal(menu.matchType, 'exact');
  assert.equal(menu.contentType, 'buttons');
  assert.deepEqual([...menu.hindiAliases].sort(), GREETING_WORDS.filter(w => w !== 'hi').sort());

  const menuEdges = out.edges.filter(e => e.fromNodeId === 'tmp:menu');
  assert.deepEqual(menuEdges.map(e => e.label), ['Book appointment', 'Clinic timings', 'Talk to us']);
  assert.deepEqual(menuEdges.map(e => e.toNodeId), ['tmp:booking', 'tmp:faq:timings', 'tmp:contact']);
  assert.deepEqual(menuEdges.map(e => e.displayOrder), [0, 1, 2]);

  const tapOnly = out.replyNodes.find(n => n.id === 'tmp:faq:timings');
  assert.equal(tapOnly.keyword, 'faq_timings');
  assert.equal(tapOnly.matchType, 'exact');
  assert.equal(tapOnly.contentType, 'buttons');
  assert.ok(out.edges.some(e => e.fromNodeId === 'tmp:faq:timings' && e.toNodeId === 'tmp:menu' && e.label === 'Main menu'));

  const typedFaq = out.replyNodes.find(n => n.id === 'tmp:faq:fees');
  assert.equal(typedFaq.matchType, 'contains');
  assert.deepEqual(typedFaq.hindiAliases, ['fees kitni']);
  assert.equal(typedFaq.contentType, 'text');

  const trigger = out.replyNodes.find(n => n.replyKind === 'booking_trigger');
  assert.equal(trigger.keyword, 'appointment');
  assert.deepEqual(out.questionNodes.map(q => q.contentType), ['text', 'buttons', 'location_request']);
  assert.equal(out.questionNodes[0].label, "Let's book your visit.\n\nPatient name?");
  assert.equal(out.questionNodes[1].label, 'Visit type?');
  assert.deepEqual(out.questionNodes.map(q => q.required), [true, true, false]);
  assert.deepEqual(out.questionNodes[1].options, [{ value: 'New', label: 'New patient' }, { value: 'Follow-up', label: 'Follow-up' }]);
});

test('happy path: compiled graph has no cycles and no unreachable questions', () => {
  const { nodes, edges } = asGraph(compileFlowSpec(clinicSpec()));
  assert.deepEqual(findCycles(nodes, edges), []);
  const entry = resolveBookingTriggerEntryNodeIds(nodes, edges);
  assert.deepEqual(entry, ['tmp:q:patientName']);
  assert.deepEqual(findUnreachableNodes(nodes, edges, entry), []);
  assert.equal(canEnterBookingQuestions(nodes, edges), true);
});

test('booking chain is entered only via the booking_trigger node', () => {
  const out = compileFlowSpec(clinicSpec());
  const replyIds = new Set(out.replyNodes.map(n => n.id));
  const questionIds = new Set(out.questionNodes.map(n => n.id));
  const intoQuestions = out.edges.filter(e => replyIds.has(e.fromNodeId) && questionIds.has(e.toNodeId));
  assert.equal(intoQuestions.length, 1);
  assert.equal(intoQuestions[0].fromNodeId, 'tmp:booking');
  assert.equal(intoQuestions[0].condition, null);
});

test('4-10 menu items become a list; descriptions allowed', () => {
  const spec = mutate(s => {
    s.faqs.push({ id: 'a', answer: 'A' }, { id: 'b', answer: 'B' });
    s.menu.push(
      { id: 'm_a', title: 'Twenty-four chars title!', description: 'Row description', action: { type: 'faq', faqId: 'a' } },
      { id: 'm_b', title: 'Option B', action: { type: 'faq', faqId: 'b' } }
    );
  });
  assert.equal(validateFlowSpec(spec), null);
  const out = compileFlowSpec(spec);
  assert.equal(out.replyNodes.find(n => n.id === 'tmp:menu').contentType, 'list');
  assert.equal(out.edges.find(e => e.toNodeId === 'tmp:faq:a').description, 'Row description');
  assert.ok(out.warnings.some(w => /WhatsApp list/.test(w)));
});

test('choice with 4-10 options becomes a list question', () => {
  const spec = mutate(s => {
    s.booking.fields[1].options = ['Mon', 'Tue', 'Wed', 'Thu'].map(d => ({ value: d, label: d }));
  });
  assert.equal(compileFlowSpec(spec).questionNodes[1].contentType, 'list');
});

test('layout: layered grid, booking chain on the trigger row', () => {
  const out = compileFlowSpec(clinicSpec());
  const menu = out.replyNodes.find(n => n.id === 'tmp:menu');
  assert.deepEqual([menu.positionX, menu.positionY], [0, 0]);
  const col1 = out.replyNodes.filter(n => n.id !== 'tmp:menu');
  assert.ok(col1.every(n => n.positionX === DX));
  assert.deepEqual(col1.map(n => n.positionY), col1.map((_, i) => i * DY));
  const trigger = out.replyNodes.find(n => n.id === 'tmp:booking');
  out.questionNodes.forEach((q, i) => {
    assert.equal(q.positionX, DX * (2 + i));
    assert.equal(q.positionY, trigger.positionY);
  });
});

test('location menu action emits a tap-only location node and a warning', () => {
  const spec = mutate(s => { s.menu.push({ id: 'where', title: 'Find us', action: { type: 'location' } }); });
  const out = compileFlowSpec(spec);
  const loc = out.replyNodes.find(n => n.contentType === 'location');
  assert.equal(loc.keyword, 'menu_location');
  assert.equal(loc.matchType, 'exact');
  assert.equal(loc.label, '');
  assert.ok(out.warnings.some(w => /map location/.test(w)));
});

test('payment emits a payment_trigger node', () => {
  const spec = mutate(s => { s.payment = { keyword: 'payment', text: 'Pay via UPI to clinic@upi' }; });
  const node = compileFlowSpec(spec).replyNodes.find(n => n.replyKind === 'payment_trigger');
  assert.equal(node.label, 'Pay via UPI to clinic@upi');
});

test('no booking: no question nodes, still valid', () => {
  const spec = mutate(s => { delete s.booking; s.menu = s.menu.filter(m => m.action.type !== 'booking'); });
  const out = compileFlowSpec(spec);
  assert.equal(out.questionNodes.length, 0);
  const { nodes, edges } = asGraph(out);
  assert.deepEqual(findCycles(nodes, edges), []);
});

test('overlapping typed keywords produce a warning, not an error', () => {
  const spec = mutate(s => { s.contact.keyword = 'consultation'; });
  assert.ok(compileFlowSpec(spec).warnings.some(w => /contained in keyword/.test(w)));
});

test('compile does not mutate its input', () => {
  const spec = clinicSpec();
  const before = JSON.stringify(spec);
  compileFlowSpec(spec);
  assert.equal(JSON.stringify(spec), before);
});

// ---- rejections ----

rejects('greeting over 1024 (interactive body)', s => { s.greeting.text = 'x'.repeat(LIMITS.INTERACTIVE_BODY + 1); }, /greeting.text must be 1024/);
rejects('FAQ answer with Main menu button over 1024', s => { s.faqs[0].answer = 'x'.repeat(1025); }, /answer must be 1024/);
rejects('plain FAQ answer over 4096', s => { s.faqs[1].answer = 'x'.repeat(4097); }, /answer must be 4096/);
rejects('choice question label over 1024', s => { s.booking.fields[1].label = 'x'.repeat(1025); }, /label must be 1024/);
rejects('intro pushes question 1 over its limit', s => { s.booking.fields[0].type = 'location'; s.booking.intro = 'x'.repeat(1020); }, /with booking.intro prefixed/);
rejects('button title over 20 (<=3 items)', s => { s.menu[0].title = 'x'.repeat(21); }, /title must be 20 characters or less \(button\)/);
rejects('list row title over 24', s => {
  s.faqs.push({ id: 'a', answer: 'A' });
  s.menu.push({ id: 'm_a', title: 'x'.repeat(25), action: { type: 'faq', faqId: 'a' } });
}, /title must be 24 characters or less \(list row\)/);
rejects('list row description over 72', s => {
  s.faqs.push({ id: 'a', answer: 'A' });
  s.menu.push({ id: 'm_a', title: 'A', description: 'x'.repeat(73), action: { type: 'faq', faqId: 'a' } });
}, /description must be 72/);
rejects('description on a button menu', s => { s.menu[0].description = 'nope'; }, /only allowed when the menu has more than 3/);
rejects('choice button option label over 20', s => { s.booking.fields[1].options[0].label = 'x'.repeat(21); }, /20 characters or less \(button\)/);
rejects('choice list option label over 24', s => {
  s.booking.fields[1].options = ['a', 'b', 'c', 'd'].map(v => ({ value: v, label: v }));
  s.booking.fields[1].options[0].label = 'x'.repeat(25);
}, /24 characters or less \(list row\)/);
rejects('more than 10 menu items', s => {
  for (let i = 0; i < 8; i++) {
    s.faqs.push({ id: `f${i}`, answer: 'x' });
    s.menu.push({ id: `m${i}`, title: `Item ${i}`, action: { type: 'faq', faqId: `f${i}` } });
  }
}, /at most 10 items/);
rejects('more than 10 choice options', s => {
  s.booking.fields[1].options = Array.from({ length: 11 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }));
}, /at most 10 options/);
rejects('choice with a single option', s => { s.booking.fields[1].options = [{ value: 'a', label: 'a' }]; }, /at least 2 options/);
rejects('contains keyword under 4 chars', s => { s.contact.keyword = 'cal'; }, /at least 4 characters/);
rejects('alias under 4 chars', s => { s.faqs[1].aliases = ['fee']; }, /at least 4 characters/);
rejects('keyword is a greeting word', s => { s.contact.keyword = 'hello'; }, /greeting word "hello"/);
rejects('keyword contained in a greeting word', s => { s.contact.keyword = 'nama'; }, /greeting word "namaste"/);
rejects('alias is a greeting word', s => { s.faqs[1].aliases = ['namaste']; }, /greeting word "namaste"/);
rejects('reserved travel field key', s => { s.booking.fields[0].key = 'pickupLocation'; }, /reserved by the booking engine/);
rejects('reserved engine bookkeeping key', s => { s.booking.fields[0].key = 'vehicleFare'; }, /reserved by the booking engine/);
rejects('duplicate keyword across nodes', s => { s.contact.keyword = 'Appointment'; }, /duplicates the keyword of booking.keyword/);
rejects('duplicate keyword after matcher normalization', s => { s.contact.keyword = 'appoint-ment!'; s.booking.keyword = 'appointment'; }, /duplicates/);
rejects('typed keyword collides with a tap-only keyword', s => { s.contact.keyword = 'faq_timings'; }, /tap-only/);
rejects('duplicate alias across FAQs', s => { s.faqs[1].aliases = ['contact']; }, /duplicates/);
rejects('menu faq action with unknown faqId', s => { s.menu[1].action.faqId = 'nope'; }, /does not match any faqs/);
rejects('menu booking action without spec.booking', s => { delete s.booking; }, /spec.booking is not set/);
rejects('tap-only FAQ not in the menu', s => { s.faqs.push({ id: 'orphan', answer: 'x' }); }, /no customer could ever reach it/);
rejects('tap-only FAQ with aliases', s => { s.faqs[0].aliases = ['timing']; }, /tap-only FAQ can't have typed aliases/);
rejects('duplicate field key', s => { s.booking.fields[1].key = 'patientName'; }, /duplicate/);
rejects('non-camelCase field key', s => { s.booking.fields[0].key = 'Patient Name'; }, /camelCase/);
rejects('options on a text field', s => { s.booking.fields[0].options = [{ value: 'a', label: 'a' }]; }, /only allowed for type "choice"/);
rejects('unknown field type', s => { s.booking.fields[0].type = 'date'; }, /type must be one of/);
rejects('more than 10 booking fields', s => {
  s.booking.fields = Array.from({ length: 11 }, (_, i) => ({ key: `f${i}`, label: 'q', type: 'text' }));
}, /at most 10 fields/);
rejects('wrong version', s => { s.version = 2; }, /version must be 1/);
rejects('bad menu id', s => { s.menu[0].id = 'Book-Now'; }, /id must match/);
rejects('duplicate menu title', s => { s.menu[1].title = 'book appointment'; }, /duplicates another menu item's title/);
