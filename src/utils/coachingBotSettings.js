// Coaching/classes preset for the settings-driven bot builder
// (business_bot_settings.preset = 'coaching'). The owner describes menu
// sections and two forms in Bot Builder settings; the COURSES come from the
// business's own course list (business_courses, managed in "My courses",
// copied from the Super Admin course_catalog or added by the owner). This
// maps settings + courses to a FlowSpec v2 (flowSpecV2.js), which compiles to
// a reply-only, tappable WhatsApp flow. Pure — the caller loads the courses.
//
// Settings shape (v1):
//   {
//     version: 1,
//     welcomeMessage?: string,                           // <= 1024; the whole "hi" menu message, used as written
//     intro?: string,                                    // <= 300; only used when welcomeMessage is empty (older settings)
//     sections: {
//       fees|timings|results|material|contact: { enabled, text },
//       location: { enabled }                            // uses the shop location in Settings
//     },
//     demoForm:      { enabled, fields: [libraryKey], customFields: [ { label, type, options? } ], note?, reminder?: 'off'|'2h'|'evening' },
//     translations?: { hi?|mr?: { [textId]: { text, source } } },   // coachingTranslations.js
//     admissionForm: { enabled, fields: [libraryKey], customFields: [...], note?, targetExamOptions? }
//   }
//
// Courses passed to mapCoachingSettingsToSpec: the business's ACTIVE
// business_courses rows in display order, camelCased —
//   [ { name, description?, details, showDemoButton, showAdmissionButton } ]
//
// Reviewed decisions (v1): no course groups (max 10 active courses), no
// brochure button, no draft preview chat (compile shows structure only),
// Student name + Course always in both forms. The Course field is a dropdown
// with source 'business_courses' (flowFieldsValidation.js): its options are
// filled from the live course list when the form opens, so adding, renaming
// or hiding a course updates the forms without a re-publish.
const { validateFlowSpecV2, pageTapKeyword } = require('./flowSpecV2');
const { LIMITS } = require('./flowSpec');
const { BUSINESS_COURSES_SOURCE, COURSE_BATCHES_SOURCE } = require('./flowFieldsValidation');
const { hasPlaceholder, coursePageText } = require('./courseValidation');
const { INSTITUTE_TYPES } = require('./coachingInstitutePresets');
const { REMINDER_CHOICES } = require('./demoReminder');
const {
  BUILT_IN, FIELD_LABELS, OPTION_LABELS, FORM_TITLES, makeTranslator, validateTranslations, pickLanguages
} = require('./coachingTranslations');

const MAX_COURSES = LIMITS.MAX_LIST_ROWS;
const MAX_INTRO = 300;
const MAX_NOTE = 300;
const MAX_CUSTOM_FIELDS = 5;
const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'dropdown'];

// FAQ: a list of questions (list rows — so each question is at most a list
// row title) leading to one answer page each. The list also carries a
// "Main menu" row, hence one fewer than the WhatsApp list limit. The answer
// page shows "*question*\n\nanswer", which must fit one interactive body.
const MAX_ADMISSION_FEE = 1000000;
const MAX_FAQ_ITEMS = LIMITS.MAX_LIST_ROWS - 1;
const FAQ_QUESTION_MAX = LIMITS.LIST_ROW_TITLE;
const FAQ_ANSWER_MAX = LIMITS.INTERACTIVE_BODY - FAQ_QUESTION_MAX - 4;
const FAQ_RESERVED_TITLES = ['main menu', 'more questions'];

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
  // On the form: the chosen course's batches (Courses → batches), falling
  // back to these options when that course has none — see buildFormFields.
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
    text: 'Book a free demo class — tap the button below and fill a short form.',
    // Header of the web form page (publicServiceForm.controller.js#resolveFormTitle)
    formTitle: 'Book a free demo class', formSubtitle: 'Takes about a minute.',
    // Booking list label (bookings.form_title — see formRequestForKeyword)
    requestTitle: 'Free demo'
  },
  admission: {
    settingsKey: 'admissionForm', menuTitle: '📝 Admission', buttonTitle: 'Admission',
    keyword: 'admission', aliases: ['register'],
    text: 'Apply for admission — tap the button below and fill the form.',
    formTitle: 'Admission form', formSubtitle: 'Takes about 2 minutes.',
    requestTitle: 'Admission'
  }
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isOptionalString = (v) => v === undefined || v === null || typeof v === 'string';
const len = (v) => v.trim().length;

