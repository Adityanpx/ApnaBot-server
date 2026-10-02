// FlowSpec v2: a reply-only, tappable flow of PAGES — the shape the
// settings-driven bot builder (first preset: coaching, see
// coachingBotSettings.js) compiles into. Separate from flowSpec.js (v1,
// used by AI flow generation) so v1 and its endpoints stay untouched.
//
// Differences from v1: arbitrary depth (menu -> page -> page ...), a page can
// carry up to 3 buttons OR a list of up to 10 rows, and form-link replies
// (reply_kind 'web_form_trigger' + form_fields — the customer taps a link and
// fills a web form; submitting it creates a booking, see
// publicServiceForm.controller.js). No question nodes and no booking_trigger
// are ever emitted: every node is a reply node.
//
// Shape:
//   {
//     version: 2,
//     greeting: { text },                                  // menu body
//     menu: [ { title, description?, target } ],            // 1..10; <=3 -> buttons, 4..10 -> list
//     pages: [ { id, text, keyword?, aliases?, mediaId?,      // mediaId: business_media image above the message (not on list pages)
//                buttons?: [ { title, target } ],           // 1..3, OR
//                list?: [ { title, description?, target } ] } ],  // 1..10
//     forms: [ { id, text, buttonText, keyword?, aliases?, fields } ],  // fields: flowFieldsValidation.js shape
//     location?: { keyword? }                               // required if any target is { type: 'location' }
//   }
//   Optional translations on any text: greeting/page/form textTranslations,
//   form buttonTextTranslations, choice titleTranslations /
//   descriptionTranslations — { hi?: '...', mr?: '...' }, same limits as the
//   English; compiled to the node/edge *_translations columns.
//   target: { type: 'page', id } | { type: 'form', id } | { type: 'menu' } | { type: 'location' }
//
// Pure — no Supabase/Redis — same as flowSpec.js.
const { normalizeText, ID_PATTERN, GREETING_WORDS, LIMITS, DX, DY } = require('./flowSpec');
const { validateFlowFields } = require('./flowFieldsValidation');
const { isValidLanguageCode } = require('./languageCatalog');

const TARGET_TYPES = ['page', 'form', 'menu', 'location'];
const LOCATION_TAP_KEYWORD = 'menu_location';
const MENU_ID = 'tmp:menu';
const pageTapKeyword = (id) => `page_${id}`;
// business_media.id — saveFullGraph re-checks it is an image of this business.
const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const formTapKeyword = (id) => `form_${id}`;
const nodeIdFor = (target) => {
  if (target.type === 'menu') return MENU_ID;
  if (target.type === 'location') return 'tmp:location';
  return `tmp:${target.type}:${target.id}`;
};

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const len = (v) => v.trim().length;

/**
 * Optional per-language versions of a text ({ hi: '...', mr: '...' }) —
 * compiled to the node/edge *_translations columns the live chat sends to a
 * customer who chose that language. Same limit as the English text.
 */
const validateTranslationMap = (map, max, at) => {
  if (map === undefined || map === null) return null;
  if (typeof map !== 'object' || Array.isArray(map)) return `${at} must be an object`;
  for (const [code, text] of Object.entries(map)) {
    if (code === 'en' || !isValidLanguageCode(code)) return `${at} has an invalid language code "${code}"`;
    if (!isNonEmptyString(text)) return `${at}.${code} must be a non-empty string`;
    if (len(text) > max) return `${at}.${code} must be ${max} characters or less`;
  }
  return null;
};
const trimMap = (map) => (map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.trim()])) : null);

/**
 * Validates a set of tappable choices (the menu, a page's buttons or list).
 * asButtons decides the title limit; rows may carry a description only in
 * list form.
 */
