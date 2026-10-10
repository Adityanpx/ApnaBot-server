// Follow-up automations — the pure parts: what each preset allows, checking
// an owner's automation before it is saved or switched on, the trigger keys
// that make each send happen once, and the text / template values a
// follow-up is sent with. Database work lives in services/followup.service.js
// (owner API) and services/followupSweep.service.js (sending).
//
// Times are minutes. Send hours are India time (utils/ist.js).
const { getSystemMessage } = require('./systemMessages');
const { getLocalizedText } = require('./localization');
const { applyMessageTemplate } = require('./messageTemplating');
const { cleanValue, fillPlaceholders } = require('./templateValue');
const { isSendSupported, sendSupportBlockReason } = require('./templateStatus');
const { requiredParams, splitMapping, checkParamCounts, BUTTON_SOURCES } = require('./templateMapping');

const HOUR = 60;
const DAY = 24 * HOUR;
// An after_last_inbound follow-up is text-only, so the customer's 24-hour
// window must still be open — with this much to spare — when it is sent.
const WINDOW_MARGIN_MINUTES = 10;
const NAME_MAX = 35;
const TEXT_MAX = 1000;
const LANGUAGE_CODES = ['en', 'hi', 'mr'];
const TRIGGER_TYPES = ['after_last_inbound', 'after_completed', 'after_payment_requested', 'inactive_for'];
const MESSAGE_CATEGORIES = ['marketing', 'utility'];
// Triggers that fire for a booking (one follow-up per booking occurrence),
// not for a customer's chat activity.
const BOOKING_TRIGGERS = ['after_completed', 'after_payment_requested'];
// A booking trigger missed by more than this (e.g. the server was asleep) is
// skipped rather than sent late.
const LATE_GRACE_MINUTES = 2 * DAY;
const MAPPING_SOURCES = ['customer.name', 'business.name', 'static', 'booking.code', 'booking.amount'];
const BOOKING_MAPPING_SOURCES = ['booking.code', 'booking.amount'];
// Text placeholders filled from the booking (booking triggers only); the
// rest ({{customerName}}, {{businessName}}, …) are applyMessageTemplate's.
const BOOKING_PLACEHOLDER_RE = /\{\{(bookingCode|amount)\}\}/;

// What a trigger allows, shared by the presets and custom automations.
//   template  'none'     text-only (template_id must be empty)
//             'required' an approved template is needed (window closed)
const RULES = {
  textAfterInbound: {
    triggerType: 'after_last_inbound',
    template: 'none',
    delay: { min: 30, max: 23 * HOUR },
    triggerParams: { recentBookingDays: 7 }
  },
  templateAfterInactive: {
    triggerType: 'inactive_for',
    template: 'required',
    delay: { min: 1 * DAY, max: 180 * DAY },
    triggerParams: { onlyPastCustomers: false, maxInactiveDays: 180 }
  }
};

/**
 * Served to the web (GET /api/followups/presets) as well as used here.
 * available:false presets can't be created yet ("available soon").
 */
