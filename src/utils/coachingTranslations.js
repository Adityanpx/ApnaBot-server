// Bot Builder (coaching) translations — owner-typed Hindi / Marathi for the
// texts the WhatsApp bot sends, so a parent who picked that language on
// first contact (customers.preferred_language) reads the bot in it. Pure.
//
// Stored in the bot settings (saved with the draft, live on Publish):
//   settings.translations = { hi?: { [slotId]: { text, source } }, mr?: {...} }
// A "slot" is one text the bot sends: its id is stable ('welcome',
// 'section.fees', 'course.<courseId>.page', 'faq.2.answer', 'fixed.button.mainMenu', ...).
// `source` is the English the translation was written for; when the
// English changes, the translation is not used (parents see the new
// English) until the owner saves it again.
//
// 'fixed.*' slots are wording the bot builder writes itself (menu titles,
// "Main menu", ...). They come with BUILT_IN translations; an owner entry
// replaces the built-in one.
//
// coachingBotSettings.js#mapCoachingSettingsToSpec asks for every text
// through makeTranslator().tr, which also records the slot list the
// Translations screen shows (POST /api/bot-settings/translation-slots).
const { LANGUAGE_CATALOG } = require('./languageCatalog');

const TRANSLATION_LANGUAGES = Object.keys(LANGUAGE_CATALOG).filter(code => code !== 'en');
const SLOT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_TRANSLATION_LENGTH = 4096;
const MAX_ENTRIES_PER_LANGUAGE = 600;
const PLACEHOLDER_RE = /\{\{[^}]+\}\}/g;

// Built-in translations for the bot builder's own wording ('fixed.*'
// slots). Keep within the WhatsApp limit of where each is used (button
// title 20, list row title 24, list row description 72).
const BUILT_IN = {
  'fixed.menu.courses': { en: '📚 Courses', hi: '📚 कोर्स', mr: '📚 कोर्सेस' },
  'fixed.menu.fees': { en: '💰 Fees', hi: '💰 फीस', mr: '💰 फी' },
  'fixed.menu.timings': { en: '🕘 Batches & timings', hi: '🕘 बैच और समय', mr: '🕘 बॅच आणि वेळा' },
  'fixed.menu.results': { en: '🏆 Results & faculty', hi: '🏆 रिज़ल्ट और शिक्षक', mr: '🏆 निकाल आणि शिक्षक' },
  'fixed.menu.material': { en: '📄 Study material', hi: '📄 स्टडी मटेरियल', mr: '📄 अभ्यास साहित्य' },
  'fixed.menu.contact': { en: '📞 Contact us', hi: '📞 संपर्क करें', mr: '📞 संपर्क साधा' },
  'fixed.menu.location': { en: '📍 Location', hi: '📍 लोकेशन', mr: '📍 पत्ता' },
  'fixed.menu.faq': { en: '❓ FAQ', hi: '❓ सवाल-जवाब', mr: '❓ प्रश्नोत्तरे' },
  'fixed.menu.demo': { en: '🎓 Free demo', hi: '🎓 फ्री डेमो', mr: '🎓 मोफत डेमो' },
  'fixed.menu.admission': { en: '📝 Admission', hi: '📝 एडमिशन', mr: '📝 प्रवेश' },
  'fixed.button.demo': { en: 'Free demo', hi: 'फ्री डेमो', mr: 'मोफत डेमो' },
  'fixed.button.admission': { en: 'Admission', hi: 'एडमिशन', mr: 'प्रवेश' },
  'fixed.button.mainMenu': { en: 'Main menu', hi: 'मुख्य मेन्यू', mr: 'मुख्य मेनू' },
  'fixed.button.moreQuestions': { en: 'More questions', hi: 'और सवाल', mr: 'आणखी प्रश्न' },
  'fixed.button.allGroups': { en: 'All groups', hi: 'सभी ग्रुप', mr: 'सर्व ग्रुप' },
  'fixed.button.fillForm': { en: 'Fill form', hi: 'फॉर्म भरें', mr: 'फॉर्म भरा' },
  'fixed.page.courses': {
    en: 'Our courses — tap one to see the details:',
    hi: 'हमारे कोर्स — जानकारी देखने के लिए किसी एक पर टैप करें:',
    mr: 'आमचे कोर्सेस — माहिती पाहण्यासाठी एकावर टॅप करा:'
  },
  'fixed.page.courseGroups': {
    en: 'Our courses — choose a group:',
    hi: 'हमारे कोर्स — एक ग्रुप चुनें:',
    mr: 'आमचे कोर्सेस — एक ग्रुप निवडा:'
  },
  'fixed.page.group': {
    en: '{{group}} — tap a course to see the details:',
    hi: '{{group}} — जानकारी देखने के लिए किसी कोर्स पर टैप करें:',
    mr: '{{group}} — माहिती पाहण्यासाठी कोर्सवर टॅप करा:'
  },
  'fixed.page.groupCountOne': { en: '{{count}} course', hi: '{{count}} कोर्स', mr: '{{count}} कोर्स' },
  'fixed.page.groupCountMany': { en: '{{count}} courses', hi: '{{count}} कोर्स', mr: '{{count}} कोर्सेस' },
  'fixed.page.faq': {
    en: 'Common questions — tap one to see the answer:',
    hi: 'आम सवाल — जवाब देखने के लिए किसी एक पर टैप करें:',
    mr: 'नेहमीचे प्रश्न — उत्तर पाहण्यासाठी एकावर टॅप करा:'
  },
  'fixed.form.demo': {
    en: 'Book a free demo class — tap the button below and fill a short form.',
    hi: 'फ्री डेमो क्लास बुक करें — नीचे दिए बटन पर टैप करके छोटा सा फॉर्म भरें।',
    mr: 'मोफत डेमो क्लास बुक करा — खालील बटणावर टॅप करून छोटा फॉर्म भरा.'
  },
  'fixed.form.admission': {
    en: 'Apply for admission — tap the button below and fill the form.',
    hi: 'एडमिशन के लिए आवेदन करें — नीचे दिए बटन पर टैप करके फॉर्म भरें।',
    mr: 'प्रवेशासाठी अर्ज करा — खालील बटणावर टॅप करून फॉर्म भरा.'
  }
};

