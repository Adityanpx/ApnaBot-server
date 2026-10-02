// Run: node --test src/utils/coachingTranslations.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapCoachingSettingsToSpec, validateCoachingSettings, formTitleForKeyword } = require('./coachingBotSettings');
const { validateFlowFields } = require('./flowFieldsValidation');
const { compileFlowSpecV2 } = require('./flowSpecV2');
const { validateTranslations, translationWarnings } = require('./coachingTranslations');

const courses = () => ([
  { id: 'c-abacus', name: 'Abacus', description: 'Ages 5-14', details: 'Abacus levels 1-8.', showDemoButton: true, showAdmissionButton: false },
  { id: 'c-vedic', name: 'Vedic Maths', details: 'Fast mental maths.', showDemoButton: true, showAdmissionButton: false }
]);
const settings = (extra = {}) => ({
  version: 1,
  welcomeMessage: 'Hello *{{customerName}}*, welcome to *{{businessName}}*!',
  sections: {
    fees: { enabled: true, text: 'Abacus ₹4,000 per level.' }, timings: { enabled: false, text: '' },
    results: { enabled: false, text: '' }, material: { enabled: false, text: '' },
    contact: { enabled: false, text: '' }, location: { enabled: false }
  },
  demoForm: { enabled: true, fields: [], customFields: [] },
  admissionForm: { enabled: false, fields: [], customFields: [] },
  faq: { enabled: true, items: [{ question: 'Online classes?', answer: 'Yes, on Zoom.' }] },
  ...extra
});
const map = (s, languages = ['hi', 'mr'], cs = courses()) => mapCoachingSettingsToSpec(s, { businessName: 'Bright Minds', courses: cs, languages });
const entry = (text, source) => ({ text, source });

test('built-in wording is translated without owner input; owner texts are missing until typed', () => {
  const { spec, translation } = map(settings());
  assert.equal(spec.menu.find(m => m.title === '💰 Fees').titleTranslations.mr, '💰 फी');
  const coursesPage = spec.pages.find(p => p.id === 'courses');
  assert.equal(coursesPage.textTranslations.hi, 'हमारे कोर्स — जानकारी देखने के लिए किसी एक पर टैप करें:');
  assert.equal(spec.forms[0].buttonTextTranslations.mr, 'फॉर्म भरा');
  assert.equal(spec.greeting.textTranslations, undefined);
  assert.equal(spec.pages.find(p => p.id === 'fees').textTranslations, undefined);
  // welcome, fees, 2 course names, 1 description, 2 course pages, faq question + answer
  assert.equal(translation.report.mr.total, 9);
  assert.equal(translation.report.mr.missing, 9);
  assert.match(translationWarnings(translation.report)[0], /^हिंदी: 9 of 9 texts have no translation yet/);
});

test('owner translations are used when written for the current English, else English is sent', () => {
  const s = settings({
    translations: {
      mr: {
        welcome: entry('नमस्कार *{{customerName}}*, *{{businessName}}* मध्ये स्वागत आहे!', 'Hello *{{customerName}}*, welcome to *{{businessName}}*!'),
        'section.fees': entry('अबॅकस ₹४,००० प्रति लेव्हल.', 'Abacus ₹3,500 per level.'), // English changed since
        'course.c-abacus.name': entry('अबॅकस', 'Abacus'),
        'course.c-abacus.page': entry('अबॅकस लेव्हल १-८.', 'Abacus levels 1-8.'),
        'fixed.button.mainMenu': entry('मेनू', 'Main menu') // owner replaces a built-in
      }
    }
  });
  const { spec, translation } = map(s);
  assert.equal(spec.greeting.textTranslations.mr, 'नमस्कार *{{customerName}}*, *{{businessName}}* मध्ये स्वागत आहे!');
  assert.equal(spec.greeting.textTranslations.hi, undefined);
  assert.equal(spec.pages.find(p => p.id === 'fees').textTranslations, undefined);
  assert.equal(translation.report.mr.changed, 1);
  const abacusRow = spec.pages.find(p => p.id === 'courses').list[0];
  assert.equal(abacusRow.titleTranslations.mr, 'अबॅकस');
  assert.equal(spec.pages.find(p => p.id === 'course_1').textTranslations.mr, 'अबॅकस लेव्हल १-८.');
  assert.equal(spec.pages.find(p => p.id === 'course_1').buttons.at(-1).titleTranslations.mr, 'मेनू');
  assert.equal(spec.pages.find(p => p.id === 'course_1').buttons.at(-1).titleTranslations.hi, 'मुख्य मेन्यू');
  // Course translations follow the course (by id), not its position.
  const swapped = map(s, ['mr'], courses().reverse()).spec;
  assert.equal(swapped.pages.find(p => p.id === 'course_2').textTranslations.mr, 'अबॅकस लेव्हल १-८.');
});