const PRESETS = {
  enquiry_nudge: {
    label: 'Enquiry follow-up',
    description: "Nudge customers who messaged but didn't book, while WhatsApp still allows a free reply.",
    available: true,
    triggerType: 'after_last_inbound',
    messageCategory: 'marketing',
    template: 'none',
    delay: { min: 30, max: 23 * HOUR, default: 3 * HOUR },
    defaults: { perCustomerCap: 3, dailyCap: 100, sendStartMinute: 540, sendEndMinute: 1260 },
    triggerParams: { recentBookingDays: 7 },
    textKey: 'followupEnquiryNudge'
  },
  win_back: {
    label: 'Win back',
    description: "Bring back past customers who haven't messaged in a while (approved marketing template).",
    available: true,
    triggerType: 'inactive_for',
    messageCategory: 'marketing',
    template: 'required',
    templateCategory: 'MARKETING',
    delay: { min: 7 * DAY, max: 180 * DAY, default: 30 * DAY },
    defaults: { perCustomerCap: 2, dailyCap: 50, sendStartMinute: 600, sendEndMinute: 1200 },
    triggerParams: { onlyPastCustomers: true, maxInactiveDays: 180 },
    textKey: 'followupWinBack'
  },
  custom: {
    label: 'Custom',
    description: 'Your own message and timing.',
    available: true,
    triggerTypes: ['after_last_inbound', 'inactive_for'],
    defaults: { perCustomerCap: 1, dailyCap: 50, sendStartMinute: 540, sendEndMinute: 1260 }
  },
  // Booking triggers: a follow-up about a completed booking or a pending
  // payment is a transaction follow-up, so UTILITY (no marketing opt-in).
  review_request: {
    label: 'Review request',
    description: 'Thank customers and ask for a review after a completed booking.',
    available: true,
    triggerType: 'after_completed',
    messageCategory: 'utility',
    template: 'required',
    templateCategory: 'UTILITY',
    delay: { min: 30, max: 14 * DAY, default: DAY },
    defaults: { perCustomerCap: 3, dailyCap: 100, sendStartMinute: 600, sendEndMinute: 1200 },
    triggerParams: {},
    textKey: 'followupReviewRequest'
  },
  payment_pending: {
    label: 'Payment reminder',
    description: 'Remind customers about a payment that is still pending.',
    available: true,
    triggerType: 'after_payment_requested',
    messageCategory: 'utility',
    template: 'required',
    templateCategory: 'UTILITY',
    delay: { min: 30, max: 7 * DAY, default: 6 * HOUR },
    defaults: { perCustomerCap: 3, dailyCap: 100, sendStartMinute: 600, sendEndMinute: 1200 },
    triggerParams: {},
    textKey: 'followupPaymentPending'
  }
};

const isInt = (v) => Number.isInteger(v);
const isBlank = (v) => typeof v !== 'string' || v.trim() === '';

/** Distinct {{n}} in a template body — same count broadcast.controller.js uses. */
const countTemplateVariables = (bodyText) => {
  const matches = (bodyText || '').match(/\{\{\s*\d+\s*\}\}/g) || [];
  return new Set(matches.map((m) => m.replace(/\D/g, ''))).size;
};

/** The rule set an automation follows: its preset's, or for custom its trigger's. */
const ruleFor = (preset, triggerType) => {
  const p = PRESETS[preset];
  if (p && preset !== 'custom' && p.available) {
    return {
      triggerType: p.triggerType,
      template: p.template,
      ...(p.templateCategory ? { templateCategory: p.templateCategory } : {}),
      delay: p.delay,
      triggerParams: p.triggerParams
    };
  }
  if (preset !== 'custom') return null;
  if (triggerType === 'after_last_inbound') return RULES.textAfterInbound;
  if (triggerType === 'inactive_for') return RULES.templateAfterInactive;
  return null;
};

/** Default message text (+ hi/mr) for a preset, or null for custom. */
const defaultText = (preset) => {
  const key = PRESETS[preset] && PRESETS[preset].textKey;
  if (!key) return null;
  const translations = {};
  for (const lang of LANGUAGE_CODES.filter((l) => l !== 'en')) {
    const t = getSystemMessage(key, lang);
    if (t && t !== getSystemMessage(key, null)) translations[lang] = t;
  }
  return { text: getSystemMessage(key, null), translations };
};

/**
 * Which templates a rule can use (the same checks validateAutomation makes),
 * for the web's template dropdown; null = no template (text-only).
 *   category                        required template category, or null when
 *   categoryMatchesMessageCategory  it must match the automation's messageCategory
 */
const templateFilterFor = (rule) => (rule && rule.template === 'required'
  ? {
    status: 'approved',
    category: rule.templateCategory || null,
    categoryMatchesMessageCategory: !rule.templateCategory
  }
  : null);

/** Presets as served to the web: limits, defaults, default texts and template filters. */
const presetsForWeb = () => Object.entries(PRESETS).map(([key, p]) => {
  const text = defaultText(key);
  const isCustom = key === 'custom';
  return {
    key,
    label: p.label,
    description: p.description,
    available: p.available,
    triggerType: p.triggerType || null,
    triggerTypes: p.triggerTypes || (p.triggerType ? [p.triggerType] : []),
    messageCategory: p.messageCategory || null,
    template: p.template || null,
    delay: p.delay || null,
    defaults: p.defaults || null,
    triggerParams: p.triggerParams || null,
    rules: isCustom
      ? { after_last_inbound: RULES.textAfterInbound, inactive_for: RULES.templateAfterInactive }
      : undefined,
    // Custom depends on the trigger picked; see templateFilterByTrigger.
    templateFilter: !p.available || isCustom ? null : templateFilterFor(ruleFor(key, p.triggerType)),
    templateFilterByTrigger: isCustom
      ? Object.fromEntries(p.triggerTypes.map(t => [t, templateFilterFor(ruleFor(key, t))]))
      : undefined,
    defaultText: text ? text.text : null,
    defaultTextTranslations: text ? text.translations : null
  };
});