// Web form (C1b): built-in translations of the Bot Builder's own questions
// (coachingBotSettings.js FIELD_LIBRARY + Student name / Course), their fixed
// choices, and the form page titles. Choices are shown translated but the
// English value is what's saved. Owner questions/notes are slots instead.
const FIELD_LABELS = {
  studentName: { hi: 'विद्यार्थी का नाम', mr: 'विद्यार्थ्याचे नाव' },
  course: { hi: 'कोर्स', mr: 'कोर्स' },
  parentName: { hi: 'माता/पिता का नाम', mr: 'पालकांचे नाव' },
  fatherName: { hi: 'पिता का नाम', mr: 'वडिलांचे नाव' },
  motherName: { hi: 'माता का नाम', mr: 'आईचे नाव' },
  dob: { hi: 'जन्म तिथि', mr: 'जन्मतारीख' },
  age: { hi: 'विद्यार्थी की उम्र', mr: 'विद्यार्थ्याचे वय' },
  school: { hi: 'स्कूल / कॉलेज', mr: 'शाळा / कॉलेज' },
  standard: { hi: 'कक्षा', mr: 'इयत्ता' },
  board: { hi: 'बोर्ड', mr: 'बोर्ड' },
  stream: { hi: 'स्ट्रीम', mr: 'शाखा' },
  targetExam: { hi: 'लक्ष्य परीक्षा', mr: 'लक्ष्य परीक्षा' },
  tenthPercent: { hi: '10वीं के अंक (%)', mr: '10वीचे गुण (%)' },
  batch: { hi: 'बैच', mr: 'बॅच' },
  mode: { hi: 'क्लास का प्रकार', mr: 'क्लासचा प्रकार' },
  preferredTime: { hi: 'पसंदीदा समय', mr: 'सोयीची वेळ' },
  area: { hi: 'इलाका / क्षेत्र', mr: 'परिसर / भाग' }
};
const OPTION_LABELS = {
  standard: {
    '1st': { hi: '1ली', mr: '1ली' }, '2nd': { hi: '2री', mr: '2री' }, '3rd': { hi: '3री', mr: '3री' },
    '4th': { hi: '4थी', mr: '4थी' }, '5th': { hi: '5वीं', mr: '5वी' }, '6th': { hi: '6वीं', mr: '6वी' },
    '7th': { hi: '7वीं', mr: '7वी' }, '8th': { hi: '8वीं', mr: '8वी' }, '9th': { hi: '9वीं', mr: '9वी' },
    '10th': { hi: '10वीं', mr: '10वी' }, '11th': { hi: '11वीं', mr: '11वी' }, '12th': { hi: '12वीं', mr: '12वी' },
    '12th passed': { hi: '12वीं पास', mr: '12वी उत्तीर्ण' }
  },
  board: { 'State board': { hi: 'स्टेट बोर्ड', mr: 'राज्य मंडळ' } },
  stream: {
    Science: { hi: 'साइंस', mr: 'विज्ञान' }, Commerce: { hi: 'कॉमर्स', mr: 'वाणिज्य' }, Arts: { hi: 'आर्ट्स', mr: 'कला' }
  },
  batch: { Weekday: { hi: 'वीकडे (सोम–शुक्र)', mr: 'आठवड्याचे दिवस (सोम–शुक्र)' }, Weekend: { hi: 'वीकेंड (शनि–रवि)', mr: 'शनिवार–रविवार' } },
  mode: { Online: { hi: 'ऑनलाइन', mr: 'ऑनलाइन' }, Offline: { hi: 'ऑफलाइन', mr: 'ऑफलाइन' } },
  preferredTime: {
    Morning: { hi: 'सुबह', mr: 'सकाळ' }, Afternoon: { hi: 'दोपहर', mr: 'दुपार' }, Evening: { hi: 'शाम', mr: 'संध्याकाळ' }
  }
};
const FORM_TITLES = {
  demo: {
    title: { hi: 'फ्री डेमो क्लास बुक करें', mr: 'मोफत डेमो क्लास बुक करा' },
    subtitle: { hi: 'लगभग एक मिनट लगेगा।', mr: 'साधारण एक मिनिट लागेल.' }
  },
  admission: {
    title: { hi: 'एडमिशन फॉर्म', mr: 'प्रवेश अर्ज' },
    subtitle: { hi: 'लगभग 2 मिनट लगेंगे।', mr: 'साधारण 2 मिनिटे लागतील.' }
  }
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const placeholders = (text) => [...new Set(String(text || '').match(PLACEHOLDER_RE) || [])].sort().join('|');
const fill = (text, vars) => (vars ? text.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : text);

/**
 * Checks settings.translations (draft or publish). Returns an error or null.
 */
const validateTranslations = (translations) => {
  if (translations === undefined || translations === null) return null;
  if (!isPlainObject(translations)) return 'translations must be an object';
  for (const [lang, entries] of Object.entries(translations)) {
    if (!TRANSLATION_LANGUAGES.includes(lang)) return `translations: unknown language "${lang}" (use ${TRANSLATION_LANGUAGES.join(', ')})`;
    if (!isPlainObject(entries)) return `translations.${lang} must be an object`;
    const ids = Object.keys(entries);
    if (ids.length > MAX_ENTRIES_PER_LANGUAGE) return `translations.${lang}: at most ${MAX_ENTRIES_PER_LANGUAGE} texts`;
    for (const id of ids) {
      const e = entries[id];
      if (!SLOT_ID_PATTERN.test(id)) return `translations.${lang}: bad text id "${id}"`;
      if (!isPlainObject(e) || typeof e.text !== 'string' || typeof e.source !== 'string') {
        return `translations.${lang}.${id} must be { text, source }`;
      }
      if (e.text.length > MAX_TRANSLATION_LENGTH || e.source.length > MAX_TRANSLATION_LENGTH) return `translations.${lang}.${id} is too long`;
    }
  }
  return null;
};

/**
 * @param {Object|undefined} translations - settings.translations
 * @param {string[]} languages - the business's enabled languages other than English
 * @returns {{ tr: Function, fixed: Function, slots: Object[], report: Object }}
 *   tr(id, english, max, meta) → { [lang]: text } of usable translations (or undefined)
 *   fixed(id, vars, max, meta) → { text, translations } for a 'fixed.*' slot
 *   slots: every text asked for (deduped), for the Translations screen
 *   report: { [lang]: { total, missing, changed, tooLong: [label], badPlaceholders: [label] } }
 */
const makeTranslator = (translations, languages) => {
  const langs = (languages || []).filter(l => TRANSLATION_LANGUAGES.includes(l));
  const slots = new Map();
  const report = Object.fromEntries(langs.map(l => [l, { total: 0, missing: 0, changed: 0, tooLong: [], badPlaceholders: [] }]));
  const counted = new Set();

  const tr = (id, english, max, meta = {}) => {
    const source = String(english || '').trim();
    if (!source) return undefined;
    const builtIn = BUILT_IN[meta.builtInId || id];
    if (!slots.has(id)) {
      slots.set(id, {
        id, group: meta.group || 'Other', label: meta.label || id, english: source, max,
        ...(builtIn ? { builtIn: Object.fromEntries(TRANSLATION_LANGUAGES.map(l => [l, builtIn[l] ? fill(builtIn[l], meta.vars) : null])) } : {})
      });
    }
    const firstTime = !counted.has(id);
    counted.add(id);
    const out = {};
    for (const lang of langs) {
      const r = report[lang];
      const entry = translations && translations[lang] && translations[lang][id];
      let text = null;
      let changed = false;
      if (entry && entry.text.trim()) {
        if (entry.source.trim() === source) text = entry.text.trim();
        else changed = true;
      }
      // Built-in wording for 'fixed.*' slots (when the owner hasn't replaced it).
      if (!text && builtIn && fill(builtIn.en, meta.vars) === source) text = builtIn[lang] ? fill(builtIn[lang], meta.vars) : null;
      if (firstTime && !builtIn) r.total += 1;
      if (!text) {
        if (firstTime && !builtIn) { r.missing += 1; if (changed) r.changed += 1; }
        continue;
      }
      if (placeholders(text) !== placeholders(source)) {
        if (firstTime) { r.badPlaceholders.push(meta.label || id); if (!builtIn) r.missing += 1; }
        continue;
      }
      if (max && text.length > max) {
        if (firstTime) { r.tooLong.push(meta.label || id); if (!builtIn) r.missing += 1; }
        continue;
      }
      out[lang] = text;
    }
    return Object.keys(out).length ? out : undefined;
  };

  /** A 'fixed.*' text: its English (BUILT_IN.en with vars filled) + translations. */
  const fixed = (id, vars, max, meta = {}) => {
    const text = fill(BUILT_IN[id].en, vars);
    // With vars (a group name, a count) each filled-in text is its own slot.
    const slotId = (vars ? `${id}.${Object.values(vars).map(v => String(v).replace(/[^A-Za-z0-9_-]/g, '_')).join('.')}` : id).slice(0, 120);
    return { text, translations: tr(slotId, text, max, { ...meta, builtInId: id, vars }) };
  };

  /**
   * Drops translations over `max` (a limit only known later, e.g. a menu of
   * 3 or fewer items goes as buttons, 20 characters) — reported as too long.
   */
  const fit = (map, max, label) => {
    if (!map) return map;
    const out = {};
    for (const [lang, text] of Object.entries(map)) {
      if (text.length <= max) out[lang] = text;
      else if (report[lang] && !report[lang].tooLong.includes(label)) report[lang].tooLong.push(label);
    }
    return Object.keys(out).length ? out : undefined;
  };

  // Translations screen order: Welcome first, the bot builder's own wording last.
  const GROUP_ORDER = ['Welcome', 'Sections', 'Courses', 'FAQ', 'Forms', 'Menu & buttons'];
  const groupRank = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : GROUP_ORDER.length);
  const orderedSlots = () => [...slots.values()]
    .map((s, i) => [s, i]).sort((a, b) => groupRank(a[0].group) - groupRank(b[0].group) || a[1] - b[1]).map(([s]) => s);

  return { tr, fixed, fit, slots: orderedSlots, report };
};