/**
 * Validates coaching settings. forPublish=false (saving a draft) allows an
 * incomplete setup — enabled sections without text — so an
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
  if (!isOptionalString(settings.welcomeMessage)) return 'Welcome message must be text';
  if (isNonEmptyString(settings.welcomeMessage) && len(settings.welcomeMessage) > LIMITS.INTERACTIVE_BODY) {
    return `Welcome message must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
  }

  if (settings.courses !== undefined) return 'Courses are managed in "My courses", not in bot settings';
  // Owner-typed Hindi / Marathi (coachingTranslations.js) — never blocks a publish.
  const translationsError = validateTranslations(settings.translations);
  if (translationsError) return translationsError;
  // Which "kind of institute" preset the owner started from (optional).
  if (settings.instituteType !== undefined && settings.instituteType !== null && !INSTITUTE_TYPES.includes(settings.instituteType)) {
    return `instituteType must be one of: ${INSTITUTE_TYPES.join(', ')}`;
  }
  // Presets (and catalog text) mark what to fill in with "____" — never publish one.
  if (forPublish && hasPlaceholder(settings.welcomeMessage)) return 'Welcome message: fill in the blanks (____) before publishing';

  const sections = settings.sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return 'sections must be an object';
  for (const s of SECTIONS) {
    const sec = sections[s.key];
    const label = s.title.replace(/^\S+\s/, '');
    if (!sec || typeof sec !== 'object' || typeof sec.enabled !== 'boolean') return `${label}: enabled must be true or false`;
    if (!isOptionalString(sec.text)) return `${label}: text must be text`;
    if (forPublish && sec.enabled && !isNonEmptyString(sec.text)) return `${label} is switched on but has no text`;
    if (forPublish && sec.enabled && hasPlaceholder(sec.text)) return `${label}: fill in the blanks (____) before publishing`;
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
    if (forPublish && form.enabled && hasPlaceholder(form.note)) return `${label}: fill in the blanks (____) in the note before publishing`;
    // Admission fee (optional): { enabled, amount } — asked for with the
    // payment QR when a parent submits the Admission form.
    if (form.fee !== undefined && form.fee !== null) {
      if (formKey !== 'admission') return `${label}: a fee can only be set on the Admission form`;
      if (typeof form.fee !== 'object' || Array.isArray(form.fee) || typeof form.fee.enabled !== 'boolean') return `${label}: fee.enabled must be true or false`;
      const { amount } = form.fee;
      if (amount !== undefined && amount !== null && (!Number.isInteger(amount) || amount < 1 || amount > MAX_ADMISSION_FEE)) {
        return `${label}: the admission fee must be a whole amount from ₹1 to ₹${MAX_ADMISSION_FEE.toLocaleString('en-IN')}`;
      }
      if (forPublish && form.enabled && form.fee.enabled && !(Number.isInteger(amount) && amount >= 1)) {
        return `${label}: enter the admission fee amount, or switch the fee off`;
      }
    }
    // Demo reminder (optional): 'off' | '2h' | 'evening' — sent before the
    // demo time the owner fixes (demoReminder.service.js).
    if (form.reminder !== undefined && form.reminder !== null) {
      if (formKey !== 'demo') return `${label}: a reminder can only be set on the Free demo form`;
      if (!REMINDER_CHOICES.includes(form.reminder)) return `${label}: reminder must be one of: ${REMINDER_CHOICES.join(', ')}`;
    }
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

  // FAQ is optional: settings saved before it existed have no `faq` key (= off).
  const faq = settings.faq;
  if (faq !== undefined && faq !== null) {
    if (typeof faq !== 'object' || Array.isArray(faq) || typeof faq.enabled !== 'boolean') return 'FAQ: enabled must be true or false';
    const items = faq.items === undefined ? [] : faq.items;
    if (!Array.isArray(items)) return 'FAQ: questions must be a list';
    if (items.length > MAX_FAQ_ITEMS) return `FAQ: at most ${MAX_FAQ_ITEMS} questions`;
    const seenQuestions = new Set();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const at = `FAQ question ${i + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return `${at} is invalid`;
      if (!isOptionalString(item.question) || !isOptionalString(item.answer)) return `${at}: question and answer must be text`;
      if (isNonEmptyString(item.question) && len(item.question) > FAQ_QUESTION_MAX) {
        return `${at} must be ${FAQ_QUESTION_MAX} characters or less (WhatsApp list limit) — keep it short, e.g. "Online classes?"`;
      }
      if (isNonEmptyString(item.answer) && len(item.answer) > FAQ_ANSWER_MAX) return `${at}: answer must be ${FAQ_ANSWER_MAX} characters or less`;
      if (forPublish && faq.enabled && (!isNonEmptyString(item.question) || !isNonEmptyString(item.answer))) {
        return `${at} needs both a question and an answer`;
      }
      if (forPublish && faq.enabled && (hasPlaceholder(item.question) || hasPlaceholder(item.answer))) {
        return `${at}: fill in the blanks (____) before publishing`;
      }
      if (isNonEmptyString(item.question)) {
        const key = item.question.trim().toLowerCase();
        if (FAQ_RESERVED_TITLES.includes(key)) return `${at}: "${item.question.trim()}" is used by the bot's own buttons — please reword it`;
        if (seenQuestions.has(key)) return `FAQ: "${item.question.trim()}" is listed twice`;
        seenQuestions.add(key);
      }
    }
    if (forPublish && faq.enabled && items.length === 0) return 'FAQ is switched on but has no questions — add one, or switch it off';
  }

  return null;
};

/**
 * The "hi" menu message. The owner's welcomeMessage is used exactly as
 * written; otherwise the default below (older settings only had an intro).
 * {{customerName}} / {{businessName}} are NOT filled in here — they're
 * placeholders the send path substitutes per message
 * (utils/messageTemplating.js: parent's WhatsApp name or "there"; the
 * business's display name, else its name). *text* is WhatsApp bold.
 * The Bot Builder page pre-fills its Welcome message box with this same
 * default, so keep the two in sync.
 */