const checkTriggerParams = (rule, params, delayMinutes) => {
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== 'object' || Array.isArray(p)) return { error: 'triggerParams must be an object' };
  const out = {};
  if (rule.triggerType === 'after_last_inbound') {
    const days = p.recentBookingDays === undefined ? rule.triggerParams.recentBookingDays : p.recentBookingDays;
    if (!isInt(days) || days < 0 || days > 90) return { error: 'triggerParams.recentBookingDays must be a whole number from 0 to 90' };
    out.recentBookingDays = days;
  } else if (rule.triggerType === 'inactive_for') {
    const only = p.onlyPastCustomers === undefined ? rule.triggerParams.onlyPastCustomers : p.onlyPastCustomers;
    if (typeof only !== 'boolean') return { error: 'triggerParams.onlyPastCustomers must be true or false' };
    const maxDays = p.maxInactiveDays === undefined ? rule.triggerParams.maxInactiveDays : p.maxInactiveDays;
    if (!isInt(maxDays) || maxDays < 1 || maxDays > 365) return { error: 'triggerParams.maxInactiveDays must be a whole number from 1 to 365' };
    if (maxDays * DAY <= delayMinutes) return { error: 'triggerParams.maxInactiveDays must be longer than the delay' };
    out.onlyPastCustomers = only;
    out.maxInactiveDays = maxDays;
  }
  return { value: out };
};

const checkTranslations = (translations) => {
  if (translations === undefined || translations === null) return { value: null };
  if (typeof translations !== 'object' || Array.isArray(translations)) return { error: 'messageTextTranslations must be an object' };
  const out = {};
  for (const [lang, text] of Object.entries(translations)) {
    if (!LANGUAGE_CODES.includes(lang) || lang === 'en') return { error: `messageTextTranslations: unknown language "${lang}"` };
    if (text === null || text === undefined || (typeof text === 'string' && text.trim() === '')) continue;
    if (typeof text !== 'string') return { error: `messageTextTranslations.${lang} must be text` };
    if (text.trim().length > TEXT_MAX) return { error: `messageTextTranslations.${lang} is too long (max ${TEXT_MAX} characters)` };
    out[lang] = text.trim();
  }
  return { value: Object.keys(out).length ? out : null };
};

// One mapping entry (any target) → the entry to store, or an error. `sources`
// is what that target may use; the optional fallback applies to every target.
const checkMappingEntry = (entry, at, triggerType, sources) => {
  if (!entry || typeof entry !== 'object') return { error: `${at} must be an object` };
  if (!sources.includes(entry.source)) return { error: `${at}.source must be one of: ${sources.join(', ')}` };
  if (BOOKING_MAPPING_SOURCES.includes(entry.source) && !BOOKING_TRIGGERS.includes(triggerType)) {
    return { error: `${at}.source ${entry.source} is only available for booking follow-ups (review request, payment reminder)` };
  }
  if (entry.source === 'static' && isBlank(entry.value)) return { error: `${at}.value is required for a fixed value` };
  // Optional: an empty customer name / amount with no fallback reads in the
  // template's language (renderTemplateParams); the business always has a
  // name, every booking has a code, and a fixed value is never empty.
  if (entry.fallback !== undefined && entry.fallback !== null && typeof entry.fallback !== 'string') {
    return { error: `${at}.fallback must be text` };
  }
  return {
    value: {
      source: entry.source,
      ...(entry.source === 'static' ? { value: entry.value.trim() } : {}),
      fallback: typeof entry.fallback === 'string' ? entry.fallback.trim() : ''
    }
  };
};

