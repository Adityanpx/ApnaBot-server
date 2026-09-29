// FlowSpec v1: a small, business-facing description of a WhatsApp bot
// (greeting menu, FAQs, one chat booking, payment/contact replies) that
// compiles deterministically into the { replyNodes, questionNodes, edges }
// payload flowGraph.service.js#saveFullGraph accepts. Pure — no Supabase,
// no Redis, no requires outside utils — same as flowGraphValidation.js, so
// it can be unit-tested and run for a no-write /compile preview.
//
// Shape (every string is trimmed before length checks):
//   {
//     version: 1,
//     greeting: { text },                          // menu message body
//     menu: [ { id, title, description?,           // 1..10 items; <=3 -> buttons, 4..10 -> list
//               action: { type: 'faq', faqId } | { type: 'booking' } | { type: 'payment' }
//                     | { type: 'contact' } | { type: 'location' } } ],
//     faqs: [ { id, keyword?, aliases?, answer, backToMenu? } ],  // no keyword = tap-only
//     booking?: { keyword, intro?, fields: [ { key, label, summaryLabel?, required?,
//                 type: 'text' | 'choice' | 'location', options?: [ { value, label } ] } ] },
//     payment?: { keyword, text },
//     contact?: { keyword, text }
//   }
//
// Scope decisions (see the AI-flow design report; do not widen silently):
//   - Only plain reply nodes (text/buttons/list/location), booking_trigger,
//     payment_trigger, and 'question' nodes (text/buttons/list/
//     location_request) are ever emitted. No vehicle_carousel/rentalPackage,
//     no web_form_trigger, no edge conditions/presets, no images, no
//     translations.
//   - The booking question chain is only ever entered through the
//     booking_trigger node's single unconditional edge — saveFullGraph's
//     differential reachability check rejects any brand-new question node
//     not reachable that way (flowGraphValidation.js#
//     resolveBookingTriggerEntryNodeIds), and a menu button wired straight
//     to a question would not count.
//   - A booking_trigger node's own label is never sent to the customer
//     (webhook.controller.js Step 14 sends the first question's label), so
//     booking.intro is prefixed onto question 1's label instead.

// Must match webhook.controller.js's GREETING_KEYWORDS — duplicated rather
// than imported because requiring the webhook controller pulls in Redis/
// Supabase/queues. flowSpec.test.js asserts the two stay identical.
const GREETING_WORDS = ['hi', 'hello', 'hey', 'hii', 'hlo', 'namaste', 'start', 'menu'];

// Field keys a generated booking question may not use: the travel keys
// flowGraph.service.js guards (RESERVED_TRAVEL_FIELD_KEYS — asserted equal
// in flowSpec.test.js) plus the bookkeeping keys bookingGraph.service.js /
// booking.service.js write into session.collected themselves, which a
// same-named question would silently collide with.
const RESERVED_TRAVEL_FIELD_KEYS = ['tripType', 'pickupLocation', 'dropLocation', 'travelDate', 'pickupTime'];
const ENGINE_COLLECTED_KEYS = [
  'vehicleType', 'vehicleId', 'vehicleName', 'vehicleFare', 'fareSource', 'extraKmRate', 'extraHrRate',
  'distanceKm', 'routeFareId', 'rentalPackage', 'rentalPackageId', 'numberOfDays',
  'driverDaTotal', 'driverDaPerDay', 'driverDaDays'
];
const RESERVED_FIELD_KEYS = [...RESERVED_TRAVEL_FIELD_KEYS, ...ENGINE_COLLECTED_KEYS];

// Meta interactive-message limits (whatsapp.service.js truncates silently at
// send time; nothing checks them at save time, so they're enforced here).
const LIMITS = {
  INTERACTIVE_BODY: 1024,
  TEXT_BODY: 4096,
  BUTTON_TITLE: 20,
  LIST_ROW_TITLE: 24,
  LIST_ROW_DESCRIPTION: 72,
  MAX_BUTTONS: 3,
  MAX_LIST_ROWS: 10,
  MIN_CONTAINS_KEYWORD: 4,
  MAX_BOOKING_FIELDS: 10
};

const MENU_ACTION_TYPES = ['faq', 'booking', 'payment', 'contact', 'location'];
const FIELD_TYPES = ['text', 'choice', 'location'];
const ID_PATTERN = /^[a-z0-9_]{1,40}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;

