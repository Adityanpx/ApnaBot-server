// Coaching/classes preset for the settings-driven bot builder
// (business_bot_settings.preset = 'coaching'). The owner describes courses,
// menu sections and two forms in Settings; this maps those settings to a
// FlowSpec v2 (flowSpecV2.js), which compiles to a reply-only, tappable
// WhatsApp flow. Pure — no Supabase/Redis.
//
// Settings shape (v1):
//   {
//     version: 1,
//     intro?: string,                                    // <= 300
//     courses: [ { id, name, description?, details, buttons: { demo, admission } } ],  // 0..10 draft, 1..10 publish
//     sections: {
//       fees|timings|results|material|contact: { enabled, text },
//       location: { enabled }                            // uses the shop location in Settings
//     },
//     demoForm:      { enabled, fields: [libraryKey], customFields: [ { label, type, options? } ], note? },
//     admissionForm: { enabled, fields: [libraryKey], customFields: [...], note?, targetExamOptions? }
//   }
//
// Reviewed decisions (v1): no course groups (max 10 courses), no brochure
// button, no draft preview chat (compile shows structure only), Student
// name + Course always in both forms; with a single course the Course
// dropdown is replaced by an information line naming the course (a
// dropdown needs >= 2 options, see flowFieldsValidation.js).
const { validateFlowSpecV2 } = require('./flowSpecV2');
const { LIMITS } = require('./flowSpec');

// Course page ids are `course_<id>`; flowSpecV2 page ids are capped at 40
// characters, so course ids are capped at 30.
const COURSE_ID_PATTERN = /^[a-z0-9_]{1,30}$/;

const MAX_COURSES = LIMITS.MAX_LIST_ROWS;
const MAX_INTRO = 300;
const MAX_NOTE = 300;
const MAX_CUSTOM_FIELDS = 5;
const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'dropdown'];

// Optional form fields an owner can tick, in the order they appear on the
// form. Options are fixed except targetExam (owner-typed, see
// targetExamOptions).
const FIELD_LIBRARY = [
  { key: 'parentName', label: "Parent's name", type: 'text' },
  { key: 'fatherName', label: "Father's name", type: 'text' },
  { key: 'motherName', label: "Mother's name", type: 'text' },
  { key: 'dob', label: 'Date of birth', type: 'date' },
  { key: 'age', label: 'Student age', type: 'text' },
  { key: 'school', label: 'School / college', type: 'text' },
  { key: 'standard', label: 'Standard', type: 'dropdown', options: ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '12th passed'] },
  { key: 'board', label: 'Board', type: 'radio', options: ['State board', 'CBSE', 'ICSE'] },
  { key: 'stream', label: 'Stream', type: 'radio', options: ['Science', 'Commerce', 'Arts'] },
  { key: 'targetExam', label: 'Target exam', type: 'dropdown' },
  { key: 'tenthPercent', label: '10th percentage', type: 'text' },
  { key: 'batch', label: 'Batch', type: 'radio', options: ['Weekday', 'Weekend'] },
  { key: 'mode', label: 'Mode', type: 'radio', options: ['Online', 'Offline'] },
  { key: 'preferredTime', label: 'Preferred time', type: 'radio', options: ['Morning', 'Afternoon', 'Evening'] },
  { key: 'area', label: 'Area / locality', type: 'text' }
];
const LIBRARY_KEYS = FIELD_LIBRARY.map(f => f.key);

