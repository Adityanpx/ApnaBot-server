// Run: node --test src/utils/flowSpecQuestionnaire.test.js
// Pure — no Supabase/Redis.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateQuestionnaireAnswers, mapAnswersToFlowSpec, generateFieldKeys } = require('./flowSpecQuestionnaire');
const { validateFlowSpec, compileFlowSpec } = require('./flowSpec');
const { findCycles, findUnreachableNodes, resolveBookingTriggerEntryNodeIds } = require('./flowGraphValidation');

const CTX = { businessName: 'CareWell Clinic' };
const clinicAnswers = () => ({
  version: 1,
  intro: 'Family clinic in Kothrud since 2010.',
  services: [
    { name: 'General consultation', price: '₹500', description: '20-min visit' },
    { name: 'Blood test', price: '₹300' }
  ],
  hours: 'Mon–Sat 9am–7pm, Sunday closed',
  address: { text: '12 MG Road, Pune', showMapPin: false },
  booking: {
    enabled: true,
    intro: "Let's book your visit.",
    fields: [
      { label: 'Patient name', type: 'text', required: true },
      { label: 'Visit type', type: 'choice', options: ['New patient', 'Follow-up'] },
      { label: 'Your location', type: 'location', required: false }
    ]
  },
  payment: { text: 'Pay at reception or UPI to carewell@upi' },
  contact: { text: 'Call 98xxxxxxxx, or wait — our team will reply here.' },
  faqs: [{ title: 'Insurance', answer: 'We accept most TPA cards.', keyword: 'insurance' }]
});
const mutate = (fn) => { const a = clinicAnswers(); fn(a); return a; };
const mapErr = (fn) => mapAnswersToFlowSpec(mutate(fn), CTX).error;

test('happy path: full clinic answers -> valid spec -> valid graph', () => {
  const { spec, error } = mapAnswersToFlowSpec(clinicAnswers(), CTX);
  assert.equal(error, null);
  assert.equal(validateFlowSpec(spec), null);
  assert.equal(spec.greeting.text, 'Welcome to CareWell Clinic! Family clinic in Kothrud since 2010.\n\nPlease choose an option:');
  assert.deepEqual(spec.menu.map(m => m.title),
    ['Book now', 'Services & fees', 'Timings', 'Address', 'Payment', 'Talk to us', 'Insurance']);
  assert.equal(spec.booking.keyword, 'book');
  assert.deepEqual(spec.booking.fields.map(f => f.key), ['patientName', 'visitType', 'yourLocation']);
  assert.deepEqual(spec.booking.fields[1].options, [{ value: 'New patient', label: 'New patient' }, { value: 'Follow-up', label: 'Follow-up' }]);
  assert.deepEqual(spec.booking.fields.map(f => f.required), [true, true, false]);
  const services = spec.faqs.find(f => f.id === 'services');
  assert.equal(services.answer, 'Our services:\n• General consultation — ₹500\n  20-min visit\n• Blood test — ₹300');
  assert.deepEqual(services.aliases, ['price', 'rates']);

  const out = compileFlowSpec(spec);
  const nodes = [...out.replyNodes, ...out.questionNodes];
  const edges = out.edges.map((e, i) => ({ ...e, id: `e${i}` }));
  assert.deepEqual(findCycles(nodes, edges), []);
  assert.deepEqual(findUnreachableNodes(nodes, edges, resolveBookingTriggerEntryNodeIds(nodes, edges)), []);
  assert.equal(out.replyNodes.find(n => n.id === 'tmp:menu').contentType, 'list');
});

test('minimal answers: only contact -> 1-button menu', () => {
  const { spec, error } = mapAnswersToFlowSpec({ version: 1, contact: { text: 'Call us' } }, CTX);
  assert.equal(error, null);
  assert.deepEqual(spec.menu.map(m => m.action.type), ['contact']);
  assert.equal(spec.greeting.text, 'Welcome to CareWell Clinic!\n\nPlease choose an option:');
  assert.equal(spec.booking, undefined);
});

test('booking.enabled false -> no booking, no Book now', () => {
  const { spec } = mapAnswersToFlowSpec(mutate(a => { a.booking.enabled = false; }), CTX);
  assert.equal(spec.booking, undefined);
  assert.ok(!spec.menu.some(m => m.action.type === 'booking'));
});

test('custom booking keyword is used', () => {
  const { spec } = mapAnswersToFlowSpec(mutate(a => { a.booking.keyword = 'appointment'; }), CTX);
  assert.equal(spec.booking.keyword, 'appointment');
});

test('showMapPin adds a location menu item', () => {
  const { spec } = mapAnswersToFlowSpec(mutate(a => { a.address.showMapPin = true; }), CTX);
  assert.ok(spec.menu.some(m => m.action.type === 'location' && m.title === 'Find us on map'));
});