const BACK_TO_MENU_LABEL = 'Main menu';
const LOCATION_KEYWORD = 'menu_location';
const faqTapKeyword = (faqId) => `faq_${faqId}`;

// Canvas layout (apnabot-web FlowGraphCanvas.tsx: NODE_WIDTH 240, dagre
// ranksep 140 / nodesep 44, tallest reply card ~148px).
const DX = 380;
const DY = 200;

// Mirrors chatbot.service.js#normalizeText (duplicated for the same reason
// as GREETING_WORDS) — duplicate detection must see keywords the way the
// live matcher does, e.g. "faq-a" and "faqa" collide there.
const normalizeText = (text) => (text || '')
  .toLowerCase()
  .trim()
  .replace(/[^\w\s]/g, '')
  .replace(/\s+/g, ' ');

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const len = (v) => v.trim().length;

// "Patient name?" -> "Patient name" — the field's own label (never the
// intro-prefixed node label) with trailing question marks dropped.
const toSummaryLabel = (label) => label.trim().replace(/\?+$/, '').trim() || label.trim();

/**
 * Validates a FlowSpec v1. Returns the first problem found as a message,
 * or null if valid — same convention as flowFieldsValidation.js.
 * @param {Object} spec
 * @returns {string|null}
 */
const validateFlowSpec = (spec) => {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be an object';
  if (spec.version !== 1) return 'spec.version must be 1';

  if (!spec.greeting || !isNonEmptyString(spec.greeting.text)) return 'greeting.text is required';
  if (len(spec.greeting.text) > LIMITS.INTERACTIVE_BODY) {
    return `greeting.text must be ${LIMITS.INTERACTIVE_BODY} characters or less`;
  }

  // ---- faqs ----
  const faqs = spec.faqs === undefined ? [] : spec.faqs;
  if (!Array.isArray(faqs)) return 'faqs must be an array';
  const faqIds = new Set();
  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    if (!faq || typeof faq !== 'object') return `faqs[${i}] must be an object`;
    if (typeof faq.id !== 'string' || !ID_PATTERN.test(faq.id)) {
      return `faqs[${i}].id must match ${ID_PATTERN} (lowercase letters, digits, underscore)`;
    }
    if (faqIds.has(faq.id)) return `faqs[${i}].id "${faq.id}" is a duplicate`;
    faqIds.add(faq.id);
    if (faq.keyword !== undefined && faq.keyword !== null && typeof faq.keyword !== 'string') {
      return `faqs[${i}].keyword must be a string`;
    }
    if (faq.aliases !== undefined && (!Array.isArray(faq.aliases) || faq.aliases.some(a => !isNonEmptyString(a)))) {
      return `faqs[${i}].aliases must be an array of non-empty strings`;
    }
    if (faq.aliases && faq.aliases.length > 0 && !isNonEmptyString(faq.keyword)) {
      return `faqs[${i}] has aliases but no keyword — a tap-only FAQ can't have typed aliases`;
    }
    if (!isNonEmptyString(faq.answer)) return `faqs[${i}].answer is required`;
    const answerMax = faq.backToMenu ? LIMITS.INTERACTIVE_BODY : LIMITS.TEXT_BODY;
    if (len(faq.answer) > answerMax) {
      return `faqs[${i}].answer must be ${answerMax} characters or less${faq.backToMenu ? ' (it carries a "Main menu" button)' : ''}`;
    }
    if (faq.backToMenu !== undefined && typeof faq.backToMenu !== 'boolean') {
      return `faqs[${i}].backToMenu must be a boolean`;
    }
  }

  // ---- booking ----
  if (spec.booking !== undefined && spec.booking !== null) {
    const booking = spec.booking;
    if (typeof booking !== 'object') return 'booking must be an object';
    if (!isNonEmptyString(booking.keyword)) return 'booking.keyword is required';
    if (booking.intro !== undefined && booking.intro !== null && typeof booking.intro !== 'string') {
      return 'booking.intro must be a string';
    }
    if (!Array.isArray(booking.fields) || booking.fields.length === 0) return 'booking.fields must have at least one field';
    if (booking.fields.length > LIMITS.MAX_BOOKING_FIELDS) {
      return `booking.fields may have at most ${LIMITS.MAX_BOOKING_FIELDS} fields`;
    }
    const keys = new Set();
    for (let i = 0; i < booking.fields.length; i++) {
      const field = booking.fields[i];
      const at = `booking.fields[${i}]`;
      if (!field || typeof field !== 'object') return `${at} must be an object`;
      if (typeof field.key !== 'string' || !FIELD_KEY_PATTERN.test(field.key)) {
        return `${at}.key must be camelCase letters/digits starting with a lowercase letter`;
      }
      if (RESERVED_FIELD_KEYS.includes(field.key)) {
        return `${at}.key "${field.key}" is reserved by the booking engine — pick another name`;
      }
      if (keys.has(field.key)) return `${at}.key "${field.key}" is a duplicate`;
      keys.add(field.key);
      if (!FIELD_TYPES.includes(field.type)) return `${at}.type must be one of: ${FIELD_TYPES.join(', ')}`;
      if (!isNonEmptyString(field.label)) return `${at}.label is required`;
      const intro = i === 0 && isNonEmptyString(booking.intro) ? `${booking.intro.trim()}\n\n` : '';
      const labelMax = field.type === 'text' ? LIMITS.TEXT_BODY : LIMITS.INTERACTIVE_BODY;
      if (intro.length + len(field.label) > labelMax) {
        return `${at}.label${intro ? ' (with booking.intro prefixed)' : ''} must be ${labelMax} characters or less`;
      }
      if (field.summaryLabel !== undefined && field.summaryLabel !== null && !isNonEmptyString(field.summaryLabel)) {
        return `${at}.summaryLabel must be a non-empty string`;
      }
      if (field.required !== undefined && typeof field.required !== 'boolean') return `${at}.required must be a boolean`;

      if (field.type === 'choice') {
        const options = field.options;
        if (!Array.isArray(options) || options.length < 2) return `${at} is a choice and needs at least 2 options`;
        if (options.length > LIMITS.MAX_LIST_ROWS) {
          return `${at} may have at most ${LIMITS.MAX_LIST_ROWS} options (WhatsApp list limit)`;
        }
        const titleMax = options.length <= LIMITS.MAX_BUTTONS ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
        const values = new Set();
        const labels = new Set();
        for (let j = 0; j < options.length; j++) {
          const opt = options[j];
          if (!opt || !isNonEmptyString(opt.value) || !isNonEmptyString(opt.label)) {
            return `${at}.options[${j}] needs a non-empty value and label`;
          }
          if (len(opt.label) > titleMax) {
            return `${at}.options[${j}].label must be ${titleMax} characters or less (${options.length <= LIMITS.MAX_BUTTONS ? 'button' : 'list row'})`;
          }
          const v = opt.value.trim().toLowerCase();
          const l = opt.label.trim().toLowerCase();
          if (values.has(v) || labels.has(l)) return `${at}.options[${j}] duplicates another option's value or label`;
          values.add(v);
          labels.add(l);
        }
      } else if (field.options !== undefined && field.options !== null &&
                 !(Array.isArray(field.options) && field.options.length === 0)) {
        return `${at}.options is only allowed for type "choice"`;
      }
    }
  }

  // ---- payment / contact ----
  for (const name of ['payment', 'contact']) {
    const block = spec[name];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object') return `${name} must be an object`;
    if (!isNonEmptyString(block.keyword)) return `${name}.keyword is required`;
    if (!isNonEmptyString(block.text)) return `${name}.text is required`;
    if (len(block.text) > LIMITS.TEXT_BODY) return `${name}.text must be ${LIMITS.TEXT_BODY} characters or less`;
  }

  // ---- menu ----
  if (!Array.isArray(spec.menu) || spec.menu.length === 0) return 'menu must have at least one item';
  if (spec.menu.length > LIMITS.MAX_LIST_ROWS) return `menu may have at most ${LIMITS.MAX_LIST_ROWS} items (WhatsApp list limit)`;
  const asButtons = spec.menu.length <= LIMITS.MAX_BUTTONS;
  const titleMax = asButtons ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
  const menuIds = new Set();
  const menuTitles = new Set();
  const faqsInMenu = new Set();
  for (let i = 0; i < spec.menu.length; i++) {
    const item = spec.menu[i];
    const at = `menu[${i}]`;
    if (!item || typeof item !== 'object') return `${at} must be an object`;
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return `${at}.id must match ${ID_PATTERN}`;
    if (menuIds.has(item.id)) return `${at}.id "${item.id}" is a duplicate`;
    menuIds.add(item.id);
    if (!isNonEmptyString(item.title)) return `${at}.title is required`;
    if (len(item.title) > titleMax) {
      return `${at}.title must be ${titleMax} characters or less (${asButtons ? 'button' : 'list row'})`;
    }
    const titleKey = item.title.trim().toLowerCase();
    if (menuTitles.has(titleKey)) return `${at}.title duplicates another menu item's title`;
    menuTitles.add(titleKey);
    if (item.description !== undefined && item.description !== null) {
      if (asButtons) return `${at}.description is only allowed when the menu has more than ${LIMITS.MAX_BUTTONS} items (a list)`;
      if (!isNonEmptyString(item.description)) return `${at}.description must be a non-empty string`;
      if (len(item.description) > LIMITS.LIST_ROW_DESCRIPTION) {
        return `${at}.description must be ${LIMITS.LIST_ROW_DESCRIPTION} characters or less`;
      }
    }
    const action = item.action;
    if (!action || !MENU_ACTION_TYPES.includes(action.type)) {
      return `${at}.action.type must be one of: ${MENU_ACTION_TYPES.join(', ')}`;
    }
    if (action.type === 'faq') {
      if (!faqIds.has(action.faqId)) return `${at}.action.faqId "${action.faqId}" does not match any faqs[].id`;
      faqsInMenu.add(action.faqId);
    }
    if (action.type === 'booking' && !spec.booking) return `${at} points at booking, but spec.booking is not set`;
    if (action.type === 'payment' && !spec.payment) return `${at} points at payment, but spec.payment is not set`;
    if (action.type === 'contact' && !spec.contact) return `${at} points at contact, but spec.contact is not set`;
  }

  for (let i = 0; i < faqs.length; i++) {
    if (!isNonEmptyString(faqs[i].keyword) && !faqsInMenu.has(faqs[i].id)) {
      return `faqs[${i}] has no keyword and is not in the menu — no customer could ever reach it`;
    }
  }

  // ---- keywords (as the live matcher normalizes them) ----
  // Every typed keyword/alias is matched with 'contains' (aliases always
  // are — chatbot.service.js's alias pass has no exact-only mode), so each
  // must be long enough not to fire inside unrelated messages, must not be
  // a greeting word, and must not be contained in one: the contains pass
  // runs BEFORE the alias pass that carries the menu's greeting words, so
  // e.g. a keyword "hell" would steal "hello" from the menu.
  const typed = [];
  faqs.forEach((f, i) => {
    if (isNonEmptyString(f.keyword)) typed.push({ at: `faqs[${i}].keyword`, value: f.keyword });
    (f.aliases || []).forEach((a, j) => typed.push({ at: `faqs[${i}].aliases[${j}]`, value: a }));
  });
  if (spec.booking) typed.push({ at: 'booking.keyword', value: spec.booking.keyword });
  if (spec.payment) typed.push({ at: 'payment.keyword', value: spec.payment.keyword });
  if (spec.contact) typed.push({ at: 'contact.keyword', value: spec.contact.keyword });

  const seen = new Map();
  for (const w of GREETING_WORDS) seen.set(w, 'the menu (greeting word)');
  for (const f of faqs) if (!isNonEmptyString(f.keyword)) seen.set(normalizeText(faqTapKeyword(f.id)), `faq "${f.id}" (tap-only)`);
  if (spec.menu.some(m => m.action.type === 'location')) seen.set(LOCATION_KEYWORD, 'the location reply (tap-only)');

  for (const { at, value } of typed) {
    const norm = normalizeText(value);
    if (norm.length < LIMITS.MIN_CONTAINS_KEYWORD) {
      return `${at} "${value}" must be at least ${LIMITS.MIN_CONTAINS_KEYWORD} characters (it is matched anywhere inside customer messages)`;
    }
    const greeting = GREETING_WORDS.find(g => g.includes(norm) || norm === g);
    if (greeting) return `${at} "${value}" clashes with the greeting word "${greeting}", which is reserved for the menu`;
    if (seen.has(norm)) return `${at} "${value}" duplicates the keyword of ${seen.get(norm)}`;
    seen.set(norm, at);
  }

  return null;
};

