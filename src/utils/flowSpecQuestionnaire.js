// Deterministic questionnaire -> FlowSpec v1 mapper (AI flow generation,
// Phase 1 — no LLM). Pure, same as flowSpec.js: the endpoint passes in the
// business name from the business row; everything else comes from the
// owner's answers. validateFlowSpec (flowSpec.js) still runs on the result
// as the final gate — this module only adds checks it can phrase in terms
// of the answers the owner actually typed.
//
// Answers shape (v1):
//   {
//     version: 1,
//     intro?: string,                                      // <= 300
//     services?: [ { name, price?, description? } ],       // 0..10, shown as ONE FAQ
//     hours?: string,
//     address?: { text?, showMapPin? },
//     booking?: { enabled, keyword?, intro?, fields: [ { label, type, options?, required? } ] },
//     payment?: { text },
//     contact?: { text },
//     faqs?: [ { title, answer, keyword? } ]              // 0..10; title <= 20 always
//   }
//
// Phase 1 decisions (reviewed): fixed menu titles/keywords are English
// only; hours/address are answers only (no prefill from the business row
// yet); services are one FAQ, not one menu row each.
const { validateFlowSpec, RESERVED_FIELD_KEYS, LIMITS } = require('./flowSpec');

const MAX_INTRO = 300;
const MAX_SERVICES = 10;
const MAX_FAQS = 10;
const FAQ_TITLE_MAX = LIMITS.BUTTON_TITLE; // always 20, even when the menu ends up a list
const FIELD_TYPES = ['text', 'choice', 'location'];
const MAX_KEY_BASE = 36; // leaves room for a numeric suffix within flowSpec.js's 40-char key limit