test('too long, changed placeholders, half-translated FAQ, duplicate titles → English for those', () => {
  const s = settings({
    translations: {
      hi: {
        welcome: entry('नमस्ते!', 'Hello *{{customerName}}*, welcome to *{{businessName}}*!'), // placeholders dropped
        'course.c-abacus.name': entry('अबॅकस का बहुत लंबा कोर्स नाम यहाँ', 'Abacus'), // > 24
        'course.c-vedic.name': entry('फ्री डेमो', 'Vedic Maths'),
        'faq.1.answer': entry('हाँ, ज़ूम पर।', 'Yes, on Zoom.') // question not translated
      }
    }
  });
  const { spec, translation } = map(s, ['hi']);
  assert.equal(spec.greeting.textTranslations, undefined);
  assert.deepEqual(translation.report.hi.badPlaceholders, ['Welcome message (the menu)']);
  assert.deepEqual(translation.report.hi.tooLong, ['Abacus — name in the list']);
  assert.equal(spec.pages.find(p => p.id === 'faq_1').textTranslations, undefined);
  assert.equal(spec.pages.find(p => p.id === 'courses').list[1].titleTranslations.hi, 'फ्री डेमो');
  // Two rows of one list reading the same in Hindi → both fall back to English.
  const clash = map(settings({ translations: { hi: { 'course.c-abacus.name': entry('गणित', 'Abacus'), 'course.c-vedic.name': entry('गणित', 'Vedic Maths') } } }), ['hi']).spec;
  const list = clash.pages.find(p => p.id === 'courses').list;
  assert.equal(list[0].titleTranslations, undefined);
  assert.equal(list[1].titleTranslations, undefined);
});

test('a 3-item menu is sent as buttons: translations over 20 characters fall back', () => {
  const s = settings({
    faq: { enabled: false, items: [] },
    translations: { hi: { 'fixed.menu.fees': entry('💰 फीस और भुगतान की पूरी जानकारी', '💰 Fees') } }
  });
  const { spec, translation } = map(s, ['hi']);
  assert.equal(spec.menu.length, 3);
  assert.equal(spec.menu.find(m => m.title === '💰 Fees').titleTranslations, undefined);
  assert.ok(translation.report.hi.tooLong.includes('💰 Fees'));
});

test('compiled graph carries the translations to nodes and edges', () => {
  const s = settings({ translations: { mr: { 'course.c-abacus.description': entry('वय ५-१४', 'Ages 5-14') } } });
  const graph = compileFlowSpecV2(map(s).spec);
  const coursesNode = graph.replyNodes.find(n => n.id === 'tmp:page:courses');
  assert.equal(coursesNode.labelTranslations.mr, 'आमचे कोर्सेस — माहिती पाहण्यासाठी एकावर टॅप करा:');
  const abacusEdge = graph.edges.find(e => e.fromNodeId === 'tmp:page:courses' && e.label === 'Abacus');
  assert.equal(abacusEdge.descriptionTranslations.mr, 'वय ५-१४');
  const form = graph.replyNodes.find(n => n.replyKind === 'web_form_trigger');
  assert.equal(form.buttonTextTranslations.hi, 'फॉर्म भरें');
  assert.equal(form.labelTranslations.mr, 'मोफत डेमो क्लास बुक करा — खालील बटणावर टॅप करून छोटा फॉर्म भरा.');
});