const validateChoices = (choices, at, { asButtons, allowDescription, targetExists }) => {
  const titleMax = asButtons ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
  const titles = new Set();
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    const where = `${at}[${i}]`;
    if (!c || typeof c !== 'object') return `${where} must be an object`;
    if (!isNonEmptyString(c.title)) return `${where}.title is required`;
    if (len(c.title) > titleMax) return `${where}.title must be ${titleMax} characters or less (${asButtons ? 'button' : 'list row'})`;
    const t = c.title.trim().toLowerCase();
    if (titles.has(t)) return `${where}.title duplicates another choice's title`;
    titles.add(t);
    const titleTrError = validateTranslationMap(c.titleTranslations, titleMax, `${where}.titleTranslations`);
    if (titleTrError) return titleTrError;
    if (c.description !== undefined && c.description !== null) {
      if (!allowDescription) return `${where}.description is only allowed on list rows`;
      if (!isNonEmptyString(c.description)) return `${where}.description must be a non-empty string`;
      if (len(c.description) > LIMITS.LIST_ROW_DESCRIPTION) return `${where}.description must be ${LIMITS.LIST_ROW_DESCRIPTION} characters or less`;
    }
    if (c.descriptionTranslations !== undefined && c.descriptionTranslations !== null) {
      if (c.description === undefined || c.description === null) return `${where}.descriptionTranslations needs a description`;
      const descTrError = validateTranslationMap(c.descriptionTranslations, LIMITS.LIST_ROW_DESCRIPTION, `${where}.descriptionTranslations`);
      if (descTrError) return descTrError;
    }
    const target = c.target;
    if (!target || !TARGET_TYPES.includes(target.type)) return `${where}.target.type must be one of: ${TARGET_TYPES.join(', ')}`;
    if ((target.type === 'page' || target.type === 'form') && !targetExists(target)) {
      return `${where}.target ${target.type} "${target.id}" does not exist`;
    }
    if (target.type === 'location' && !targetExists(target)) return `${where} points at location, but spec.location is not set`;
  }
  return null;
};

/**
 * Validates a FlowSpec v2. Returns the first problem as a message, or null.
 * @param {Object} spec
 * @returns {string|null}
 */