/**
 * Compiles a FlowSpec v1 into the saveFullGraph payload. Throws if the spec
 * is invalid (callers wanting a message should run validateFlowSpec first).
 * Node/edge ids are temp ids ("tmp:...") — saveFullGraph mints real ids and
 * remaps edges through its idMap. Every node carries positionX/positionY
 * from a layered grid: column 0 = menu, column 1 = everything the menu (or
 * a typed keyword) leads to, columns 2+ = the booking questions, laid out
 * along the booking trigger's own row.
 * @param {Object} spec
 * @returns {{ replyNodes: Object[], questionNodes: Object[], edges: Object[], warnings: string[] }}
 */
const compileFlowSpec = (spec) => {
  const error = validateFlowSpec(spec);
  if (error) throw new Error(`Invalid FlowSpec: ${error}`);

  const faqs = spec.faqs || [];
  const replyNodes = [];
  const questionNodes = [];
  const edges = [];
  const warnings = [];

  const asButtons = spec.menu.length <= LIMITS.MAX_BUTTONS;
  const MENU_ID = 'tmp:menu';
  replyNodes.push({
    id: MENU_ID, nodeType: 'reply', keyword: 'hi', matchType: 'exact',
    hindiAliases: GREETING_WORDS.filter(w => w !== 'hi'),
    replyKind: 'text', contentType: asButtons ? 'buttons' : 'list',
    label: spec.greeting.text.trim(), positionX: 0, positionY: 0
  });
  if (!asButtons) {
    warnings.push(`The menu has ${spec.menu.length} items, so it is sent as a WhatsApp list (tap "Choose" to open) rather than buttons.`);
  }

  // Column-1 targets, in first-reference order: menu order first, then
  // anything reachable only by a typed keyword.
  const column1 = [];
  const targetIdFor = {};
  const addTarget = (key, node) => {
    if (targetIdFor[key]) return targetIdFor[key];
    targetIdFor[key] = node.id;
    column1.push(node);
    return node.id;
  };

  const faqNode = (faq) => ({
    id: `tmp:faq:${faq.id}`, nodeType: 'reply',
    keyword: isNonEmptyString(faq.keyword) ? faq.keyword.trim() : faqTapKeyword(faq.id),
    matchType: isNonEmptyString(faq.keyword) ? 'contains' : 'exact',
    hindiAliases: (faq.aliases || []).map(a => a.trim()),
    replyKind: 'text', contentType: faq.backToMenu ? 'buttons' : 'text', label: faq.answer.trim()
  });
  const bookingNode = () => ({
    id: 'tmp:booking', nodeType: 'reply', keyword: spec.booking.keyword.trim(), matchType: 'contains',
    hindiAliases: [], replyKind: 'booking_trigger', contentType: 'text',
    // Never shown to the customer (webhook sends question 1's label) —
    // saveFullGraph's own default for this replyKind, set explicitly.
    label: 'Great! Let me collect your details.'
  });
  const simpleNode = (name, replyKind) => ({
    id: `tmp:${name}`, nodeType: 'reply', keyword: spec[name].keyword.trim(), matchType: 'contains',
    hindiAliases: [], replyKind, contentType: 'text', label: spec[name].text.trim()
  });
  const locationNode = () => ({
    id: 'tmp:location', nodeType: 'reply', keyword: LOCATION_KEYWORD, matchType: 'exact',
    hindiAliases: [], replyKind: 'text', contentType: 'location', label: ''
  });

  const nodeForAction = (action) => {
    switch (action.type) {
      case 'faq': return addTarget(`faq:${action.faqId}`, faqNode(faqs.find(f => f.id === action.faqId)));
      case 'booking': return addTarget('booking', bookingNode());
      case 'payment': return addTarget('payment', simpleNode('payment', 'payment_trigger'));
      case 'contact': return addTarget('contact', simpleNode('contact', 'text'));
      case 'location': return addTarget('location', locationNode());
      default: throw new Error(`unreachable: action ${action.type}`);
    }
  };

  spec.menu.forEach((item, index) => {
    const toNodeId = nodeForAction(item.action);
    edges.push({
      fromNodeId: MENU_ID, toNodeId, label: item.title.trim(),
      description: !asButtons && isNonEmptyString(item.description) ? item.description.trim() : null,
      condition: null, preset: null, displayOrder: index
    });
  });

  // Keyword-only entries not referenced by the menu still get a node.
  faqs.forEach(faq => nodeForAction({ type: 'faq', faqId: faq.id }));
  if (spec.booking) nodeForAction({ type: 'booking' });
  if (spec.payment) nodeForAction({ type: 'payment' });
  if (spec.contact) nodeForAction({ type: 'contact' });

  column1.forEach((node, row) => {
    node.positionX = DX;
    node.positionY = row * DY;
    replyNodes.push(node);
  });

  // "Main menu" button on FAQ answers. Reply-to-reply cycles are fine:
  // findCycles only walks the question subgraph.
  faqs.filter(f => f.backToMenu).forEach(faq => {
    edges.push({
      fromNodeId: `tmp:faq:${faq.id}`, toNodeId: MENU_ID, label: BACK_TO_MENU_LABEL,
      description: null, condition: null, preset: null, displayOrder: 0
    });
  });

  if (spec.booking) {
    const trigger = replyNodes.find(n => n.id === 'tmp:booking');
    const intro = isNonEmptyString(spec.booking.intro) ? `${spec.booking.intro.trim()}\n\n` : '';
    let previousId = trigger.id;
    spec.booking.fields.forEach((field, index) => {
      let contentType = 'text';
      let options = [];
      if (field.type === 'location') contentType = 'location_request';
      if (field.type === 'choice') {
        contentType = field.options.length <= LIMITS.MAX_BUTTONS ? 'buttons' : 'list';
        options = field.options.map(o => ({ value: o.value.trim(), label: o.label.trim() }));
      }
      const id = `tmp:q:${field.key}`;
      questionNodes.push({
        id, nodeType: 'question', fieldKey: field.key, contentType,
        label: (index === 0 ? intro : '') + field.label.trim(),
        // Always set: the confirmation summary falls back to the node's FULL
        // label when summaryLabel is null (bookingGraph.service.js records
        // label/summaryLabel into answeredFields; booking.service.js#
        // buildBookingSummaryBody prints summaryLabel || label), and question
        // 1's label carries booking.intro — so the fallback would print the
        // intro text into every confirmation.
        summaryLabel: isNonEmptyString(field.summaryLabel) ? field.summaryLabel.trim() : toSummaryLabel(field.label),
        required: field.required !== undefined ? field.required : true,
        order: index, options,
        positionX: DX * (2 + index), positionY: trigger.positionY
      });
      edges.push({
        fromNodeId: previousId, toNodeId: id, label: null, description: null,
        condition: null, preset: null, displayOrder: 0
      });
      previousId = id;
    });
  }

  if (spec.menu.some(m => m.action.type === 'location')) {
    warnings.push("The location reply sends the business's saved map location — make sure it is set in the business profile.");
  }

  // Overlapping typed keywords (one inside another) are legal but ambiguous:
  // a message containing the longer one also contains the shorter one, and
  // the matcher picks whichever node it happens to see first.
  const typedKeywords = replyNodes.filter(n => n.matchType === 'contains').map(n => normalizeText(n.keyword));
  for (const a of typedKeywords) {
    for (const b of typedKeywords) {
      if (a !== b && b.includes(a)) warnings.push(`Keyword "${a}" is contained in keyword "${b}" — a message with "${b}" may trigger either reply.`);
    }
  }

  assertBookingOnlyViaTrigger(replyNodes, questionNodes, edges);
  return { replyNodes, questionNodes, edges, warnings };
};

/**
 * Structural invariant (throws if broken — a compiler bug, not a spec
 * error): the only edge from a reply node into a question node is the
 * booking_trigger node's single unconditional entry edge.
 */
const assertBookingOnlyViaTrigger = (replyNodes, questionNodes, edges) => {
  const replyById = new Map(replyNodes.map(n => [n.id, n]));
  const questionIds = new Set(questionNodes.map(n => n.id));
  const entryEdges = edges.filter(e => replyById.has(e.fromNodeId) && questionIds.has(e.toNodeId));
  for (const e of entryEdges) {
    if (replyById.get(e.fromNodeId).replyKind !== 'booking_trigger' || e.condition) {
      throw new Error(`compileFlowSpec invariant: reply node ${e.fromNodeId} links straight into a booking question`);
    }
  }
  if (questionNodes.length > 0 && entryEdges.length !== 1) {
    throw new Error(`compileFlowSpec invariant: expected exactly one booking entry edge, found ${entryEdges.length}`);
  }
};

module.exports = {
  validateFlowSpec,
  compileFlowSpec,
  GREETING_WORDS,
  RESERVED_TRAVEL_FIELD_KEYS,
  RESERVED_FIELD_KEYS,
  LIMITS,
  DX,
  DY
};