/**
 * templateVariableMapping for `template` (a message_templates row): body
 * entries (positional, as always) plus, when the template needs them, one
 * entry with target 'header' and one per dynamic URL button (target 'button' +
 * buttonIndex; source static, or booking.code for booking follow-ups). Stored
 * body entries first, then header, then buttons by index.
 */
const checkMapping = (mapping, template, triggerType) => {
  const list = mapping === undefined || mapping === null ? [] : mapping;
  if (!Array.isArray(list)) return { error: 'templateVariableMapping must be a list' };
  const variableCount = requiredParams(template).body;
  const parts = splitMapping(list);
  if (parts.unknown.length === 0 && parts.body.length !== variableCount) {
    return { error: `This template has ${variableCount} variable(s); templateVariableMapping must have exactly ${variableCount} entr${variableCount === 1 ? 'y' : 'ies'}` };
  }
  const countError = checkParamCounts(list, template, { checkBody: false });
  if (countError) return { error: countError };

  const out = [];
  for (const [i, entry] of parts.body.entries()) {
    const checked = checkMappingEntry(entry, `templateVariableMapping[${i}] ({{${i + 1}}})`, triggerType, MAPPING_SOURCES);
    if (checked.error) return checked;
    out.push(checked.value);
  }
  for (const entry of parts.header) {
    const checked = checkMappingEntry(entry, 'templateVariableMapping (header)', triggerType, MAPPING_SOURCES);
    if (checked.error) return checked;
    out.push({ target: 'header', ...checked.value });
  }
  for (const entry of [...parts.button].sort((x, y) => x.buttonIndex - y.buttonIndex)) {
    const checked = checkMappingEntry(entry, `templateVariableMapping (button ${entry.buttonIndex})`, triggerType, BUTTON_SOURCES);
    if (checked.error) return checked;
    out.push({ target: 'button', buttonIndex: entry.buttonIndex, ...checked.value });
  }
  return { value: out.length ? out : null };
};

/**
 * Checks an automation (camelCase input, e.g. a request body merged over the
 * saved row) and returns the snake_case columns to save.
 * @param {Object} input
 * @param {{ templateRow?: Object|null }} ctx  the message_templates row for input.templateId (this business's), or null
 * @returns {{ value: Object } | { error: string }}
 */