// Fixed menu entries, in menu order. Titles all <= 20 so they fit either
// menu form.
const FIXED = {
  booking: { menuId: 'book', title: 'Book now', defaultKeyword: 'book' },
  services: { faqId: 'services', title: 'Services & fees', keyword: 'services', aliases: ['price', 'rates'] },
  hours: { faqId: 'timings', title: 'Timings', keyword: 'timings', aliases: ['hours'] },
  address: { faqId: 'address', title: 'Address', keyword: 'address', aliases: [] },
  map: { menuId: 'map', title: 'Find us on map' },
  payment: { menuId: 'payment', title: 'Payment', keyword: 'payment' },
  contact: { menuId: 'contact', title: 'Talk to us', keyword: 'contact' }
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isOptionalString = (v) => v === undefined || v === null || typeof v === 'string';

/**
 * camelCase key from a field label: ASCII letters/digits only, first word
 * lowercased, later words capitalized ("Phone Number:" -> "phoneNumber").
 * No usable characters (e.g. a Devanagari-only label) -> "field"; a leading
 * digit gets a "field" prefix so the key still starts with a letter.
 */
const labelToKeyBase = (label) => {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'field';
  let key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  if (/^[0-9]/.test(key)) key = `field${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  return key.slice(0, MAX_KEY_BASE);
};

/**
 * Collision rule: never reject — a key already taken by an earlier field,
 * or reserved by the booking engine, gets the lowest numeric suffix from 2
 * up that is free ("phoneNumber", "phoneNumber2", "phoneNumber3"; reserved
 * "vehicleFare" -> "vehicleFare2"). Keys are internal (the owner only ever
 * sees labels), so a suffix is always preferable to failing the whole form.
 * @param {string[]} labels
 * @returns {string[]}
 */
const generateFieldKeys = (labels) => {
  const used = new Set();
  return labels.map(label => {
    const base = labelToKeyBase(label);
    let key = base;
    for (let n = 2; used.has(key) || RESERVED_FIELD_KEYS.includes(key); n++) key = `${base}${n}`;
    used.add(key);
    return key;
  });
};

/**
 * Validates questionnaire answers. Returns the first problem as a message
 * phrased in terms of the answers, or null. Limits that depend on the
 * assembled flow (e.g. the combined services text) are checked in
 * mapAnswersToFlowSpec, after assembly.
 * @param {Object} answers
 * @returns {string|null}
 */
const validateQuestionnaireAnswers = (answers) => {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return 'answers must be an object';
  if (answers.version !== 1) return 'answers.version must be 1';

  if (!isOptionalString(answers.intro)) return 'intro must be a string';
  if (isNonEmptyString(answers.intro) && answers.intro.trim().length > MAX_INTRO) {
    return `intro must be ${MAX_INTRO} characters or less`;
  }

  if (answers.services !== undefined && answers.services !== null) {
    if (!Array.isArray(answers.services)) return 'services must be a list';
    if (answers.services.length > MAX_SERVICES) return `services may have at most ${MAX_SERVICES} entries`;
    for (let i = 0; i < answers.services.length; i++) {
      const s = answers.services[i];
      if (!s || !isNonEmptyString(s.name)) return `services[${i}].name is required`;
      if (!isOptionalString(s.price) || !isOptionalString(s.description)) {
        return `services[${i}].price and description must be text`;
      }
    }
  }

  if (!isOptionalString(answers.hours)) return 'hours must be text';

  if (answers.address !== undefined && answers.address !== null) {
    const a = answers.address;
    if (typeof a !== 'object' || Array.isArray(a)) return 'address must be an object';
    if (!isOptionalString(a.text)) return 'address.text must be text';
    if (a.showMapPin !== undefined && typeof a.showMapPin !== 'boolean') return 'address.showMapPin must be true or false';
  }

  const booking = answers.booking;
  if (booking !== undefined && booking !== null) {
    if (typeof booking !== 'object' || typeof booking.enabled !== 'boolean') return 'booking.enabled must be true or false';
    if (booking.enabled) {
      if (!isOptionalString(booking.keyword) || !isOptionalString(booking.intro)) return 'booking.keyword and booking.intro must be text';
      if (!Array.isArray(booking.fields) || booking.fields.length === 0) return 'booking needs at least one question';
      if (booking.fields.length > LIMITS.MAX_BOOKING_FIELDS) return `booking may have at most ${LIMITS.MAX_BOOKING_FIELDS} questions`;
      for (let i = 0; i < booking.fields.length; i++) {
        const f = booking.fields[i];
        const at = `booking.fields[${i}]`;
        if (!f || !isNonEmptyString(f.label)) return `${at}.label is required`;
        if (!FIELD_TYPES.includes(f.type)) return `${at}.type must be one of: ${FIELD_TYPES.join(', ')}`;
        if (f.required !== undefined && typeof f.required !== 'boolean') return `${at}.required must be true or false`;
        if (f.type === 'choice') {
          if (!Array.isArray(f.options) || f.options.length < 2 || f.options.some(o => !isNonEmptyString(o))) {
            return `${at} is a choice and needs at least 2 non-empty options`;
          }
          if (f.options.length > LIMITS.MAX_LIST_ROWS) return `${at} may have at most ${LIMITS.MAX_LIST_ROWS} options`;
          const optMax = f.options.length <= LIMITS.MAX_BUTTONS ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
          const tooLong = f.options.find(o => o.trim().length > optMax);
          if (tooLong) return `${at} option "${tooLong}" must be ${optMax} characters or less`;
          const seen = new Set();
          for (const o of f.options) {
            const k = o.trim().toLowerCase();
            if (seen.has(k)) return `${at} has the option "${o}" twice`;
            seen.add(k);
          }
        } else if (f.options !== undefined && f.options !== null && !(Array.isArray(f.options) && f.options.length === 0)) {
          return `${at}.options is only allowed for a choice question`;
        }
      }
    }
  }

  for (const name of ['payment', 'contact']) {
    const block = answers[name];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object' || !isNonEmptyString(block.text)) return `${name}.text is required when ${name} is given`;
  }

  const fixedTitles = new Set(Object.values(FIXED).map(f => f.title.toLowerCase()));
  if (answers.faqs !== undefined && answers.faqs !== null) {
    if (!Array.isArray(answers.faqs)) return 'faqs must be a list';
    if (answers.faqs.length > MAX_FAQS) return `faqs may have at most ${MAX_FAQS} entries`;
    const titles = new Set();
    for (let i = 0; i < answers.faqs.length; i++) {
      const q = answers.faqs[i];
      if (!q || !isNonEmptyString(q.title)) return `faqs[${i}].title is required`;
      if (q.title.trim().length > FAQ_TITLE_MAX) return `faqs[${i}].title must be ${FAQ_TITLE_MAX} characters or less`;
      const t = q.title.trim().toLowerCase();
      if (fixedTitles.has(t) || titles.has(t)) return `faqs[${i}].title "${q.title}" is already used by another menu item`;
      titles.add(t);
      if (!isNonEmptyString(q.answer)) return `faqs[${i}].answer is required`;
      if (!isOptionalString(q.keyword)) return `faqs[${i}].keyword must be text`;
    }
  }

  return null;
};

const buildServicesAnswer = (services) => ['Our services:', ...services.map(s => {
  let line = `• ${s.name.trim()}`;
  if (isNonEmptyString(s.price)) line += ` — ${s.price.trim()}`;
  if (isNonEmptyString(s.description)) line += `\n  ${s.description.trim()}`;
  return line;
})].join('\n');

/**
 * Maps validated questionnaire answers to a FlowSpec v1. Returns
 * { spec, error } — error is an answers-level or (last resort) FlowSpec-
 * level message, spec is null whenever error is set.
 * @param {Object} answers
 * @param {{ businessName: string }} context - from the business row
 * @returns {{ spec: Object|null, error: string|null }}
 */
const mapAnswersToFlowSpec = (answers, { businessName } = {}) => {
  if (!isNonEmptyString(businessName)) return { spec: null, error: 'businessName is required' };
  const answersError = validateQuestionnaireAnswers(answers);
  if (answersError) return { spec: null, error: answersError };

  const faqs = [];
  const menu = [];
  const spec = { version: 1, greeting: null, menu, faqs };

  const intro = isNonEmptyString(answers.intro) ? ` ${answers.intro.trim()}` : '';
  spec.greeting = { text: `Welcome to ${businessName.trim()}!${intro}\n\nPlease choose an option:` };

  const booking = answers.booking;
  if (booking && booking.enabled) {
    const keys = generateFieldKeys(booking.fields.map(f => f.label));
    spec.booking = {
      keyword: isNonEmptyString(booking.keyword) ? booking.keyword.trim() : FIXED.booking.defaultKeyword,
      intro: isNonEmptyString(booking.intro) ? booking.intro.trim() : null,
      fields: booking.fields.map((f, i) => ({
        key: keys[i],
        label: f.label.trim(),
        type: f.type,
        required: f.required !== undefined ? f.required : true,
        ...(f.type === 'choice' ? { options: f.options.map(o => ({ value: o.trim(), label: o.trim() })) } : {})
      }))
    };
    menu.push({ id: FIXED.booking.menuId, title: FIXED.booking.title, action: { type: 'booking' } });
  }

  const addFixedFaq = (fixed, answer) => {
    faqs.push({ id: fixed.faqId, keyword: fixed.keyword, aliases: fixed.aliases, answer, backToMenu: true });
    menu.push({ id: fixed.faqId, title: fixed.title, action: { type: 'faq', faqId: fixed.faqId } });
  };
  if (Array.isArray(answers.services) && answers.services.length > 0) {
    const text = buildServicesAnswer(answers.services);
    if (text.length > LIMITS.INTERACTIVE_BODY) {
      return { spec: null, error: `services: the combined list is ${text.length} characters; WhatsApp allows ${LIMITS.INTERACTIVE_BODY} — shorten names or descriptions` };
    }
    addFixedFaq(FIXED.services, text);
  }
  if (isNonEmptyString(answers.hours)) {
    if (answers.hours.trim().length > LIMITS.INTERACTIVE_BODY) return { spec: null, error: `hours must be ${LIMITS.INTERACTIVE_BODY} characters or less` };
    addFixedFaq(FIXED.hours, answers.hours.trim());
  }
  if (answers.address && isNonEmptyString(answers.address.text)) {
    if (answers.address.text.trim().length > LIMITS.INTERACTIVE_BODY) return { spec: null, error: `address.text must be ${LIMITS.INTERACTIVE_BODY} characters or less` };
    addFixedFaq(FIXED.address, answers.address.text.trim());
  }
  if (answers.address && answers.address.showMapPin) {
    menu.push({ id: FIXED.map.menuId, title: FIXED.map.title, action: { type: 'location' } });
  }
  for (const name of ['payment', 'contact']) {
    if (!answers[name]) continue;
    spec[name] = { keyword: FIXED[name].keyword, text: answers[name].text.trim() };
    menu.push({ id: FIXED[name].menuId, title: FIXED[name].title, action: { type: name } });
  }

  // Custom FAQs fill the remaining menu rows in order; any that don't fit
  // are keyword-only and so must have a keyword.
  (answers.faqs || []).forEach((q, i) => {
    const id = `custom_${i + 1}`;
    const inMenu = menu.length < LIMITS.MAX_LIST_ROWS;
    faqs.push({
      id,
      ...(isNonEmptyString(q.keyword) ? { keyword: q.keyword.trim() } : {}),
      answer: q.answer.trim(),
      backToMenu: true
    });
    if (inMenu) menu.push({ id, title: q.title.trim(), action: { type: 'faq', faqId: id } });
  });
  const overflow = (answers.faqs || []).findIndex((q, i) => !menu.some(m => m.id === `custom_${i + 1}`) && !isNonEmptyString(q.keyword));
  if (overflow !== -1) {
    return { spec: null, error: `faqs[${overflow}] ("${answers.faqs[overflow].title}") doesn't fit in the ${LIMITS.MAX_LIST_ROWS}-item menu, so it needs a keyword customers can type` };
  }
  if (menu.length === 0) {
    return { spec: null, error: 'answers must include at least one of: booking, services, hours, address, payment, contact, faqs' };
  }

  const specError = validateFlowSpec(spec);
  if (specError) return { spec: null, error: `The generated flow is invalid: ${specError}` };
  return { spec, error: null };
};

module.exports = {
  validateQuestionnaireAnswers,
  mapAnswersToFlowSpec,
  generateFieldKeys
};