test('web form fields: built-in question/choice translations, owner custom questions + note, values stay English', () => {
  const s = settings({
    demoForm: {
      enabled: true, fields: ['mode', 'batch', 'standard'], note: 'Bring a notebook',
      customFields: [{ label: 'How did you hear of us?', type: 'dropdown', options: ['Friend', 'Instagram'] }]
    },
    translations: {
      mr: {
        'form.demo.note': entry('वही आणा', 'Bring a notebook'),
        'form.demo.custom1.label': entry('आमच्याबद्दल कसे कळले?', 'How did you hear of us?'),
        'form.demo.custom1.option1': entry('मित्र', 'Friend')
      }
    }
  });
  const fields = map(s).spec.forms[0].fields;
  const byName = Object.fromEntries(fields.map(f => [f.name, f]));
  assert.equal(byName.note.labelTranslations.mr, 'वही आणा');
  assert.equal(byName.studentName.labelTranslations.mr, 'विद्यार्थ्याचे नाव');
  assert.equal(byName.course.optionTranslations, undefined); // course names stay as typed
  assert.deepEqual(byName.mode.options, ['Online', 'Offline']);
  assert.equal(byName.mode.optionTranslations.hi.Online, 'ऑनलाइन');
  assert.equal(byName.batch.optionTranslations.mr.Weekend, 'शनिवार–रविवार');
  assert.equal(byName.standard.optionTranslations.mr['12th passed'], '12वी उत्तीर्ण');
  assert.equal(byName.custom1.labelTranslations.mr, 'आमच्याबद्दल कसे कळले?');
  assert.deepEqual(byName.custom1.optionTranslations, { mr: { Friend: 'मित्र' } });
  assert.equal(validateFlowFields(fields), null);
  // No languages → exactly the English fields, no translation keys.
  const plain = map(s, []).spec.forms[0].fields;
  assert.ok(plain.every(f => !f.labelTranslations && !f.optionTranslations));
  assert.equal(formTitleForKeyword('demo', 'mr').title, 'मोफत डेमो क्लास बुक करा');
  assert.equal(formTitleForKeyword('demo', null).title, 'Book a free demo class');
});

test('form field translation keys are validated', () => {
  const base = { name: 'mode', label: 'Mode', type: 'radio', options: ['Online', 'Offline'] };
  assert.equal(validateFlowFields([{ ...base, optionTranslations: { mr: { Online: 'ऑनलाइन' } } }]), null);
  assert.match(validateFlowFields([{ ...base, optionTranslations: { mr: { Hybrid: 'x' } } }]), /optionTranslations/);
  assert.match(validateFlowFields([{ ...base, labelTranslations: { en: 'Mode' } }]), /labelTranslations/);
  assert.match(validateFlowFields([{ ...base, labelTranslations: { mr: '' } }]), /labelTranslations/);
});

test('settings.translations shape is checked', () => {
  assert.equal(validateTranslations(undefined), null);
  assert.match(validateTranslations({ en: {} }), /unknown language "en"/);
  assert.match(validateTranslations({ mr: { welcome: 'x' } }), /must be \{ text, source \}/);
  assert.match(validateTranslations({ mr: { 'bad id!': entry('a', 'b') } }), /bad text id/);
  assert.equal(validateTranslations({ mr: { welcome: entry('', 'Hello') } }), null);
  assert.match(validateCoachingSettings(settings({ translations: [] }), { forPublish: false }), /translations must be an object/);
});
