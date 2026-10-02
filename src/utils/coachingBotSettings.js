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
//     demoForm:      { enabled, fields: [libraryKey], customFields: [ { label, type, options? } ], note? },
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

const MAX_COURSES = LIMITS.MAX_LIST_ROWS;
const MAX_INTRO = 300;
const MAX_NOTE = 300;
const MAX_CUSTOM_FIELDS = 5;
const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'dropdown'];

// FAQ: a list of questions (list rows — so each question is at most a list
// row title) leading to one answer page each. The list also carries a
// "Main menu" row, hence one fewer than the WhatsApp list limit. The answer
// page shows "*question*\n\nanswer", which must fit one interactive body.
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
const FORM_BUTTON_TEXT = 'Fill form';
const MAIN_MENU = { title: 'Main menu', target: { type: 'menu' } };

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
 */
const buildFormFields = (form) => {
  const fields = [];
  if (isNonEmptyString(form.note)) fields.push({ name: 'note', label: form.note.trim(), type: 'display_text' });
  fields.push({ name: 'studentName', label: 'Student name', type: 'text', required: true });
  fields.push({ name: 'course', label: 'Course', type: 'dropdown', source: BUSINESS_COURSES_SOURCE, required: true });
  for (const lib of FIELD_LIBRARY) {
    if (!form.fields.includes(lib.key)) continue;
    if (lib.key === 'batch') {
      // The picked course's batches; lib.options (Weekday / Weekend) when it has none.
      fields.push({ name: lib.key, label: lib.label, type: 'dropdown', source: COURSE_BATCHES_SOURCE, dependsOn: 'course', options: lib.options });
      continue;
    }
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
 * Maps publish-ready coaching settings + the business's active courses to a
 * FlowSpec v2. Returns { spec, error } — error is a settings/course-level
 * message, or (last resort) a FlowSpec-level one; spec is null whenever
 * error is set. Course pages get index-based ids (course_1..course_N, in
 * course order, grouped or not) — they're rebuilt on every publish, so they
 * needn't match course row ids. With 2+ course groups (groupCourses), the
 * Courses page lists the groups and each group gets its own list page.
 * @param {Object} settings
 * @param {{ businessName: string, courses: Object[] }} context
 * @returns {{ spec: Object|null, error: string|null }}
 */
const mapCoachingSettingsToSpec = (settings, { businessName, courses } = {}) => {
  if (!isNonEmptyString(businessName)) return { spec: null, error: 'businessName is required' };
  const settingsError = validateCoachingSettings(settings, { forPublish: true });
  if (settingsError) return { spec: null, error: settingsError };
  const coursesError = validateCoursesForPublish(courses);
  if (coursesError) return { spec: null, error: coursesError };
  const formEnabled = (key) => settings[FORMS[key].settingsKey].enabled;
  const formButton = (key) => ({ title: FORMS[key].buttonTitle, target: { type: 'form', id: key } });

  const pages = [];
  const forms = [];
  const menu = [];

  // Courses: a list page for 2+ courses, straight to the course page for 1.
  courses.forEach((c, i) => {
    const buttons = [];
    if (c.showDemoButton && formEnabled('demo')) buttons.push(formButton('demo'));
    if (c.showAdmissionButton && formEnabled('admission')) buttons.push(formButton('admission'));
    buttons.push(MAIN_MENU);
    pages.push({
      id: `course_${i + 1}`, text: coursePageText(c), buttons,
      // Course photo, sent above the course page (business_courses.image_media_id)
      ...(c.imageMediaId ? { mediaId: c.imageMediaId } : {})
    });
  });
  const courseRow = (i) => ({
    title: courses[i].name.trim(),
    ...(isNonEmptyString(courses[i].description) ? { description: courses[i].description.trim() } : {}),
    target: { type: 'page', id: `course_${i + 1}` }
  });
  const groups = groupCourses(courses);
  if (groups) {
    // Courses → groups → that group's courses → course page.
    const allGroups = { title: 'All groups', target: { type: 'page', id: 'courses' } };
    groups.forEach((g, gi) => {
      const list = g.indexes.map(courseRow);
      list.push(allGroups);
      if (list.length < LIMITS.MAX_LIST_ROWS) list.push(MAIN_MENU);
      pages.push({ id: `group_${gi + 1}`, text: `${g.title} — tap a course to see the details:`, list });
    });
    const groupList = groups.map((g, gi) => ({
      title: g.title,
      description: `${g.indexes.length} course${g.indexes.length === 1 ? '' : 's'}`,
      target: { type: 'page', id: `group_${gi + 1}` }
    }));
    groupList.push(MAIN_MENU);
    pages.push({ id: 'courses', text: 'Our courses — choose a group:', keyword: 'course', list: groupList });
    menu.push({ title: '📚 Courses', target: { type: 'page', id: 'courses' } });
  } else if (courses.length >= 2) {
    const list = courses.map((_, i) => courseRow(i));
    if (list.length < LIMITS.MAX_LIST_ROWS) list.push(MAIN_MENU);
    pages.push({ id: 'courses', text: 'Our courses — tap one to see the details:', keyword: 'course', list });
    menu.push({ title: '📚 Courses', target: { type: 'page', id: 'courses' } });
  } else {
    pages[0].keyword = 'course';
    menu.push({ title: '📚 Courses', target: { type: 'page', id: 'course_1' } });
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
      fields: buildFormFields(settings[meta.settingsKey])
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
  // FAQ: a question list (typed "faqs"/"doubt"; "faq" reaches it by close
  // spelling — typed keywords must be 4+ characters) → one answer page each.
  if (settings.faq && settings.faq.enabled) {
    const moreQuestions = { title: 'More questions', target: { type: 'page', id: 'faq' } };
    settings.faq.items.forEach((item, i) => {
      pages.push({
        id: `faq_${i + 1}`,
        text: `*${item.question.trim()}*\n\n${item.answer.trim()}`,
        buttons: [moreQuestions, ...(formEnabled('demo') ? [formButton('demo')] : []), MAIN_MENU]
      });
    });
    const list = settings.faq.items.map((item, i) => ({ title: item.question.trim(), target: { type: 'page', id: `faq_${i + 1}` } }));
    list.push(MAIN_MENU);
    pages.push({ id: 'faq', text: 'Common questions — tap one to see the answer:', keyword: 'faqs', aliases: ['doubt'], list });
    menu.push({ title: '❓ FAQ', target: { type: 'page', id: 'faq' } });
  }
  sectionMenu('contact');

  const spec = {
    version: 2,
    greeting: { text: welcomeMessageFor(settings) },
    menu,
    pages,
    forms,
    ...(location ? { location } : {})
  };
  const specError = validateFlowSpecV2(spec);
  if (specError) return { spec: null, error: `The generated flow is invalid: ${specError}` };
  return { spec, error: null };
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
 * doesn't pick this up.
 */
const formTitleForKeyword = (keyword) => {
  const meta = Object.values(FORMS).find(f => f.keyword === keyword);
  return meta ? { title: meta.formTitle, subtitle: meta.formSubtitle } : null;
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

module.exports = {
  validateCoachingSettings,
  validateCoursesForPublish,
  mapCoachingSettingsToSpec,
  courseIndexFromPageKeyword,
  formTitleForKeyword,
  formRequestForKeyword,
  FIELD_LIBRARY
};