// Text sections: menu title, typed keyword/aliases, and which form button
// (if that form is enabled) sits next to "Main menu" on the page.
const SECTIONS = [
  { key: 'fees', title: '💰 Fees', keyword: 'fees', aliases: ['charges'], formButton: 'admission' },
  { key: 'timings', title: '🕘 Batches & timings', keyword: 'timing', aliases: ['batch'], formButton: 'demo' },
  { key: 'results', title: '🏆 Results & faculty', keyword: 'result', aliases: ['topper'], formButton: null },
  { key: 'material', title: '📄 Study material', keyword: 'material', aliases: ['notes'], formButton: null },
  { key: 'contact', title: '📞 Contact us', keyword: 'contact', aliases: [], formButton: null }
];
const FORMS = {
  demo: {
    settingsKey: 'demoForm', menuTitle: '🎓 Free demo', buttonTitle: 'Free demo',
    keyword: 'demo', aliases: [],
    text: 'Book a free demo class — tap the button below and fill a short form.'
  },
  admission: {
    settingsKey: 'admissionForm', menuTitle: '📝 Admission', buttonTitle: 'Admission',
    keyword: 'admission', aliases: ['register'],
    text: 'Apply for admission — tap the button below and fill the form.'
  }
};
const FORM_BUTTON_TEXT = 'Fill form';
const MAIN_MENU = { title: 'Main menu', target: { type: 'menu' } };

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isOptionalString = (v) => v === undefined || v === null || typeof v === 'string';
const len = (v) => v.trim().length;

/**
 * Validates coaching settings. forPublish=false (saving a draft) allows an
 * incomplete setup — no courses yet, enabled sections without text — so an
 * owner can save as they go; forPublish=true requires everything a working
 * bot needs. Returns the first problem as a message, or null.
 * @param {Object} settings
 * @param {{ forPublish?: boolean }} [opts]
 * @returns {string|null}
 */
const validateCoachingSettings = (settings, { forPublish = false } = {}) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'settings must be an object';
  if (settings.version !== 1) return 'settings.version must be 1';
  if (!isOptionalString(settings.intro)) return 'Intro must be text';
  if (isNonEmptyString(settings.intro) && len(settings.intro) > MAX_INTRO) return `Intro must be ${MAX_INTRO} characters or less`;

  const courses = settings.courses === undefined ? [] : settings.courses;
  if (!Array.isArray(courses)) return 'courses must be a list';
  if (courses.length > MAX_COURSES) return `You can add at most ${MAX_COURSES} courses`;
  if (forPublish && courses.length === 0) return 'Add at least one course before publishing';
  const ids = new Set();
  const names = new Set();
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    const at = `Course ${i + 1}`;
    if (!c || typeof c !== 'object') return `${at} is invalid`;
    if (typeof c.id !== 'string' || !COURSE_ID_PATTERN.test(c.id)) return `${at}: id must match ${COURSE_ID_PATTERN}`;
    if (ids.has(c.id)) return `${at}: id "${c.id}" is used twice`;
    ids.add(c.id);
    if (!isNonEmptyString(c.name)) return `${at}: name is required`;
    if (len(c.name) > LIMITS.LIST_ROW_TITLE) return `${at}: name must be ${LIMITS.LIST_ROW_TITLE} characters or less`;
    const n = c.name.trim().toLowerCase();
    if (names.has(n)) return `${at}: another course already has the name "${c.name.trim()}"`;
    names.add(n);
    if (!isOptionalString(c.description)) return `${at}: short description must be text`;
    if (isNonEmptyString(c.description) && len(c.description) > LIMITS.LIST_ROW_DESCRIPTION) {
      return `${at}: short description must be ${LIMITS.LIST_ROW_DESCRIPTION} characters or less`;
    }
    if (!isOptionalString(c.details)) return `${at}: details must be text`;
    if (forPublish && !isNonEmptyString(c.details)) return `${at}: details page is required`;
    if (isNonEmptyString(c.details) && len(c.details) > LIMITS.INTERACTIVE_BODY) {
      return `${at}: details must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
    }
    const b = c.buttons;
    if (!b || typeof b !== 'object' || typeof b.demo !== 'boolean' || typeof b.admission !== 'boolean') {
      return `${at}: buttons.demo and buttons.admission must be true or false`;
    }
  }

  const sections = settings.sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return 'sections must be an object';
  for (const s of SECTIONS) {
    const sec = sections[s.key];
    const label = s.title.replace(/^\S+\s/, '');
    if (!sec || typeof sec !== 'object' || typeof sec.enabled !== 'boolean') return `${label}: enabled must be true or false`;
    if (!isOptionalString(sec.text)) return `${label}: text must be text`;
    if (forPublish && sec.enabled && !isNonEmptyString(sec.text)) return `${label} is switched on but has no text`;
    if (isNonEmptyString(sec.text) && len(sec.text) > LIMITS.INTERACTIVE_BODY) {
      return `${label}: text must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
    }
  }
  if (!sections.location || typeof sections.location.enabled !== 'boolean') return 'Location: enabled must be true or false';

  for (const [formKey, meta] of Object.entries(FORMS)) {
    const form = settings[meta.settingsKey];
    const label = formKey === 'demo' ? 'Free demo form' : 'Admission form';
    if (!form || typeof form !== 'object' || typeof form.enabled !== 'boolean') return `${label}: enabled must be true or false`;
    if (!Array.isArray(form.fields)) return `${label}: fields must be a list`;
    const unknown = form.fields.find(k => !LIBRARY_KEYS.includes(k));
    if (unknown !== undefined) return `${label}: unknown field "${unknown}"`;
    if (new Set(form.fields).size !== form.fields.length) return `${label}: a field is ticked twice`;
    if (!isOptionalString(form.note)) return `${label}: note must be text`;
    if (isNonEmptyString(form.note) && len(form.note) > MAX_NOTE) return `${label}: note must be ${MAX_NOTE} characters or less`;
    if (form.fields.includes('targetExam')) {
      const opts = form.targetExamOptions;
      if (!Array.isArray(opts) || opts.length < 2 || opts.some(o => !isNonEmptyString(o))) {
        return `${label}: "Target exam" needs at least 2 exam names (e.g. JEE, CET)`;
      }
      if (new Set(opts.map(o => o.trim().toLowerCase())).size !== opts.length) return `${label}: an exam name is listed twice`;
    }
    const custom = form.customFields === undefined ? [] : form.customFields;
    if (!Array.isArray(custom)) return `${label}: custom questions must be a list`;
    if (custom.length > MAX_CUSTOM_FIELDS) return `${label}: at most ${MAX_CUSTOM_FIELDS} custom questions`;
    for (let i = 0; i < custom.length; i++) {
      const q = custom[i];
      if (!q || !isNonEmptyString(q.label)) return `${label}: custom question ${i + 1} needs a label`;
      if (!CUSTOM_FIELD_TYPES.includes(q.type)) return `${label}: custom question ${i + 1} type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}`;
      if (q.type === 'dropdown' && (!Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !isNonEmptyString(o)))) {
        return `${label}: custom question ${i + 1} is a dropdown and needs at least 2 options`;
      }
    }
  }

  return null;
};