const welcomeMessageFor = (settings) => {
  if (isNonEmptyString(settings.welcomeMessage)) return settings.welcomeMessage.trim();
  const intro = isNonEmptyString(settings.intro) ? ` ${settings.intro.trim()}` : '';
  return `Hello *{{customerName}}*, welcome to *{{businessName}}*!${intro}\n\nPlease choose an option:`;
};

// Course groups: courses without a group appear under this name, last.
const OTHER_COURSES_GROUP = 'Other courses';
// A groups list and each group's course list keep a back row ("Main menu" /
// "All groups"), so one fewer than the WhatsApp list limit.
const MAX_COURSE_GROUPS = LIMITS.MAX_LIST_ROWS - 1;
const MAX_COURSES_PER_GROUP = LIMITS.MAX_LIST_ROWS - 1;

/**
 * Courses grouped by their groupName for WhatsApp, or null when grouping
 * doesn't apply (fewer than 2 distinct groups — one flat list, as before
 * groups existed). Groups keep the order of their first course; ungrouped
 * courses form "Other courses", always last. Each group holds the courses'
 * indexes into `courses` (so course page ids stay course_1..course_N and
 * form prefill — courseIndexFromPageKeyword — is unaffected).
 * @returns {{ title: string, indexes: number[] }[]|null}
 */
const groupCourses = (courses) => {
  const groups = new Map();
  let other = null;
  courses.forEach((c, i) => {
    const title = isNonEmptyString(c.groupName) ? c.groupName.trim() : null;
    const key = (title || OTHER_COURSES_GROUP).toLowerCase();
    if (!title || key === OTHER_COURSES_GROUP.toLowerCase()) {
      other = other || { title: OTHER_COURSES_GROUP, indexes: [] };
      other.indexes.push(i);
      return;
    }
    if (!groups.has(key)) groups.set(key, { title, indexes: [] });
    groups.get(key).indexes.push(i);
  });
  const list = [...groups.values(), ...(other ? [other] : [])];
  return list.length >= 2 ? list : null;
};

/**
 * Publish-time checks on the business's active courses (from My courses).
 * Returns the first problem as a message, or null.
 */