const validateFlowSpecV2 = (spec) => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be an object';
  if (spec.version !== 2) return 'spec.version must be 2';
  if (!spec.greeting || !isNonEmptyString(spec.greeting.text)) return 'greeting.text is required';
  if (len(spec.greeting.text) > LIMITS.INTERACTIVE_BODY) return `greeting.text must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
  const greetingTrError = validateTranslationMap(spec.greeting.textTranslations, LIMITS.INTERACTIVE_BODY, 'greeting.textTranslations');
  if (greetingTrError) return greetingTrError;

  const pages = spec.pages === undefined ? [] : spec.pages;
  const forms = spec.forms === undefined ? [] : spec.forms;
  if (!Array.isArray(pages)) return 'pages must be an array';
  if (!Array.isArray(forms)) return 'forms must be an array';
  if (spec.location !== undefined && spec.location !== null && (typeof spec.location !== 'object' || Array.isArray(spec.location))) {
    return 'location must be an object';
  }

  const pageIds = new Set();
  const formIds = new Set();
  for (const [kind, list, ids] of [['pages', pages, pageIds], ['forms', forms, formIds]]) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== 'object') return `${kind}[${i}] must be an object`;
      if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return `${kind}[${i}].id must match ${ID_PATTERN}`;
      if (ids.has(item.id)) return `${kind}[${i}].id "${item.id}" is a duplicate`;
      ids.add(item.id);
    }
  }
  const targetExists = (t) => (t.type === 'page' ? pageIds.has(t.id)
    : t.type === 'form' ? formIds.has(t.id)
      : t.type === 'location' ? !!spec.location
        : true);

  if (!Array.isArray(spec.menu) || spec.menu.length === 0) return 'menu must have at least one item';
  if (spec.menu.length > LIMITS.MAX_LIST_ROWS) return `menu may have at most ${LIMITS.MAX_LIST_ROWS} items (WhatsApp list limit)`;
  const menuAsButtons = spec.menu.length <= LIMITS.MAX_BUTTONS;
  const menuError = validateChoices(spec.menu, 'menu', { asButtons: menuAsButtons, allowDescription: !menuAsButtons, targetExists });
  if (menuError) return menuError;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const at = `pages[${i}]`;
    if (!isNonEmptyString(page.text)) return `${at}.text is required`;
    const hasButtons = page.buttons !== undefined && page.buttons !== null;
    const hasList = page.list !== undefined && page.list !== null;
    if (hasButtons && hasList) return `${at} can have buttons or a list, not both`;
    const textMax = hasButtons || hasList ? LIMITS.INTERACTIVE_BODY : LIMITS.TEXT_BODY;
    if (len(page.text) > textMax) return `${at}.text must be ${textMax} characters or less`;
    const pageTrError = validateTranslationMap(page.textTranslations, textMax, `${at}.textTranslations`);
    if (pageTrError) return pageTrError;
    if (hasButtons) {
      if (!Array.isArray(page.buttons) || page.buttons.length === 0) return `${at}.buttons must have at least one button`;
      if (page.buttons.length > LIMITS.MAX_BUTTONS) return `${at} may have at most ${LIMITS.MAX_BUTTONS} buttons (WhatsApp limit)`;
      const err = validateChoices(page.buttons, `${at}.buttons`, { asButtons: true, allowDescription: false, targetExists });
      if (err) return err;
    }
    if (hasList) {
      if (!Array.isArray(page.list) || page.list.length === 0) return `${at}.list must have at least one row`;
      if (page.list.length > LIMITS.MAX_LIST_ROWS) return `${at}.list may have at most ${LIMITS.MAX_LIST_ROWS} rows (WhatsApp list limit)`;
      const err = validateChoices(page.list, `${at}.list`, { asButtons: false, allowDescription: true, targetExists });
      if (err) return err;
    }
    if (page.mediaId !== undefined && page.mediaId !== null) {
      if (typeof page.mediaId !== 'string' || !MEDIA_ID_PATTERN.test(page.mediaId)) return `${at}.mediaId must be a media id`;
      // WhatsApp list messages can't carry an image header.
      if (hasList) return `${at}: a list page can't have an image`;
    }
  }

  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const at = `forms[${i}]`;
    if (!isNonEmptyString(form.text)) return `${at}.text is required`;
    if (len(form.text) > LIMITS.INTERACTIVE_BODY) return `${at}.text must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
    if (!isNonEmptyString(form.buttonText)) return `${at}.buttonText is required`;
    if (len(form.buttonText) > LIMITS.BUTTON_TITLE) return `${at}.buttonText must be ${LIMITS.BUTTON_TITLE} characters or less`;
    const formTrError = validateTranslationMap(form.textTranslations, LIMITS.INTERACTIVE_BODY, `${at}.textTranslations`) ||
      validateTranslationMap(form.buttonTextTranslations, LIMITS.BUTTON_TITLE, `${at}.buttonTextTranslations`);
    if (formTrError) return formTrError;
    if (!Array.isArray(form.fields) || form.fields.filter(f => f && f.type !== 'display_text').length === 0) {
      return `${at}.fields must include at least one question`;
    }
    const fieldsError = validateFlowFields(form.fields);
    if (fieldsError) return `${at}.${fieldsError}`;
  }

  // Every page/form must be reachable: tapped from somewhere, or typable.
  const referenced = new Set();
  const collect = (choices) => (choices || []).forEach(c => referenced.add(`${c.target.type}:${c.target.id}`));
  collect(spec.menu);
  pages.forEach(p => { collect(p.buttons); collect(p.list); });
  for (const [kind, list] of [['page', pages], ['form', forms]]) {
    for (const item of list) {
      if (!referenced.has(`${kind}:${item.id}`) && !isNonEmptyString(item.keyword)) {
        return `${kind} "${item.id}" is not linked from anywhere and has no keyword — no customer could ever reach it`;
      }
    }
  }

  // Keywords, as the live matcher normalizes them (same rules as v1).
  const typed = [];
  for (const [kind, list] of [['pages', pages], ['forms', forms]]) {
    list.forEach((item, i) => {
      if (item.keyword !== undefined && item.keyword !== null && typeof item.keyword !== 'string') typed.push({ at: `${kind}[${i}].keyword`, bad: true });
      if (isNonEmptyString(item.keyword)) typed.push({ at: `${kind}[${i}].keyword`, value: item.keyword });
      if (item.aliases !== undefined && item.aliases !== null) {
        if (!Array.isArray(item.aliases) || item.aliases.some(a => !isNonEmptyString(a))) typed.push({ at: `${kind}[${i}].aliases`, bad: true });
        else if (!isNonEmptyString(item.keyword) && item.aliases.length > 0) typed.push({ at: `${kind}[${i}].aliases`, badNoKeyword: true });
        else item.aliases.forEach((a, j) => typed.push({ at: `${kind}[${i}].aliases[${j}]`, value: a }));
      }
    });
  }
  if (spec.location && isNonEmptyString(spec.location.keyword)) typed.push({ at: 'location.keyword', value: spec.location.keyword });

  const seen = new Map();
  for (const w of GREETING_WORDS) seen.set(w, 'the menu (greeting word)');
  pages.filter(p => !isNonEmptyString(p.keyword)).forEach(p => seen.set(normalizeText(pageTapKeyword(p.id)), `page "${p.id}" (tap-only)`));
  forms.filter(f => !isNonEmptyString(f.keyword)).forEach(f => seen.set(normalizeText(formTapKeyword(f.id)), `form "${f.id}" (tap-only)`));
  if (spec.location && !isNonEmptyString(spec.location.keyword)) seen.set(LOCATION_TAP_KEYWORD, 'the location reply (tap-only)');

  for (const entry of typed) {
    if (entry.bad) return `${entry.at} must be text`;
    if (entry.badNoKeyword) return `${entry.at}: aliases need a keyword too`;
    const norm = normalizeText(entry.value);
    if (norm.length < LIMITS.MIN_CONTAINS_KEYWORD) {
      return `${entry.at} "${entry.value}" must be at least ${LIMITS.MIN_CONTAINS_KEYWORD} characters (it is matched anywhere inside customer messages)`;
    }
    const greeting = GREETING_WORDS.find(g => g.includes(norm));
    if (greeting) return `${entry.at} "${entry.value}" clashes with the greeting word "${greeting}", which is reserved for the menu`;
    if (seen.has(norm)) return `${entry.at} "${entry.value}" duplicates the keyword of ${seen.get(norm)}`;
    seen.set(norm, entry.at);
  }

  return null;
};

/**
 * Compiles a FlowSpec v2 into the saveFullGraph payload (reply nodes only,
 * temp ids). Throws if the spec is invalid. Layout: breadth-first depth from
 * the menu = column, order of first reach = row; keyword-only nodes that
 * nothing links to go in column 1 after the rest.
 * @param {Object} spec
 * @returns {{ replyNodes: Object[], questionNodes: [], edges: Object[], warnings: string[] }}
 */
const compileFlowSpecV2 = (spec) => {
  const error = validateFlowSpecV2(spec);
  if (error) throw new Error(`Invalid FlowSpec v2: ${error}`);

  const pages = spec.pages || [];
  const forms = spec.forms || [];
  const warnings = [];
  const nodes = new Map();

  const typedFields = (item) => (isNonEmptyString(item.keyword)
    ? { keyword: item.keyword.trim(), matchType: 'contains', hindiAliases: (item.aliases || []).map(a => a.trim()) }
    : null);

  const menuAsButtons = spec.menu.length <= LIMITS.MAX_BUTTONS;
  nodes.set(MENU_ID, {
    id: MENU_ID, nodeType: 'reply', keyword: 'hi', matchType: 'exact',
    hindiAliases: GREETING_WORDS.filter(w => w !== 'hi'),
    replyKind: 'text', contentType: menuAsButtons ? 'buttons' : 'list', label: spec.greeting.text.trim(),
    ...(spec.greeting.textTranslations ? { labelTranslations: trimMap(spec.greeting.textTranslations) } : {})
  });
  for (const page of pages) {
    const hasButtons = Array.isArray(page.buttons);
    const hasList = Array.isArray(page.list);
    nodes.set(`tmp:page:${page.id}`, {
      id: `tmp:page:${page.id}`, nodeType: 'reply',
      ...(typedFields(page) || { keyword: pageTapKeyword(page.id), matchType: 'exact', hindiAliases: [] }),
      replyKind: 'text', contentType: hasButtons ? 'buttons' : hasList ? 'list' : 'text', label: page.text.trim(),
      ...(page.textTranslations ? { labelTranslations: trimMap(page.textTranslations) } : {}),
      // Optional image sent above the message (saveFullGraph resolves image_url)
      ...(page.mediaId ? { mediaId: page.mediaId } : {})
    });
  }
  for (const form of forms) {
    nodes.set(`tmp:form:${form.id}`, {
      id: `tmp:form:${form.id}`, nodeType: 'reply',
      ...(typedFields(form) || { keyword: formTapKeyword(form.id), matchType: 'exact', hindiAliases: [] }),
      replyKind: 'web_form_trigger', contentType: 'text', label: form.text.trim(),
      buttonText: form.buttonText.trim(), formFields: form.fields,
      ...(form.textTranslations ? { labelTranslations: trimMap(form.textTranslations) } : {}),
      ...(form.buttonTextTranslations ? { buttonTextTranslations: trimMap(form.buttonTextTranslations) } : {})
    });
  }
  if (spec.location) {
    nodes.set('tmp:location', {
      id: 'tmp:location', nodeType: 'reply',
      ...(isNonEmptyString(spec.location.keyword)
        ? { keyword: spec.location.keyword.trim(), matchType: 'contains', hindiAliases: [] }
        : { keyword: LOCATION_TAP_KEYWORD, matchType: 'exact', hindiAliases: [] }),
      replyKind: 'text', contentType: 'location', label: ''
    });
    warnings.push("The location reply sends the business's saved map location — make sure it is set correctly in Settings.");
  }

  const edges = [];
  const addChoices = (fromId, choices, isList) => choices.forEach((c, index) => {
    const description = isList && isNonEmptyString(c.description) ? c.description.trim() : null;
    edges.push({
      fromNodeId: fromId, toNodeId: nodeIdFor(c.target), label: c.title.trim(),
      description,
      condition: null, preset: null, displayOrder: index,
      ...(c.titleTranslations ? { labelTranslations: trimMap(c.titleTranslations) } : {}),
      ...(description && c.descriptionTranslations ? { descriptionTranslations: trimMap(c.descriptionTranslations) } : {})
    });
  });
  addChoices(MENU_ID, spec.menu, !menuAsButtons);
  for (const page of pages) {
    if (Array.isArray(page.buttons)) addChoices(`tmp:page:${page.id}`, page.buttons, false);
    if (Array.isArray(page.list)) addChoices(`tmp:page:${page.id}`, page.list, true);
  }

  // Layered layout by BFS depth from the menu.
  const depth = new Map([[MENU_ID, 0]]);
  const order = [MENU_ID];
  for (let i = 0; i < order.length; i++) {
    for (const e of edges.filter(x => x.fromNodeId === order[i])) {
      if (!depth.has(e.toNodeId)) { depth.set(e.toNodeId, depth.get(order[i]) + 1); order.push(e.toNodeId); }
    }
  }
  for (const id of nodes.keys()) if (!depth.has(id)) { depth.set(id, 1); order.push(id); }
  const rowsUsed = new Map();
  for (const id of order) {
    const d = depth.get(id);
    const row = rowsUsed.get(d) || 0;
    rowsUsed.set(d, row + 1);
    Object.assign(nodes.get(id), { positionX: d * DX, positionY: row * DY });
  }

  if (!menuAsButtons) {
    warnings.push(`The menu has ${spec.menu.length} items, so it is sent as a WhatsApp list (tap "Choose" to open) rather than buttons.`);
  }
  const typedKeywords = [...nodes.values()].filter(n => n.matchType === 'contains').map(n => normalizeText(n.keyword));
  for (const a of typedKeywords) {
    for (const b of typedKeywords) {
      if (a !== b && b.includes(a)) warnings.push(`Keyword "${a}" is contained in keyword "${b}" — a message with "${b}" may trigger either reply.`);
    }
  }

  return { replyNodes: [...nodes.values()], questionNodes: [], edges, warnings };
};

module.exports = {
  validateFlowSpecV2,
  compileFlowSpecV2,
  pageTapKeyword
};