const validateAutomation = (input, { templateRow = null } = {}) => {
  if (!input || typeof input !== 'object') return { error: 'Invalid automation' };
  const preset = PRESETS[input.preset];
  if (!preset) return { error: `preset must be one of: ${Object.keys(PRESETS).join(', ')}` };
  if (!preset.available) return { error: `"${preset.label}" is available soon` };

  if (isBlank(input.name)) return { error: 'name is required' };
  const name = input.name.trim();
  if (name.length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters` };

  let triggerType = preset.triggerType;
  if (input.preset === 'custom') {
    if (!TRIGGER_TYPES.includes(input.triggerType)) return { error: `triggerType must be one of: ${preset.triggerTypes.join(', ')}` };
    if (!preset.triggerTypes.includes(input.triggerType)) return { error: 'This trigger is available soon' };
    triggerType = input.triggerType;
  } else if (input.triggerType !== undefined && input.triggerType !== null && input.triggerType !== triggerType) {
    return { error: `The ${preset.label} preset always uses the ${triggerType} trigger` };
  }
  const rule = ruleFor(input.preset, triggerType);

  const delayMinutes = input.delayMinutes === undefined || input.delayMinutes === null
    ? (preset.delay ? preset.delay.default : undefined)
    : input.delayMinutes;
  if (!isInt(delayMinutes)) return { error: 'delayMinutes must be a whole number of minutes' };
  if (delayMinutes < rule.delay.min || delayMinutes > rule.delay.max) {
    return { error: `delayMinutes must be between ${rule.delay.min} and ${rule.delay.max} for this trigger` };
  }

  let messageCategory = preset.messageCategory;
  if (input.preset === 'custom') {
    messageCategory = input.messageCategory === undefined || input.messageCategory === null ? 'marketing' : input.messageCategory;
    if (!MESSAGE_CATEGORIES.includes(messageCategory)) return { error: `messageCategory must be one of: ${MESSAGE_CATEGORIES.join(', ')}` };
  } else if (input.messageCategory !== undefined && input.messageCategory !== null && input.messageCategory !== messageCategory) {
    return { error: `The ${preset.label} preset always sends ${messageCategory} messages` };
  }

  const params = checkTriggerParams(rule, input.triggerParams, delayMinutes);
  if (params.error) return params;

  // Message text: the preset's default (with its translations) unless the owner wrote one.
  let messageText = input.messageText;
  let translationsInput = input.messageTextTranslations;
  if (messageText === undefined || messageText === null) {
    const d = defaultText(input.preset);
    if (!d) return { error: 'messageText is required' };
    messageText = d.text;
    if (translationsInput === undefined) translationsInput = d.translations;
  }
  if (isBlank(messageText)) return { error: 'messageText is required' };
  if (messageText.trim().length > TEXT_MAX) return { error: `messageText is too long (max ${TEXT_MAX} characters)` };
  const translations = checkTranslations(translationsInput);
  if (translations.error) return translations;
  if (!BOOKING_TRIGGERS.includes(triggerType)) {
    const texts = [messageText, ...Object.values(translations.value || {})];
    const found = texts.map((t) => BOOKING_PLACEHOLDER_RE.exec(t)).find(Boolean);
    if (found) return { error: `messageText: {{${found[1]}}} is only available for booking follow-ups (review request, payment reminder)` };
  }

  const defaults = preset.defaults;
  const pick = (key) => (input[key] === undefined || input[key] === null ? defaults[key] : input[key]);
  const sendStartMinute = pick('sendStartMinute');
  const sendEndMinute = pick('sendEndMinute');
  const dailyCap = pick('dailyCap');
  const perCustomerCap = pick('perCustomerCap');
  if (!isInt(sendStartMinute) || sendStartMinute < 0 || sendStartMinute > 1439) return { error: 'sendStartMinute must be a whole number from 0 to 1439' };
  if (!isInt(sendEndMinute) || sendEndMinute < 1 || sendEndMinute > 1440) return { error: 'sendEndMinute must be a whole number from 1 to 1440' };
  if (sendStartMinute === sendEndMinute) return { error: 'Send hours must not start and end at the same time' };
  if (!isInt(dailyCap) || dailyCap < 1) return { error: 'dailyCap must be a whole number of at least 1' };
  if (!isInt(perCustomerCap) || perCustomerCap < 1 || perCustomerCap > 5) return { error: 'perCustomerCap must be a whole number from 1 to 5' };

  // Template.
  const templateId = input.templateId === undefined || input.templateId === null || input.templateId === '' ? null : input.templateId;
  let mapping = null;
  if (rule.template === 'none') {
    if (templateId) return { error: 'This automation sends a free text reply only — remove the template' };
    if (Array.isArray(input.templateVariableMapping) && input.templateVariableMapping.length) {
      return { error: 'templateVariableMapping is only used with a template' };
    }
  } else {
    if (!templateId) return { error: 'Pick an approved WhatsApp template for this automation' };
    if (!templateRow || templateRow.id !== templateId) return { error: 'Template not found' };
    if (templateRow.status !== 'approved') return { error: `Template "${templateRow.name}" is not approved by WhatsApp (status: ${templateRow.status})` };
    const expected = rule.templateCategory || messageCategory.toUpperCase();
    if (templateRow.category !== expected) {
      return { error: `Template "${templateRow.name}" is a ${templateRow.category} template; this automation needs a ${expected} template` };
    }
    if (!isSendSupported(templateRow)) {
      return { error: `Template "${templateRow.name}" can't be sent by ApnaBot yet — ${sendSupportBlockReason(templateRow)}` };
    }
    const m = checkMapping(input.templateVariableMapping, templateRow, triggerType);
    if (m.error) return m;
    mapping = m.value;
  }

  return {
    value: {
      name,
      preset: input.preset,
      trigger_type: triggerType,
      delay_minutes: delayMinutes,
      trigger_params: params.value,
      message_category: messageCategory,
      message_text: messageText.trim(),
      message_text_translations: translations.value,
      template_id: templateId,
      template_variable_mapping: mapping,
      send_start_minute: sendStartMinute,
      send_end_minute: sendEndMinute,
      daily_cap: dailyCap,
      per_customer_cap: perCustomerCap
    }
  };
};