const validateCoursesForPublish = (courses) => {
  if (!Array.isArray(courses) || courses.length === 0) return 'Add at least one course in "My courses" before publishing';
  const groups = groupCourses(courses);
  if (!groups && courses.length > MAX_COURSES) {
    return `WhatsApp can show at most ${MAX_COURSES} courses in one list — put them in groups, or hide some, in "My courses" (you have ${courses.length} shown)`;
  }
  if (groups && groups.length > MAX_COURSE_GROUPS) {
    return `WhatsApp can show at most ${MAX_COURSE_GROUPS} course groups — you have ${groups.length} (courses without a group count as "${OTHER_COURSES_GROUP}")`;
  }
  const crowded = groups && groups.find(g => g.indexes.length > MAX_COURSES_PER_GROUP);
  if (crowded) {
    return `Group "${crowded.title}" has ${crowded.indexes.length} courses — WhatsApp can show at most ${MAX_COURSES_PER_GROUP} in one group`;
  }
  for (const c of courses) {
    const at = `Course "${c.name}"`;
    // The page is built from the structured fields when any is set, else the
    // old free-text details (courseValidation.js#coursePageText).
    const page = coursePageText(c);
    if (!page) return `${at}: add the details page text in "My courses"`;
    if (page.length > LIMITS.INTERACTIVE_BODY) {
      return `${at}: the course page is ${page.length} characters — WhatsApp allows ${LIMITS.INTERACTIVE_BODY}. Shorten the details`;
    }
    if (hasPlaceholder(page) || hasPlaceholder(c.description)) return `${at}: fill in the blanks (____) before publishing`;
  }
  return null;
};

/**
 * The form's field list, in flowFieldsValidation.js shape: optional note
 * first, then Student name, Course, ticked library fields (library order),
 * custom questions.
 *
 * Translations (only when `t` is given and the business has languages):
 * labelTranslations { hi, mr } and optionTranslations { hi: { English: shown } }
 * — the web form shows them to a parent who chose that language; the English
 * option is still what's saved. Built-in for the Bot Builder's own questions
 * (coachingTranslations.js FIELD_LABELS / OPTION_LABELS); the note and custom
 * questions are owner slots. Course names, batches and exam names stay as typed.
 * @param {Object} form
 * @param {{ formKey: string, tr: Function, languages: string[] }} [t]
 */