test('custom FAQs beyond the 10-row menu become keyword-only', () => {
  const answers = mutate(a => {
    a.faqs = Array.from({ length: 5 }, (_, i) => ({ title: `Question ${i + 1}`, answer: 'A', keyword: `topic${i + 1}` }));
  });
  const { spec, error } = mapAnswersToFlowSpec(answers, CTX);
  assert.equal(error, null);
  assert.equal(spec.menu.length, 10);
  assert.deepEqual(spec.menu.slice(6).map(m => m.title), ['Question 1', 'Question 2', 'Question 3', 'Question 4']);
  const fifth = spec.faqs.find(f => f.id === 'custom_5');
  assert.equal(fifth.keyword, 'topic5');
  assert.ok(!spec.menu.some(m => m.id === 'custom_5'));
});

// ---- field key generation ----

test('key collision rule: same camelCase key gets a numeric suffix, never rejected', () => {
  assert.deepEqual(generateFieldKeys(['Phone number', 'Phone Number:', 'phone-number']),
    ['phoneNumber', 'phoneNumber2', 'phoneNumber3']);
  const { spec, error } = mapAnswersToFlowSpec(mutate(a => {
    a.booking.fields = [{ label: 'Phone number', type: 'text' }, { label: 'Phone Number:', type: 'text' }];
  }), CTX);
  assert.equal(error, null);
  assert.deepEqual(spec.booking.fields.map(f => f.key), ['phoneNumber', 'phoneNumber2']);
  assert.deepEqual(spec.booking.fields.map(f => f.label), ['Phone number', 'Phone Number:']);
});

test('key generation: reserved keys get a suffix too', () => {
  assert.deepEqual(generateFieldKeys(['Vehicle fare', 'Pickup location']), ['vehicleFare2', 'pickupLocation2']);
});

test('key generation: non-ASCII label, leading digit, punctuation-only', () => {
  assert.deepEqual(generateFieldKeys(['नाम', 'पत्ता', '2nd phone', '???']), ['field', 'field2', 'field2ndPhone', 'field3']);
});

test('key generation: long labels are cut so the suffixed key stays valid', () => {
  const long = 'Please tell us the full name of the patient exactly as on ID';
  const keys = generateFieldKeys([long, long]);
  assert.ok(keys.every(k => /^[a-z][a-zA-Z0-9]{0,39}$/.test(k)));
  assert.notEqual(keys[0], keys[1]);
});

// ---- rejections ----

test('rejects: missing businessName', () => {
  assert.match(mapAnswersToFlowSpec(clinicAnswers(), {}).error, /businessName is required/);
});
test('rejects: wrong version', () => assert.match(mapErr(a => { a.version = 2; }), /version must be 1/));
test('rejects: intro over 300', () => assert.match(mapErr(a => { a.intro = 'x'.repeat(301); }), /intro must be 300/));
test('rejects: service without name', () => assert.match(mapErr(a => { a.services[0].name = ' '; }), /services\[0\].name is required/));
test('rejects: combined services text over 1024', () => assert.match(
  mapErr(a => { a.services = Array.from({ length: 10 }, (_, i) => ({ name: `Service ${i}`, description: 'x'.repeat(100) })); }),
  /combined list is \d+ characters/));
test('rejects: booking enabled with no questions', () => assert.match(mapErr(a => { a.booking.fields = []; }), /at least one question/));
test('rejects: unknown question type', () => assert.match(mapErr(a => { a.booking.fields[0].type = 'date'; }), /type must be one of/));
test('rejects: choice with one option', () => assert.match(mapErr(a => { a.booking.fields[1].options = ['Only']; }), /at least 2/));
test('rejects: choice option over 20 (buttons)', () => assert.match(mapErr(a => { a.booking.fields[1].options[0] = 'x'.repeat(21); }), /20 characters/));
test('rejects: duplicate choice option', () => assert.match(mapErr(a => { a.booking.fields[1].options = ['Yes', 'yes']; }), /twice/));
test('rejects: payment without text', () => assert.match(mapErr(a => { a.payment = {}; }), /payment.text is required/));
test('rejects: FAQ title over 20 even when the menu is a list', () => assert.match(mapErr(a => { a.faqs[0].title = 'x'.repeat(21); }), /title must be 20/));
test('rejects: FAQ title clashing with a fixed menu title', () => assert.match(mapErr(a => { a.faqs[0].title = 'timings'; }), /already used/));
test('rejects: overflow FAQ without a keyword', () => assert.match(
  mapErr(a => { a.faqs = Array.from({ length: 5 }, (_, i) => ({ title: `Q${i}`, answer: 'A' })); }),
  /doesn't fit in the 10-item menu/));
test('rejects: nothing to put in the menu', () => {
  assert.match(mapAnswersToFlowSpec({ version: 1, intro: 'Hi there' }, CTX).error, /at least one of/);
});
test('rejects: FAQ keyword clashing with a fixed keyword surfaces the FlowSpec error', () => {
  assert.match(mapErr(a => { a.faqs[0].keyword = 'price'; }), /generated flow is invalid: .*duplicates/);
});

test('validateQuestionnaireAnswers returns null for the clinic answers', () => {
  assert.equal(validateQuestionnaireAnswers(clinicAnswers()), null);
});