/** A saved row (snake_case) as validateAutomation input. */
const rowToInput = (row) => ({
  name: row.name,
  preset: row.preset,
  triggerType: row.trigger_type,
  delayMinutes: row.delay_minutes,
  triggerParams: row.trigger_params,
  messageCategory: row.message_category,
  messageText: row.message_text,
  messageTextTranslations: row.message_text_translations,
  templateId: row.template_id,
  templateVariableMapping: row.template_variable_mapping,
  sendStartMinute: row.send_start_minute,
  sendEndMinute: row.send_end_minute,
  dailyCap: row.daily_cap,
  perCustomerCap: row.per_customer_cap
});

// ── Trigger keys: one send per customer per trigger occurrence ──
const iso = (t) => new Date(t).toISOString();
const inboundTriggerKey = (lastMessageAt) => `inbound:${iso(lastMessageAt)}`;
const inactiveTriggerKey = (lastMessageAt) => `inactive:${iso(lastMessageAt)}`;
// One review request per booking, however often it's reopened / re-completed.
const completedTriggerKey = (bookingId) => `completed:${bookingId}`;
// One reminder per payment request; a new request (after paid → pending) is a new occurrence.
const paymentTriggerKey = (bookingId, requestedAt) => `payment:${bookingId}:${iso(requestedAt)}`;

const isBookingTrigger = (triggerType) => BOOKING_TRIGGERS.includes(triggerType);

/** The key for this customer (customer triggers) or booking (booking triggers). */
const triggerKeyFor = (automation, customerRow, booking = null) => {
  switch (automation.trigger_type) {
    case 'inactive_for': return inactiveTriggerKey(customerRow.last_message_at);
    case 'after_completed': return completedTriggerKey(booking.id);
    case 'after_payment_requested': return paymentTriggerKey(booking.id, booking.payment_requested_at);
    default: return inboundTriggerKey(customerRow.last_message_at);
  }
};

/**
 * The time range that makes a customer / booking due at `now`:
 * after < (last_message_at | completed_at | payment_requested_at) <= before.
 */
const dueRange = (automation, now) => {
  const t = new Date(now).getTime();
  const before = new Date(t - automation.delay_minutes * 60 * 1000);
  if (automation.trigger_type === 'inactive_for') {
    const maxDays = (automation.trigger_params && automation.trigger_params.maxInactiveDays) || RULES.templateAfterInactive.triggerParams.maxInactiveDays;
    return { before, after: new Date(t - maxDays * DAY * 60 * 1000) };
  }
  if (isBookingTrigger(automation.trigger_type)) {
    return { before, after: new Date(before.getTime() - LATE_GRACE_MINUTES * 60 * 1000) };
  }
  return { before, after: new Date(t - (DAY - WINDOW_MARGIN_MINUTES) * 60 * 1000) };
};

// ── Message content ──

// What a follow-up calls a customer with no name, per language. Follow-ups
// only — bot replies keep applyMessageTemplate's English 'there'.
const EMPTY_NAME = { en: 'there', hi: 'जी', mr: 'जी' };
// What {{amount}} reads when the booking has no amount (a payment QR sent
// without one), per language — the default reminder text reads naturally.
const EMPTY_AMOUNT = { en: 'your payment', hi: 'आपका भुगतान', mr: 'तुमचे पेमेंट' };

const customerNameOr = (customer, languageCode) => {
  const name = customer && typeof customer.name === 'string' ? cleanValue(customer.name) : '';
  return name || EMPTY_NAME[languageCode] || EMPTY_NAME.en;
};

/** "₹1,500" / "₹1,500.50", or '' when the booking has no positive amount. */
const formatAmount = (amount) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '';
  const digits = Number.isInteger(n) ? 0 : 2; // ₹1,500 / ₹1,500.50
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
};

const bookingCodeOf = (booking) => (booking && typeof booking.booking_code === 'string' ? cleanValue(booking.booking_code) : '');

/** 'hi' from 'hi', 'hi_IN'; null for anything else. */
const baseLanguage = (code) => (typeof code === 'string' && code ? code.split(/[_-]/)[0].toLowerCase() : null);

/**
 * The automation's text in the customer's language, with {{customerName}} etc.
 * filled. {{customerName}} (and, for booking follow-ups, {{bookingCode}} /
 * {{amount}}) are filled here first so empty values read in the language of
 * the text actually used (a missing translation falls back to English text);
 * applyMessageTemplate does the rest.
 */