const buildFormFields = (form, t) => {
  const langs = t ? t.languages : [];
  const formLabel = t ? FORMS[t.formKey].requestTitle : '';
  const withLabelTr = (field, map) => (map ? { ...field, labelTranslations: map } : field);
  const builtInOptions = (key, options) => {
    const out = {};
    for (const lang of langs) {
      const byOption = {};
      for (const o of options || []) {
        const shown = OPTION_LABELS[key] && OPTION_LABELS[key][o] && OPTION_LABELS[key][o][lang];
        if (shown) byOption[o] = shown;
      }
      if (Object.keys(byOption).length) out[lang] = byOption;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const withOptionTr = (field, map) => (map ? { ...field, optionTranslations: map } : field);

  const fields = [];
  if (isNonEmptyString(form.note)) {
    fields.push(withLabelTr({ name: 'note', label: form.note.trim(), type: 'display_text' },
      t && t.tr(`form.${t.formKey}.note`, form.note, MAX_NOTE, { group: 'Forms', label: `${formLabel} form — note at the top` })));
  }
  fields.push(withLabelTr({ name: 'studentName', label: 'Student name', type: 'text', required: true }, pickLanguages(FIELD_LABELS.studentName, langs)));
  fields.push(withLabelTr({ name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, required: true }, pickLanguages(FIELD_LABELS.course, langs)));
  for (const lib of FIELD_LIBRARY) {
    if (!form.fields.includes(lib.key)) continue;
    if (lib.key === 'batch') {
      // The picked course's batches; lib.options (Weekday / Weekend) when it has none.
      fields.push(withOptionTr(withLabelTr(
        { name: lib.key, label: lib.label, type: 'dropdown', source: COURSE_BATCHES_SOURCE, dependsOn: 'course', options: lib.options },
        pickLanguages(FIELD_LABELS.batch, langs)), builtInOptions('batch', lib.options)));
      continue;
    }
    const options = lib.key === 'targetExam' ? form.targetExamOptions.map(o => o.trim()) : lib.options;
    fields.push(withOptionTr(withLabelTr(
      { name: lib.key, label: lib.label, type: lib.type, ...(options ? { options } : {}) },
      pickLanguages(FIELD_LABELS[lib.key], langs)), lib.key === 'targetExam' ? undefined : builtInOptions(lib.key, options)));
  }
  (form.customFields || []).forEach((q, i) => {
    const at = `form.${t ? t.formKey : ''}.custom${i + 1}`;
    const question = `${formLabel} form — your question ${i + 1}`;
    let field = withLabelTr({
      name: `custom${i + 1}`, label: q.label.trim(), type: q.type,
      ...(q.type === 'dropdown' ? { options: q.options.map(o => o.trim()) } : {})
    }, t && t.tr(`${at}.label`, q.label, MAX_NOTE, { group: 'Forms', label: question }));
    if (t && q.type === 'dropdown') {
      const out = {};
      q.options.forEach((o, j) => {
        const map = t.tr(`${at}.option${j + 1}`, o, MAX_NOTE, { group: 'Forms', label: `${question} — choice ${j + 1}` });
        for (const [lang, shown] of Object.entries(map || {})) (out[lang] = out[lang] || {})[o.trim()] = shown;
      });
      // Two choices that read the same in a language: show both in English.
      for (const lang of Object.keys(out)) {
        const shownCount = {};
        Object.values(out[lang]).forEach(s => { shownCount[s.trim().toLowerCase()] = (shownCount[s.trim().toLowerCase()] || 0) + 1; });
        for (const [o, s] of Object.entries(out[lang])) if (shownCount[s.trim().toLowerCase()] > 1) delete out[lang][o];
        if (!Object.keys(out[lang]).length) delete out[lang];
      }
      field = withOptionTr(field, Object.keys(out).length ? out : undefined);
    }
    fields.push(field);
  });
  return fields;
};

/**
 * Maps publish-ready coaching settings + the business's active courses to a
 * FlowSpec v2. Returns { spec, error } — error is a settings/course-level
 * message, or (last resort) a FlowSpec-level one; spec is null whenever
 * error is set. Course pages get index-based ids (course_1..course_N, in
 * course order, grouped or not) — they're rebuilt on every publish, so they
 * needn't match course row ids. With 2+ course groups (groupCourses), the
 * Courses page lists the groups and each group gets its own list page.
 *
 * Translations (coachingTranslations.js): for each of `languages` (the
 * business's enabled languages other than English) every text also gets the
 * owner's / built-in translation from settings.translations when it is
 * usable — spec texts carry textTranslations / titleTranslations /
 * descriptionTranslations / buttonTextTranslations. The English spec is
 * exactly what it was without translations.
 * @param {Object} settings
 * @param {{ businessName: string, courses: Object[], languages?: string[] }} context
 *   courses may carry `id` (business_courses.id) — the key of their translations
 * @returns {{ spec: Object|null, error: string|null, translation?: { slots: Object[], report: Object } }}
 */
const mapCoachingSettingsToSpec = (settings, { businessName, courses, languages = [] } = {}) => {
  if (!isNonEmptyString(businessName)) return { spec: null, error: 'businessName is required' };
  const settingsError = validateCoachingSettings(settings, { forPublish: true });
  if (settingsError) return { spec: null, error: settingsError };
  const coursesError = validateCoursesForPublish(courses);
  if (coursesError) return { spec: null, error: coursesError };
  const formEnabled = (key) => settings[FORMS[key].settingsKey].enabled;
  const { tr, fixed, fit, slots, report } = makeTranslator(settings.translations, languages);
  const withTr = (obj, key, map) => (map ? { ...obj, [key]: map } : obj);
  const BUTTON = LIMITS.BUTTON_TITLE;
  const ROW = LIMITS.LIST_ROW_TITLE;
  const BODY = LIMITS.INTERACTIVE_BODY;
  const MENU_GROUP = { group: 'Menu & buttons' };

  const fixedChoice = (id, target, max = BUTTON) => {
    const f = fixed(id, null, max, { ...MENU_GROUP, label: BUILT_IN[id].en });
    return withTr({ title: f.text, target }, 'titleTranslations', f.translations);
  };
  const formButton = (key) => fixedChoice(`fixed.button.${key}`, { type: 'form', id: key });
  const mainMenu = () => fixedChoice('fixed.button.mainMenu', { type: 'menu' });
  // Menu items: the limit (button or list row) is only known once the menu is complete.
  const menuItem = (id, target) => fixedChoice(id, target, ROW);

  const pages = [];
  const forms = [];
  const menu = [];

  // Courses: a list page for 2+ courses, straight to the course page for 1.
  const courseKey = (c, i) => `course.${c.id || `n${i + 1}`}`;
  courses.forEach((c, i) => {
    const buttons = [];
    if (c.showDemoButton && formEnabled('demo')) buttons.push(formButton('demo'));
    if (c.showAdmissionButton && formEnabled('admission')) buttons.push(formButton('admission'));
    buttons.push(mainMenu());
    const text = coursePageText(c);
    pages.push(withTr({
      id: `course_${i + 1}`, text, buttons,
      // Course photo, sent above the course page (business_courses.image_media_id)
      ...(c.imageMediaId ? { mediaId: c.imageMediaId } : {})
    }, 'textTranslations', tr(`${courseKey(c, i)}.page`, text, BODY, { group: 'Courses', label: `${c.name.trim()} — course page` })));
  });
  const courseRow = (i) => {
    const c = courses[i];
    const hasDescription = isNonEmptyString(c.description);
    let row = withTr({
      title: c.name.trim(),
      ...(hasDescription ? { description: c.description.trim() } : {}),
      target: { type: 'page', id: `course_${i + 1}` }
    }, 'titleTranslations', tr(`${courseKey(c, i)}.name`, c.name, ROW, { group: 'Courses', label: `${c.name.trim()} — name in the list` }));
    if (hasDescription) {
      row = withTr(row, 'descriptionTranslations', tr(`${courseKey(c, i)}.description`, c.description, LIMITS.LIST_ROW_DESCRIPTION, { group: 'Courses', label: `${c.name.trim()} — short line in the list` }));
    }
    return row;
  };
  const groups = groupCourses(courses);
  if (groups) {
    // Courses → groups → that group's courses → course page.
    const allGroups = fixedChoice('fixed.button.allGroups', { type: 'page', id: 'courses' });
    groups.forEach((g, gi) => {
      const list = g.indexes.map(courseRow);
      list.push(allGroups);
      if (list.length < LIMITS.MAX_LIST_ROWS) list.push(mainMenu());
      const pageText = fixed('fixed.page.group', { group: g.title }, BODY, { ...MENU_GROUP, label: `Group "${g.title}" — page text` });
      pages.push(withTr({ id: `group_${gi + 1}`, text: pageText.text, list }, 'textTranslations', pageText.translations));
    });
    const groupList = groups.map((g, gi) => {
      const count = fixed(g.indexes.length === 1 ? 'fixed.page.groupCountOne' : 'fixed.page.groupCountMany', { count: g.indexes.length }, LIMITS.LIST_ROW_DESCRIPTION, { ...MENU_GROUP, label: `"${g.indexes.length} courses" under a group` });
      let row = withTr({ title: g.title, description: count.text, target: { type: 'page', id: `group_${gi + 1}` } },
        'titleTranslations', tr(`group.${g.title.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}.title`, g.title, ROW, { group: 'Courses', label: `Group "${g.title}" — name` }));
      row = withTr(row, 'descriptionTranslations', count.translations);
      return row;
    });
    groupList.push(mainMenu());
    const pageText = fixed('fixed.page.courseGroups', null, BODY, { ...MENU_GROUP, label: 'Courses page (groups)' });
    pages.push(withTr({ id: 'courses', text: pageText.text, keyword: 'course', list: groupList }, 'textTranslations', pageText.translations));
    menu.push(menuItem('fixed.menu.courses', { type: 'page', id: 'courses' }));
  } else if (courses.length >= 2) {
    const list = courses.map((_, i) => courseRow(i));
    if (list.length < LIMITS.MAX_LIST_ROWS) list.push(mainMenu());
    const pageText = fixed('fixed.page.courses', null, BODY, { ...MENU_GROUP, label: 'Courses page' });
    pages.push(withTr({ id: 'courses', text: pageText.text, keyword: 'course', list }, 'textTranslations', pageText.translations));
    menu.push(menuItem('fixed.menu.courses', { type: 'page', id: 'courses' }));
  } else {
    pages[0].keyword = 'course';
    menu.push(menuItem('fixed.menu.courses', { type: 'page', id: 'course_1' }));
  }

  const sectionMenu = (key) => {
    const s = SECTIONS.find(x => x.key === key);
    const sec = settings.sections[key];
    if (!sec.enabled) return;
    const buttons = [];
    if (s.formButton && formEnabled(s.formButton)) buttons.push(formButton(s.formButton));
    buttons.push(mainMenu());
    const text = sec.text.trim();
    pages.push(withTr({ id: key, text, keyword: s.keyword, aliases: s.aliases, buttons },
      'textTranslations', tr(`section.${key}`, text, BODY, { group: 'Sections', label: s.title })));
    menu.push(menuItem(`fixed.menu.${key}`, { type: 'page', id: key }));
  };
  const formMenu = (key) => {
    if (!formEnabled(key)) return;
    const meta = FORMS[key];
    const text = fixed(`fixed.form.${key}`, null, BODY, { group: 'Forms', label: `${meta.requestTitle} — message with the form link` });
    const buttonText = fixed('fixed.button.fillForm', null, BUTTON, { ...MENU_GROUP, label: BUILT_IN['fixed.button.fillForm'].en });
    let form = withTr({
      id: key, text: text.text, buttonText: buttonText.text, keyword: meta.keyword, aliases: meta.aliases,
      fields: buildFormFields(settings[meta.settingsKey], { formKey: key, tr, languages })
    }, 'textTranslations', text.translations);
    form = withTr(form, 'buttonTextTranslations', buttonText.translations);
    forms.push(form);
    menu.push(menuItem(`fixed.menu.${key}`, { type: 'form', id: key }));
  };

  ['fees', 'timings', 'results', 'material'].forEach(sectionMenu);
  formMenu('demo');
  formMenu('admission');
  let location = null;
  if (settings.sections.location.enabled) {
    location = { keyword: 'location' };
    menu.push(menuItem('fixed.menu.location', { type: 'location' }));
  }
  // FAQ: a question list (typed "faqs"/"doubt"; "faq" reaches it by close
  // spelling — typed keywords must be 4+ characters) → one answer page each.
  if (settings.faq && settings.faq.enabled) {
    const moreQuestions = fixedChoice('fixed.button.moreQuestions', { type: 'page', id: 'faq' });
    const questionTr = settings.faq.items.map((item, i) =>
      tr(`faq.${i + 1}.question`, item.question, FAQ_QUESTION_MAX, { group: 'FAQ', label: `FAQ ${i + 1} — question` }));
    settings.faq.items.forEach((item, i) => {
      // The answer page shows "*question*\n\nanswer" — translated only when both are.
      const answerTr = tr(`faq.${i + 1}.answer`, item.answer, FAQ_ANSWER_MAX, { group: 'FAQ', label: `FAQ ${i + 1} — answer` });
      const pageTr = {};
      for (const lang of Object.keys(answerTr || {})) {
        if (questionTr[i] && questionTr[i][lang]) pageTr[lang] = `*${questionTr[i][lang]}*\n\n${answerTr[lang]}`;
      }
      pages.push(withTr({
        id: `faq_${i + 1}`,
        text: `*${item.question.trim()}*\n\n${item.answer.trim()}`,
        buttons: [moreQuestions, ...(formEnabled('demo') ? [formButton('demo')] : []), mainMenu()]
      }, 'textTranslations', Object.keys(pageTr).length ? pageTr : undefined));
    });
    const list = settings.faq.items.map((item, i) => withTr({ title: item.question.trim(), target: { type: 'page', id: `faq_${i + 1}` } }, 'titleTranslations', questionTr[i]));
    list.push(mainMenu());
    const pageText = fixed('fixed.page.faq', null, BODY, { ...MENU_GROUP, label: 'FAQ list page' });
    pages.push(withTr({ id: 'faq', text: pageText.text, keyword: 'faqs', aliases: ['doubt'], list }, 'textTranslations', pageText.translations));
    menu.push(menuItem('fixed.menu.faq', { type: 'page', id: 'faq' }));
  }
  sectionMenu('contact');

  // A menu of 3 or fewer items is sent as buttons (20 characters each).
  if (menu.length <= LIMITS.MAX_BUTTONS) {
    menu.forEach((m) => { if (m.titleTranslations) m.titleTranslations = fit(m.titleTranslations, BUTTON, m.title); if (!m.titleTranslations) delete m.titleTranslations; });
  }
  // Two choices in one message may not read the same in a language.
  const dedupe = (choices) => {
    for (const lang of languages) {
      const seen = new Map();
      choices.forEach((c) => {
        const t = c.titleTranslations && c.titleTranslations[lang];
        if (!t) return;
        const k = t.trim().toLowerCase();
        seen.set(k, [...(seen.get(k) || []), c]);
      });
      for (const same of seen.values()) {
        if (same.length < 2) continue;
        same.forEach((c) => { delete c.titleTranslations[lang]; if (!Object.keys(c.titleTranslations).length) delete c.titleTranslations; });
      }
    }
  };
  // Choices are shared objects (mainMenu() / formButton() make fresh ones; allGroups and
  // moreQuestions are reused) — copy before de-duplicating per page.
  const own = (choices) => choices.map(c => ({ ...c, ...(c.titleTranslations ? { titleTranslations: { ...c.titleTranslations } } : {}) }));
  dedupe(menu);
  pages.forEach((p) => {
    if (p.buttons) { p.buttons = own(p.buttons); dedupe(p.buttons); }
    if (p.list) { p.list = own(p.list); dedupe(p.list); }
  });

  const welcome = welcomeMessageFor(settings);
  const spec = {
    version: 2,
    greeting: withTr({ text: welcome }, 'textTranslations', tr('welcome', welcome, BODY, { group: 'Welcome', label: 'Welcome message (the menu)' })),
    menu,
    pages,
    forms,
    ...(location ? { location } : {})
  };
  const specError = validateFlowSpecV2(spec);
  if (specError) return { spec: null, error: `The generated flow is invalid: ${specError}` };
  return { spec, error: null, translation: { slots: slots(), report } };
};

/**
 * Reverse of the course page ids above: a published course page node's
 * keyword (flowSpecV2 pageTapKeyword(`course_${i + 1}`)) → i, the course's
 * index in the published course list (business_bot_settings
 * .published_settings.courses). null for any other keyword — including a
 * single-course business, whose only course page takes the 'course' keyword.
 * Used to pre-select the course in a form opened from that page
 * (publicServiceForm.controller.js).
 */
const courseIndexFromPageKeyword = (keyword) => {
  const prefix = pageTapKeyword('course_');
  if (typeof keyword !== 'string' || !keyword.startsWith(prefix)) return null;
  const n = keyword.slice(prefix.length);
  return /^[1-9]\d*$/.test(n) ? Number(n) - 1 : null;
};

/**
 * Web form page header for a published Bot Builder form node, by its
 * keyword (the form's own keyword — flowSpecV2 gives a form node its
 * keyword, not form_<id>, when it has one). { title, subtitle } or null for
 * any other keyword. The caller must also check the business actually
 * published Bot Builder settings, so a hand-built 'demo' node elsewhere
 * doesn't pick this up. languageCode: the parent's preferred_language —
 * built-in Hindi / Marathi titles (coachingTranslations.js FORM_TITLES).
 */
const formTitleForKeyword = (keyword, languageCode = null) => {
  const entry = Object.entries(FORMS).find(([, f]) => f.keyword === keyword);
  if (!entry) return null;
  const [key, meta] = entry;
  const tr = FORM_TITLES[key] || {};
  return {
    title: (tr.title && tr.title[languageCode]) || meta.formTitle,
    subtitle: (tr.subtitle && tr.subtitle[languageCode]) || meta.formSubtitle
  };
};

/**
 * Which Bot Builder form a form node is, by its keyword: { key: 'demo' |
 * 'admission', title: 'Free demo' | 'Admission' } or null. Saved on the
 * booking at submit (bookings.form_key / form_title) so the owner can tell
 * requests apart. Same caller caveat as formTitleForKeyword: check the
 * business published Bot Builder settings.
 */
const formRequestForKeyword = (keyword) => {
  const entry = Object.entries(FORMS).find(([, f]) => f.keyword === keyword);
  return entry ? { key: entry[0], title: entry[1].requestTitle } : null;
};

/**
 * The payment a submitted Bot Builder form asks for, from the PUBLISHED
 * settings (so a draft change waits for Publish): the Admission form's fee
 * when switched on → { amount, purpose: 'admission' }; anything else → null
 * (no payment — a Bot Builder form never uses the business-wide advance).
 * Passed to booking.service.js#createBookingAndConfirmation as formMeta.advance.
 * @param {Object|null} publishedSettings - business_bot_settings.published_settings.settings
 * @param {'demo'|'admission'} formKey
 */
const formPaymentFor = (publishedSettings, formKey) => {
  if (formKey !== 'admission') return null;
  const form = publishedSettings && publishedSettings.admissionForm;
  const fee = form && form.fee;
  if (!form || !form.enabled || !fee || !fee.enabled || !Number.isInteger(fee.amount) || fee.amount < 1) return null;
  return { amount: fee.amount, purpose: 'admission' };
};

/**
 * The Free demo reminder from the PUBLISHED settings: '2h' | 'evening', or
 * null when off / the demo form is off / never published.
 * @param {Object|null} publishedSettings - business_bot_settings.published_settings.settings
 */
const demoReminderFor = (publishedSettings) => {
  const form = publishedSettings && publishedSettings.demoForm;
  if (!form || !form.enabled || !form.reminder || form.reminder === 'off') return null;
  return REMINDER_CHOICES.includes(form.reminder) ? form.reminder : null;
};

module.exports = {
  validateCoachingSettings,
  validateCoursesForPublish,
  mapCoachingSettingsToSpec,
  courseIndexFromPageKeyword,
  formTitleForKeyword,
  formRequestForKeyword,
  formPaymentFor,
  demoReminderFor,
  FIELD_LIBRARY
};