/**
 * The form's field list, in flowFieldsValidation.js shape: optional note
 * first, then Student name, Course, ticked library fields (library order),
 * custom questions.
 */
const buildFormFields = (form, courses) => {
  const fields = [];
  if (isNonEmptyString(form.note)) fields.push({ name: 'note', label: form.note.trim(), type: 'display_text' });
  fields.push({ name: 'studentName', label: 'Student name', type: 'text', required: true });
  if (courses.length >= 2) {
    fields.push({ name: 'course', label: 'Course', type: 'dropdown', options: courses.map(c => c.name.trim()), required: true });
  } else {
    fields.push({ name: 'courseInfo', label: `Course: ${courses[0].name.trim()}`, type: 'display_text' });
  }
  for (const lib of FIELD_LIBRARY) {
    if (!form.fields.includes(lib.key)) continue;
    const options = lib.key === 'targetExam' ? form.targetExamOptions.map(o => o.trim()) : lib.options;
    fields.push({ name: lib.key, label: lib.label, type: lib.type, ...(options ? { options } : {}) });
  }
  (form.customFields || []).forEach((q, i) => {
    fields.push({
      name: `custom${i + 1}`, label: q.label.trim(), type: q.type,
      ...(q.type === 'dropdown' ? { options: q.options.map(o => o.trim()) } : {})
    });
  });
  return fields;
};