const renderText = (automation, business, customer, languageCode, booking = null) => {
  const translations = automation.message_text_translations || {};
  const translated = languageCode && typeof translations[languageCode] === 'string' && translations[languageCode].trim() !== '';
  const textLanguage = translated ? languageCode : 'en';
  const vars = { customerName: customerNameOr(customer, textLanguage) };
  if (booking) {
    vars.bookingCode = bookingCodeOf(booking);
    vars.amount = formatAmount(booking.payment_amount) || EMPTY_AMOUNT[textLanguage] || EMPTY_AMOUNT.en;
  }
  const text = fillPlaceholders(getLocalizedText(automation, 'message_text', languageCode), vars);
  return applyMessageTemplate(text, business, customer);
};

/**
 * One mapping entry's value, falling back when empty to the owner's mapping
 * fallback. An empty customer name / amount with no fallback reads in the
 * template's language ('जी' / 'आपका भुगतान' for hi, etc., else English).
 */
const resolveMappingEntry = (entry, business, customer, templateLanguage, booking) => {
  const fallback = typeof entry.fallback === 'string' ? cleanValue(entry.fallback) : '';
  const lang = baseLanguage(templateLanguage);
  let v;
  if (entry.source === 'customer.name') {
    v = customer && customer.name;
    if (!(typeof v === 'string' && v.trim()) && !fallback) return customerNameOr(null, lang);
  } else if (entry.source === 'business.name') v = business && (business.displayName || business.name);
  else if (entry.source === 'booking.code') v = bookingCodeOf(booking);
  else if (entry.source === 'booking.amount') {
    v = booking ? formatAmount(booking.payment_amount) : '';
    if (!v && !fallback) return EMPTY_AMOUNT[lang] || EMPTY_AMOUNT.en;
  } else v = entry.value;
  return (typeof v === 'string' && cleanValue(v)) || fallback;
};

/** {{1}}..{{n}} body values from template_variable_mapping (header / button entries are renderTemplateValues'). */
const renderTemplateParams = (mapping, business, customer, templateLanguage = null, booking = null) =>
  splitMapping(mapping).body.map((entry) => resolveMappingEntry(entry, business, customer, templateLanguage, booking));

/**
 * Every value a send fills: { body: [...], header: [...], buttons: { [buttonIndex]: suffix } }.
 * header is empty / buttons has no keys when the template has none.
 */
const renderTemplateValues = (mapping, business, customer, templateLanguage = null, booking = null) => {
  const parts = splitMapping(mapping);
  const resolve = (entry) => resolveMappingEntry(entry, business, customer, templateLanguage, booking);
  return {
    body: parts.body.map(resolve),
    header: parts.header.map(resolve),
    buttons: Object.fromEntries(parts.button.map((entry) => [entry.buttonIndex, resolve(entry)]))
  };
};

/** The template body as it reads in the chat. */
const renderTemplateText = (bodyText, params) => (bodyText || '')
  .replace(/\{\{\s*(\d+)\s*\}\}/g, (mark, n) => (n >= 1 && n <= params.length ? String(params[n - 1]) : mark));

/** "9198*****210" — the start and the last digits of a number. */
const maskNumber = (n) => {
  const s = String(n || '');
  return s.length <= 6 ? s.replace(/\d(?=\d{2})/g, '*') : `${s.slice(0, 4)}${'*'.repeat(s.length - 7)}${s.slice(-3)}`;
};

module.exports = {
  PRESETS,
  RULES,
  WINDOW_MARGIN_MINUTES,
  BOOKING_TRIGGERS,
  LATE_GRACE_MINUTES,
  presetsForWeb,
  templateFilterFor,
  ruleFor,
  defaultText,
  countTemplateVariables,
  validateAutomation,
  rowToInput,
  isBookingTrigger,
  inboundTriggerKey,
  inactiveTriggerKey,
  completedTriggerKey,
  paymentTriggerKey,
  triggerKeyFor,
  dueRange,
  formatAmount,
  renderText,
  renderTemplateParams,
  renderTemplateValues,
  renderTemplateText,
  maskNumber
};