/** Owner-facing warnings from makeTranslator().report. */
const translationWarnings = (report) => {
  const warnings = [];
  for (const [lang, r] of Object.entries(report || {})) {
    const name = (LANGUAGE_CATALOG[lang] && LANGUAGE_CATALOG[lang].name) || lang;
    if (r.missing > 0) {
      warnings.push(`${name}: ${r.missing} of ${r.total} texts have no translation yet${r.changed ? ` (${r.changed} because the English changed)` : ''} — parents who chose ${name} see English for those. Add them under Translations.`);
    }
    if (r.tooLong.length) warnings.push(`${name}: too long for WhatsApp, English is sent instead — ${r.tooLong.slice(0, 5).join(', ')}${r.tooLong.length > 5 ? ', …' : ''}.`);
    if (r.badPlaceholders.length) warnings.push(`${name}: keep the {{…}} words exactly as in English — ${r.badPlaceholders.slice(0, 5).join(', ')}.`);
  }
  return warnings;
};

/** { hi: ..., mr: ... } limited to `languages`, or undefined when none. */
const pickLanguages = (map, languages) => {
  const out = {};
  for (const l of languages || []) if (map && map[l]) out[l] = map[l];
  return Object.keys(out).length ? out : undefined;
};

module.exports = {
  TRANSLATION_LANGUAGES,
  BUILT_IN,
  FIELD_LABELS,
  OPTION_LABELS,
  FORM_TITLES,
  pickLanguages,
  validateTranslations,
  makeTranslator,
  translationWarnings
};