/**
 * Maps publish-ready coaching settings to a FlowSpec v2. Returns
 * { spec, error } — error is a settings-level message, or (last resort) a
 * FlowSpec-level one; spec is null whenever error is set.
 * @param {Object} settings
 * @param {{ businessName: string }} context
 * @returns {{ spec: Object|null, error: string|null }}
 */
const mapCoachingSettingsToSpec = (settings, { businessName } = {}) => {
  if (!isNonEmptyString(businessName)) return { spec: null, error: 'businessName is required' };
  const settingsError = validateCoachingSettings(settings, { forPublish: true });
  if (settingsError) return { spec: null, error: settingsError };

  const courses = settings.courses;
  const formEnabled = (key) => settings[FORMS[key].settingsKey].enabled;
  const formButton = (key) => ({ title: FORMS[key].buttonTitle, target: { type: 'form', id: key } });

  const pages = [];
  const forms = [];
  const menu = [];

  // Courses: a list page for 2+ courses, straight to the course page for 1.
  for (const c of courses) {
    const buttons = [];
    if (c.buttons.demo && formEnabled('demo')) buttons.push(formButton('demo'));
    if (c.buttons.admission && formEnabled('admission')) buttons.push(formButton('admission'));
    buttons.push(MAIN_MENU);
    pages.push({ id: `course_${c.id}`, text: c.details.trim(), buttons });
  }
  if (courses.length >= 2) {
    const list = courses.map(c => ({
      title: c.name.trim(),
      ...(isNonEmptyString(c.description) ? { description: c.description.trim() } : {}),
      target: { type: 'page', id: `course_${c.id}` }
    }));
    if (list.length < LIMITS.MAX_LIST_ROWS) list.push(MAIN_MENU);
    pages.push({ id: 'courses', text: 'Our courses — tap one to see the details:', keyword: 'course', list });
    menu.push({ title: '📚 Courses', target: { type: 'page', id: 'courses' } });
  } else {
    pages[0].keyword = 'course';
    menu.push({ title: '📚 Courses', target: { type: 'page', id: `course_${courses[0].id}` } });
  }

  const sectionMenu = (key) => {
    const s = SECTIONS.find(x => x.key === key);
    const sec = settings.sections[key];
    if (!sec.enabled) return;
    const buttons = [];
    if (s.formButton && formEnabled(s.formButton)) buttons.push(formButton(s.formButton));
    buttons.push(MAIN_MENU);
    pages.push({ id: key, text: sec.text.trim(), keyword: s.keyword, aliases: s.aliases, buttons });
    menu.push({ title: s.title, target: { type: 'page', id: key } });
  };
  const formMenu = (key) => {
    if (!formEnabled(key)) return;
    const meta = FORMS[key];
    forms.push({
      id: key, text: meta.text, buttonText: FORM_BUTTON_TEXT, keyword: meta.keyword, aliases: meta.aliases,
      fields: buildFormFields(settings[meta.settingsKey], courses)
    });
    menu.push({ title: meta.menuTitle, target: { type: 'form', id: key } });
  };

  ['fees', 'timings', 'results', 'material'].forEach(sectionMenu);
  formMenu('demo');
  formMenu('admission');
  let location = null;
  if (settings.sections.location.enabled) {
    location = { keyword: 'location' };
    menu.push({ title: '📍 Location', target: { type: 'location' } });
  }
  sectionMenu('contact');

  const intro = isNonEmptyString(settings.intro) ? ` ${settings.intro.trim()}` : '';
  const spec = {
    version: 2,
    greeting: { text: `Hello {{customerName}}, welcome to ${businessName.trim()}!${intro}\n\nPlease choose an option:` },
    menu,
    pages,
    forms,
    ...(location ? { location } : {})
  };
  const specError = validateFlowSpecV2(spec);
  if (specError) return { spec: null, error: `The generated flow is invalid: ${specError}` };
  return { spec, error: null };
};

module.exports = {
  validateCoachingSettings,
  mapCoachingSettingsToSpec,
  FIELD_LIBRARY
};
