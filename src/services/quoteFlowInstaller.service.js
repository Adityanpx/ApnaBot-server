// src/services/quoteFlowInstaller.service.js
//
// Installs the chat travel-quote flow into ONE travel business's existing flow, as new flow_nodes / flow_edges:
//
//   entry   "Get a quote" button on the "Our Rates" reply (shown first)   and   a keyword reply (default "quote")
//   flow    tripType (One Way / Round Trip) -> routePicker -> passengers (1-4 / 5-6 / 7+)
//             One Way:    -> vehicle carousel
//             Round Trip: -> numberOfDays -> vehicle carousel (priced for those days)
//           -> travelDate -> pickupTime -> quote       (+ the typed "Other date" / "Other time" siblings, each with its own edge)
//
// WHAT IT NEVER DOES: modify, reorder or delete any existing node or edge, touch another business, a category
// template or the Travels default snapshot. Every row it creates has an id derived from the business id
// (utils/quoteFlowIds.js, UUIDv5), so "rollback" removes exactly those ids and nothing else, a second install is
// refused because they already exist, and the ids of two businesses can never collide (flow_nodes.id is a global key,
// and save_flow_graph_full would MOVE a row whose id another business owns).
//
// HOW IT WRITES: through save_flow_graph_full, the RPC the canvas editor saves with - one transaction, so either every
// new row exists or none does - called with ONLY the new rows (no deletes, no existing row in the payload). Before it
// writes it saves the business's current flow as a restore point (flow_snapshots, shown in the Versions tab). Afterwards
// it re-reads the graph and checks every pre-existing row is byte-identical, and flushes the bot-flow cache (flow:<id>).
//
// MAIN MENU: the menu ("hi") is usually a 3-button reply and WhatsApp shows at most 3 reply buttons (the sender cuts the
// rest), so a 4th button there would silently hide the last one. By default the entry is the Rates reply's button + the
// keyword. menuButton adds a first button to the main menu too, and is refused while that menu is a buttons reply that
// already has 3 buttons.
//
// REFUSES: Search cab AI (a live production business, found fresh in `businesses` by name and compared by id), a business
// that is not a travels / cab business, one without the travel_quotes switch on, one without at least one active route
// with an active One Way fare, a keyword (or alias) an active reply already answers, a business that already has a quote
// flow of its own, and a Round Trip with no offerable route unless the owner acknowledged "Round Trip goes to my team".
// Needs migration 20261105120000_flow_quote_node_types.sql applied (otherwise the RPC fails as a whole, nothing is written).
//
// Dry-run by default: run() with confirm false prints exactly what it would do and writes nothing.
// The CLI is src/scripts/installTravelQuoteFlow.js.
const { LIMITS } = require('../utils/flowSpec');
const { derive } = require('../utils/quoteFlowIds');

const PROTECTED_NAME = /search\s*cab/i;
const CATEGORIES = ['travels', 'cab'];
// The field keys that exist only in the quote flow. A business that already has a question with one of them has another
// flow in the way. (tripType, travelDate, pickupTime, numberOfDays and vehicleType are shared with the Travels default's
// own booking questions on purpose: the engine resolves a quote session's typed siblings inside the quote flow.)
const OWN_FIELD_KEYS = ['passengers', 'routePicker', 'quote'];

// ── Copy (en / hi / mr) ─────────────────────────────────────────────────────────────────────────
const tr = (en, hi, mr) => ({ en, hi, mr });
const opt = (value, en, hi, mr) => ({ value, label: en, labelTranslations: { hi, mr } });

const COPY = {
  triggerLabel: tr("Let's get your trip quote 🚕", 'आइए आपकी यात्रा का किराया निकालें 🚕', 'चला तुमच्या प्रवासाचे भाडे काढूया 🚕'),
  menuButton: tr('Get a quote', 'किराया जानें', 'भाडे जाणून घ्या'),
  tripType: tr('What type of trip do you need?', 'आपको किस तरह की यात्रा चाहिए?', 'तुम्हाला कोणत्या प्रकारचा प्रवास हवा आहे?'),
  tripTypeOptions: [opt('One Way', 'One Way', 'वन वे', 'वन वे'), opt('Round Trip', 'Round Trip', 'राउंड ट्रिप', 'राउंड ट्रिप')],
  routePicker: tr('Where do you want to go? 🚕', 'आप कहाँ जाना चाहते हैं? 🚕', 'तुम्हाला कुठे जायचे आहे? 🚕'),
  passengers: tr('How many people will travel?', 'कितने लोग यात्रा करेंगे?', 'किती लोक प्रवास करणार आहेत?'),
  passengerOptions: [
    opt('1-4', '1-4 people', '1-4 लोग', '1-4 लोक'),
    opt('5-6', '5-6 people', '5-6 लोग', '5-6 लोक'),
    opt('7+', '7 or more', '7 या उससे अधिक', '7 किंवा अधिक')
  ],
  vehicle: tr('Here are the vehicles available for your trip 👇', 'आपकी यात्रा के लिए उपलब्ध वाहन 👇', 'तुमच्या प्रवासासाठी उपलब्ध वाहने 👇'),
  travelDate: tr('When do you want to travel?', 'आप कब यात्रा करना चाहते हैं?', 'तुम्हाला कधी प्रवास करायचा आहे?'),
  travelDateOptions: [
    opt('Today', 'Today', 'आज', 'आज'), opt('Tomorrow', 'Tomorrow', 'कल', 'उद्या'), opt('Other date', 'Other date', 'दूसरी तारीख', 'दुसरी तारीख')
  ],
  travelDateManual: tr('Please type the travel date (DD/MM/YYYY).', 'कृपया यात्रा की तारीख लिखें (DD/MM/YYYY)।', 'कृपया प्रवासाची तारीख लिहा (DD/MM/YYYY).'),
  pickupTime: tr('What time should we pick you up?', 'हम आपको किस समय लेने आएँ?', 'आम्ही तुम्हाला किती वाजता घ्यायला यावे?'),
  pickupTimeOptions: [
    ...['5:00 AM', '6:00 AM', '8:00 AM', '10:00 AM', '2:00 PM', '6:00 PM', '9:00 PM', '11:00 PM'].map((t) => opt(t, t, t, t)),
    opt('Other time', 'Other time', 'दूसरा समय', 'दुसरी वेळ')
  ],
  pickupTimeManual: tr('Please type the pickup time, like 6:30 AM or 18:30.', 'कृपया पिकअप का समय लिखें, जैसे 6:30 AM या 18:30।', 'कृपया पिकअपची वेळ लिहा, जसे 6:30 AM किंवा 18:30.'),
  numberOfDays: tr('For how many days do you need the vehicle?', 'आपको वाहन कितने दिनों के लिए चाहिए?', 'तुम्हाला वाहन किती दिवसांसाठी हवे आहे?'),
  numberOfDaysOptions: Array.from({ length: 9 }, (_, i) => {
    const d = i + 1;
    return opt(String(d), d === 1 ? '1 day' : `${d} days`, `${d} दिन`, `${d} दिवस`);
  }),
  quote: tr('Preparing your quote…', 'आपका किराया तैयार हो रहा है…', 'तुमचे भाडे तयार होत आहे…')
};
const DEFAULT_KEYWORD = 'quote';
const DEFAULT_ALIASES = ['get a quote', 'quotation', 'कोटेशन'];

// ── The plan ────────────────────────────────────────────────────────────────────────────────────
const NODE_KEYS = [
  'id', 'node_type', 'keyword', 'match_type', 'hindi_aliases', 'reply_kind', 'trigger_count', 'content_type', 'label',
  'label_translations', 'image_url', 'media_id', 'field_key', 'summary_label', 'required', 'order', 'options', 'is_computed',
  'is_active', 'position_x', 'position_y', 'button_text', 'button_text_translations', 'form_fields', 'latitude', 'longitude',
  'location_name', 'address', 'form_title', 'form_title_translations', 'carousel_cards'
];
const EDGE_KEYS = ['id', 'from_node_id', 'to_node_id', 'label', 'label_translations', 'description', 'description_translations', 'condition', 'preset', 'display_order', 'card_index'];

const nodeRow = (over) => {
  const row = Object.fromEntries(NODE_KEYS.map((k) => [k, null]));
  Object.assign(row, { hindi_aliases: [], trigger_count: 0, required: false, options: [], is_computed: false, is_active: true, content_type: 'text' }, over);
  return row;
};
const edgeRow = (over) => {
  const row = Object.fromEntries(EDGE_KEYS.map((k) => [k, null]));
  return Object.assign(row, { display_order: 0 }, over);
};
const translated = (copy) => ({ label: copy.en, label_translations: { hi: copy.hi, mr: copy.mr } });
const question = (id, order, fieldKey, summaryLabel, copy, over = {}) => nodeRow({
  id, node_type: 'question', field_key: fieldKey, summary_label: summaryLabel, required: true, order, ...translated(copy), ...over
});

/**
 * The anchors in the business's existing flow: the "Our Rates" reply (keyword 'rates'), the main menu
 * (keyword 'hi'), and their buttons. Only ACTIVE replies count (a paused one is not what the bot answers with).
 */
const findAnchors = (nodes, edges) => {
  const replies = nodes.filter((n) => n.node_type === 'reply' && n.is_active !== false);
  const byKeyword = (kw) => replies.find((n) => String(n.keyword || '').trim().toLowerCase() === kw) || null;
  const outgoing = (node) => (node ? edges.filter((e) => e.from_node_id === node.id) : []);
  const rates = byKeyword('rates');
  const menu = byKeyword('hi');
  return { rates, ratesEdges: outgoing(rates), menu, menuEdges: outgoing(menu) };
};

/** Display order that puts a new button before the existing ones, without changing them. */
const firstOrder = (existingEdges) => Math.min(0, ...existingEdges.map((e) => e.display_order ?? 0)) - 1;

/**
 * @param {{ businessId: string, anchors: Object, menuButton?: boolean, ids?: Object, keyword?: string, aliases?: string[] }} args
 *   ids = derive(businessId) (default); keyword / aliases = the typed entry (aliases default to the English / Hindi
 *   synonyms only for the default keyword)
 * @returns {{ nodes: Object[], edges: Object[] }} rows exactly as save_flow_graph_full takes them
 */
const buildPlan = ({ businessId, anchors, menuButton = false, ids = derive(businessId), keyword = DEFAULT_KEYWORD, aliases = keyword === DEFAULT_KEYWORD ? DEFAULT_ALIASES : [] }) => {
  const { N, E } = ids;
  const nodes = [
    nodeRow({
      id: N.trigger, node_type: 'reply', keyword, match_type: 'exact', hindi_aliases: aliases,
      reply_kind: 'booking_trigger', content_type: 'text', ...translated(COPY.triggerLabel)
    }),
    question(N.tripType, 1, 'tripType', 'Trip type', COPY.tripType, { content_type: 'buttons', options: COPY.tripTypeOptions }),
    nodeRow({
      id: N.routePicker, node_type: 'route_picker', field_key: 'routePicker', summary_label: 'Route', required: true, order: 2,
      content_type: 'list', is_computed: true, ...translated(COPY.routePicker)
    }),
    question(N.passengers, 3, 'passengers', 'Passengers', COPY.passengers, { content_type: 'buttons', options: COPY.passengerOptions }),
    question(N.numberOfDays, 4, 'numberOfDays', 'Days', COPY.numberOfDays, { content_type: 'list', options: COPY.numberOfDaysOptions }),
    nodeRow({
      id: N.vehicle, node_type: 'vehicle_carousel', field_key: 'vehicleType', summary_label: 'Vehicle', required: true, order: 5,
      content_type: 'list', is_computed: true, ...translated(COPY.vehicle)
    }),
    question(N.travelDate, 6, 'travelDate', 'Date', COPY.travelDate, { content_type: 'buttons', options: COPY.travelDateOptions }),
    question(N.travelDateManual, 6, 'travelDate', 'Date', COPY.travelDateManual, { content_type: 'text' }),
    question(N.pickupTime, 7, 'pickupTime', 'Pickup time', COPY.pickupTime, { content_type: 'list', options: COPY.pickupTimeOptions }),
    question(N.pickupTimeManual, 7, 'pickupTime', 'Pickup time', COPY.pickupTimeManual, { content_type: 'text' }),
    nodeRow({
      id: N.quote, node_type: 'quote', field_key: 'quote', summary_label: 'Quote', required: true, order: 8,
      content_type: 'text', is_computed: true, ...translated(COPY.quote)
    })
  ];

  // Round Trip asks the days BEFORE the vehicles, so every vehicle card is priced for the days the customer gave. The
  // conditional passengers -> days edge has display_order -1, so it is tried before the unconditional passengers -> vehicle
  // edge (One Way, and anything that is not Round Trip, takes that one).
  const roundTrip = { field: 'tripType', equals: 'Round Trip' };
  const edges = [
    edgeRow({ id: E.triggerToTrip, from_node_id: N.trigger, to_node_id: N.tripType }),
    edgeRow({ id: E.tripToPicker, from_node_id: N.tripType, to_node_id: N.routePicker }),
    edgeRow({ id: E.pickerToPax, from_node_id: N.routePicker, to_node_id: N.passengers }),
    edgeRow({ id: E.paxToDays, from_node_id: N.passengers, to_node_id: N.numberOfDays, condition: roundTrip, display_order: -1 }),
    edgeRow({ id: E.daysToVehicle, from_node_id: N.numberOfDays, to_node_id: N.vehicle }),
    edgeRow({ id: E.paxToVehicle, from_node_id: N.passengers, to_node_id: N.vehicle }),
    edgeRow({ id: E.vehicleToDate, from_node_id: N.vehicle, to_node_id: N.travelDate }),
    edgeRow({ id: E.dateToTime, from_node_id: N.travelDate, to_node_id: N.pickupTime }),
    edgeRow({ id: E.dateManualToTime, from_node_id: N.travelDateManual, to_node_id: N.pickupTime }),
    edgeRow({ id: E.timeToQuote, from_node_id: N.pickupTime, to_node_id: N.quote }),
    edgeRow({ id: E.timeManualToQuote, from_node_id: N.pickupTimeManual, to_node_id: N.quote })
  ];

  const button = (id, fromNode, existingEdges) => edgeRow({
    id, from_node_id: fromNode.id, to_node_id: N.tripType, label: COPY.menuButton.en,
    label_translations: { hi: COPY.menuButton.hi, mr: COPY.menuButton.mr }, display_order: firstOrder(existingEdges)
  });
  if (anchors.rates) edges.push(button(E.rates, anchors.rates, anchors.ratesEdges));
  if (menuButton && anchors.menu) edges.push(button(E.menu, anchors.menu, anchors.menuEdges));
  return { nodes, edges };
};

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────

/** Problems with the copy itself: WhatsApp's limits (button 20, list row 24) and missing translations. */
const copyProblems = (plan) => {
  const problems = [];
  const check = (what, texts, max) => {
    for (const [lang, text] of Object.entries(texts)) {
      if (!text || !String(text).trim()) problems.push(`${what} (${lang}) is empty`);
      else if (max && String(text).length > max) problems.push(`${what} (${lang}) "${text}" is ${String(text).length} characters, max ${max}`);
    }
  };
  for (const node of plan.nodes) {
    const name = node.field_key || node.keyword;
    check(`${name} label`, { en: node.label, ...(node.label_translations || {}) });
    const max = node.content_type === 'buttons' ? LIMITS.BUTTON_TITLE : LIMITS.LIST_ROW_TITLE;
    for (const o of node.options || []) check(`${name} option "${o.value}"`, { en: o.label, ...(o.labelTranslations || {}) }, max);
    if ((node.options || []).length > LIMITS.MAX_LIST_ROWS) problems.push(`${name} has more than ${LIMITS.MAX_LIST_ROWS} options`);
    if (node.content_type === 'buttons' && (node.options || []).length > LIMITS.MAX_BUTTONS) problems.push(`${name} has more than ${LIMITS.MAX_BUTTONS} buttons`);
  }
  for (const edge of plan.edges.filter((e) => e.label)) check(`button "${edge.label}"`, { en: edge.label, ...(edge.label_translations || {}) }, LIMITS.BUTTON_TITLE);
  return problems;
};

/**
 * The new keyword reply must not take over a message an existing reply answers today, and must itself be reachable.
 * Every keyword and alias of every existing ACTIVE reply (the bot's rules cache loads active nodes only) is run through
 * the real matcher with and without the new node; then the new keyword and aliases are run through it with the node.
 */
const triggerShadowProblems = (existingNodes, newNodeRow) => {
  // Lazy: pulls in Redis through chatbot.service, which a test or a dry run of the pure parts does not need.
  const { matchNodeInList } = require('./chatbot.service');
  const { toCamelCase } = require('../utils/caseConvert');
  const before = existingNodes.filter((n) => n.node_type === 'reply' && n.is_active !== false).map(toCamelCase);
  const after = [...before, toCamelCase(newNodeRow)];
  const problems = [];
  const probes = new Set();
  for (const n of before) {
    if (n.keyword) probes.add(n.keyword);
    for (const alias of n.hindiAliases || []) probes.add(alias);
  }
  for (const text of probes) {
    for (const unicode of [false, true]) {
      const was = matchNodeInList(before, text, { unicode });
      const now = matchNodeInList(after, text, { unicode });
      if ((was && was.id) !== (now && now.id)) problems.push(`"${text}" would stop reaching its current reply (unicode=${unicode})`);
    }
  }
  for (const text of [newNodeRow.keyword, ...(newNodeRow.hindi_aliases || [])]) {
    const hit = matchNodeInList(after, text, { unicode: true });
    if (!hit || hit.id !== newNodeRow.id) problems.push(`"${text}" does not reach the new quote trigger (it reaches ${hit ? hit.keyword : 'nothing'})`);
  }
  return problems;
};

/** An active reply that already uses the keyword or an alias (case-insensitive, trimmed): the plain "taken" test. */
const takenWords = (nodes, words) => {
  const wanted = new Set(words.map((w) => String(w).trim().toLowerCase()).filter(Boolean));
  const taken = [];
  for (const n of nodes.filter((x) => x.node_type === 'reply' && x.is_active !== false)) {
    for (const word of [n.keyword, ...(n.hindi_aliases || [])]) {
      if (word && wanted.has(String(word).trim().toLowerCase())) taken.push(`"${String(word).trim()}" (reply ${n.keyword ? `"${n.keyword}"` : n.id})`);
    }
  }
  return taken;
};

/**
 * Where a customer of one trip type ends up when answering through the plan's own question edges. Used to prove,
 * before anything is written, that both paths reach the quote, One Way never meets the days question, and Round Trip
 * meets it exactly once, before the vehicles.
 */
const walkPlan = (plan, ids, tripType) => {
  const fieldOf = new Map(plan.nodes.map((n) => [n.id, n.field_key || `reply:${n.keyword}`]));
  const path = [];
  let current = ids.N.tripType;
  for (let hop = 0; hop < 30; hop++) {
    path.push(fieldOf.get(current) || current);
    if (current === ids.N.quote) return { ok: true, path };
    const next = plan.edges
      .filter((e) => e.from_node_id === current && !e.label)
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
      .find((e) => !e.condition || (e.condition.field === 'tripType' && e.condition.equals === tripType));
    if (!next) return { ok: false, path };
    current = next.to_node_id;
  }
  return { ok: false, path };
};
const pathProblems = (plan, ids) => {
  const problems = [];
  const oneWay = walkPlan(plan, ids, 'One Way');
  const roundTrip = walkPlan(plan, ids, 'Round Trip');
  for (const [name, walk] of [['One Way', oneWay], ['Round Trip', roundTrip]]) {
    if (!walk.ok) problems.push(`${name}: the path would not reach the quote (${walk.path.join(' > ')})`);
  }
  if (oneWay.path.includes('numberOfDays')) problems.push('One Way would be asked the days');
  const days = roundTrip.path.filter((f) => f === 'numberOfDays').length;
  if (days !== 1) problems.push(`Round Trip would ask the days ${days} times`);
  else if (roundTrip.path.indexOf('numberOfDays') > roundTrip.path.indexOf('vehicleType')) problems.push('Round Trip would ask the days after the vehicles');
  return problems;
};

const fingerprint = (rows) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));

/**
 * Everything about the flow itself that must hold before the plan is written, judged on the rows that are there WITHOUT
 * this installer's own (`baseNodes` / `baseEdges`). Pure.
 * @returns {{ checks: {ok:boolean,text:string}[], notes: string[], refusal: string|null, plan: Object|null, anchors: Object }}
 */
const planInstall = ({ businessId, baseNodes, baseEdges, options = {}, ids = derive(businessId) }) => {
  const menuButton = !!options.menuButton;
  const keyword = String(options.keyword || DEFAULT_KEYWORD).trim().toLowerCase();
  const aliases = options.aliases !== undefined && options.aliases !== null
    ? options.aliases.map((a) => String(a).trim()).filter(Boolean)
    : (keyword === DEFAULT_KEYWORD ? DEFAULT_ALIASES : []);
  const checks = [];
  const notes = [];
  const record = (ok, text) => { checks.push({ ok, text }); return ok; };
  const refuse = (refusal) => ({ checks, notes, refusal, plan: null, anchors: null });

  if (!record(keyword.length > 0 && keyword.length <= 40, `the entry keyword "${keyword}" is 1-40 characters`)) return refuse('the keyword must be 1-40 characters.');

  const foreign = baseNodes.filter((n) => n.node_type === 'route_picker' || n.node_type === 'quote');
  if (!record(foreign.length === 0, 'the business has no quote flow of its own already')) {
    return refuse('this business already has a route picker / quote node that is not this installer\'s; remove it in the canvas first.');
  }
  const clash = baseNodes.filter((n) => OWN_FIELD_KEYS.includes(n.field_key));
  if (!record(clash.length === 0, `no existing question uses the field keys ${OWN_FIELD_KEYS.join(' / ')}`)) {
    return refuse('an existing question already uses one of this flow\'s own field keys.');
  }
  const taken = takenWords(baseNodes, [keyword, ...aliases]);
  if (!record(taken.length === 0, `no active reply already uses the keyword "${keyword}" or its aliases`)) {
    return refuse(`already used by an active reply: ${taken.join(', ')}. Choose another keyword.`);
  }

  const anchors = findAnchors(baseNodes, baseEdges);
  if (anchors.rates) record(true, `"Our Rates" reply found (${anchors.ratesEdges.length} button(s) today)`);
  else notes.push('"Our Rates" reply not found - its button is skipped (the keyword entry still works)');
  if (anchors.rates && anchors.rates.content_type === 'buttons' && anchors.ratesEdges.length >= LIMITS.MAX_BUTTONS) {
    record(false, 'the "Our Rates" reply has room for one more button');
    return refuse(`the "Our Rates" reply already has ${anchors.ratesEdges.length} buttons (WhatsApp shows 3); a new one would hide another.`);
  }
  if (menuButton) {
    if (!anchors.menu) return refuse('--menu-button: the main menu reply (keyword "hi") was not found.');
    if (anchors.menu.content_type === 'buttons' && anchors.menuEdges.length >= LIMITS.MAX_BUTTONS) {
      return refuse(`--menu-button: the main menu is a buttons reply with ${anchors.menuEdges.length} buttons and WhatsApp shows at most 3 - a 4th would silently hide the last one. Switch the menu to a list in the canvas first, then re-run.`);
    }
    record(true, `main menu "${anchors.menu.keyword}" is ${anchors.menu.content_type} with ${anchors.menuEdges.length} button(s): room for one more`);
  } else if (anchors.menu) {
    notes.push(`main menu "${anchors.menu.keyword}" is a ${anchors.menu.content_type} reply with ${anchors.menuEdges.length} button(s) - left alone (use the menu button option once it has room)`);
  }

  const plan = buildPlan({ businessId, anchors, menuButton, ids, keyword, aliases });
  const copy = copyProblems(plan);
  if (!record(copy.length === 0, 'all copy fits WhatsApp limits (buttons 20, list rows 24) and has en / hi / mr')) return refuse(copy.join('; '));
  const shadow = triggerShadowProblems(baseNodes, plan.nodes.find((n) => n.id === ids.N.trigger));
  if (!record(shadow.length === 0, `the "${keyword}" keyword takes no message that an existing reply answers today`)) return refuse(shadow.join('; '));
  const paths = pathProblems(plan, ids);
  if (!record(paths.length === 0, 'One Way and Round Trip both reach the quote; Round Trip asks the days once, before the vehicles; One Way never does')) return refuse(paths.join('; '));
  return { checks, notes, refusal: null, plan, anchors };
};

/**
 * The business-level gate: what must be true of the business and its data before the flow is written. The checks that
 * need the database go through `deps`.
 * @returns {Promise<{ checks: {ok:boolean,text:string}[], notes: string[], refusal: string|null }>}
 */
const readinessGate = async ({ businessId, business, options = {}, deps }) => {
  const checks = [];
  const notes = [];
  const record = (ok, text) => { checks.push({ ok, text }); return ok; };
  const done = (refusal) => ({ checks, notes, refusal });

  if (!record(CATEGORIES.includes(business.business_category), `category is travels or cab (${business.business_category})`)) {
    return done('the quote flow is for travels / cab businesses only.');
  }
  if (!record(await deps.isQuotesEnabled(business.business_category, businessId), 'the travel_quotes switch is ON for this business')) {
    return done('travel_quotes is not switched on for this business (Super Admin > Features).');
  }
  const oneWay = await deps.listQuotableRoutes(businessId, 'oneway');
  if (!record(oneWay.length > 0, `at least one active route with an active One Way fare (${oneWay.length})`)) {
    return done('no active route with an active One Way fare - add routes on the Rates screen first.');
  }
  const roundTrip = await deps.listQuotableRoutes(businessId, 'round_trip');
  if (roundTrip.length > 0) record(true, `Round Trip can be priced on ${roundTrip.length} route(s)`);
  else if (options.ackRoundTripToTeam) notes.push('Round Trip has no priceable route: acknowledged - a Round Trip customer is handed to the owner\'s team at the route question');
  else {
    record(false, 'Round Trip can be priced on at least one route, or the owner acknowledged "Round Trip goes to my team"');
    return done('no route can be priced for Round Trip, so a Round Trip customer would be handed to the owner\'s team. Add distances / min km / rates, or acknowledge it (ackRoundTripToTeam).');
  }
  return done(null);
};

/** The ids of the live production business(es) that must never be written: found fresh in `businesses`, by name. */
const findProtectedBusinessIds = async (supabase) => {
  const { data, error } = await supabase.from('businesses').select('id, name, display_name');
  if (error) throw error;
  return (data || []).filter((b) => PROTECTED_NAME.test(`${b.name || ''} ${b.display_name || ''}`)).map((b) => b.id);
};

/** "Before quote flow - 2 Nov 2026 14:05 IST": same style as the copy-setup restore points. */
const snapshotName = (label) => {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return `${label} — ${day} ${time} IST`;
};

const describePlan = (plan, baseNodes, log) => {
  log('\nNodes:');
  for (const n of plan.nodes) {
    const what = n.node_type === 'reply' ? `reply  keyword "${n.keyword}" (${n.match_type}, aliases: ${n.hindi_aliases.join(' | ')})  ${n.reply_kind}` : `${n.node_type}  field ${n.field_key}  ${n.content_type}${n.is_computed ? '  computed' : ''}`;
    log(`  + ${n.id}  ${what}`);
    log(`      "${n.label}"  hi: "${n.label_translations.hi}"  mr: "${n.label_translations.mr}"`);
    if ((n.options || []).length > 0) log(`      options: ${n.options.map((o) => `${o.value}${o.label !== o.value ? ` (${o.label})` : ''}`).join(' | ')}`);
  }
  log('\nEdges:');
  const nameOf = (id) => {
    const own = plan.nodes.find((n) => n.id === id);
    if (own) return own.node_type === 'question' && own.content_type === 'text' ? `${own.field_key} (typed answer)` : (own.field_key || `reply:${own.keyword}`);
    const old = baseNodes.find((n) => n.id === id);
    return old ? `reply:${old.keyword}` : id;
  };
  for (const e of plan.edges) {
    const cond = e.condition ? `  if ${e.condition.field} = ${e.condition.equals}` : '';
    const btn = e.label ? `  button "${e.label}" (hi "${e.label_translations.hi}", mr "${e.label_translations.mr}") order ${e.display_order}` : '';
    log(`  + ${e.id}  ${nameOf(e.from_node_id)} -> ${nameOf(e.to_node_id)}${cond}${btn}  order ${e.display_order}`);
  }
};

// ── Orchestration (dependencies injected, so tests run it against an in-memory database) ───────────
/**
 * @param {{ mode: 'install'|'rollback', confirm: boolean, businessId: string, menuButton?: boolean, keyword?: string,
 *           aliases?: string[]|null, ackRoundTripToTeam?: boolean, expectNodes?: number|null, expectEdges?: number|null }} options
 * @param {{ supabase: Object, isQuotesEnabled: Function, listQuotableRoutes: Function, invalidateCache: Function,
 *           saveSnapshot: Function, findProtectedBusinessIds: Function, log: Function }} deps
 * @returns {Promise<number>} process exit code
 */
const run = async (options, deps) => {
  const { supabase, invalidateCache, saveSnapshot, log } = deps;
  const { mode, confirm, businessId, expectNodes = null, expectEdges = null } = options;
  const fail = (message) => { log(`\nREFUSED: ${message}`); return 1; };

  log(`MODE: ${mode === 'rollback' ? 'ROLLBACK' : 'INSTALL'} ${confirm ? '--confirm (writes)' : '(dry run - nothing is written)'}`);
  if (!businessId) return fail('a business id is required.');
  log(`Scope: business ${businessId}`);

  // The live production business is looked up fresh and compared by id, before anything of the business is read.
  const protectedIds = await deps.findProtectedBusinessIds();
  if (protectedIds.includes(businessId)) return fail('this is Search cab AI (a live production business); it is never written by the installer.');

  const read = async (table) => {
    const { data, error } = await supabase.from(table).select('*').eq('business_id', businessId);
    if (error) throw error;
    return data || [];
  };
  const { data: business, error: bizErr } = await supabase.from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;

  const checks = [];
  const record = (ok, text) => { checks.push({ ok, text }); log(`  ${ok ? '✓' : '✗'} ${text}`); return ok; };
  const printChecks = (list) => { for (const c of list) log(`  ${c.ok ? '✓' : '✗'} ${c.text}`); };
  log('\nPreconditions:');
  if (!record(!!business, 'the business exists')) return fail('business not found');
  record(true, `name: ${business.name}, category: ${business.business_category}`);
  record(true, 'it is not Search cab AI (compared by id)');

  const ids = derive(businessId);
  const ownNodeIds = new Set(ids.nodeIds);
  const ownEdgeIds = new Set(ids.edgeIds);
  const existingNodes = await read('flow_nodes');
  const existingEdges = await read('flow_edges');
  const installedNodes = existingNodes.filter((n) => ownNodeIds.has(n.id));
  const installedEdges = existingEdges.filter((e) => ownEdgeIds.has(e.id));
  const baseNodes = existingNodes.filter((n) => !ownNodeIds.has(n.id));
  const baseEdges = existingEdges.filter((e) => !ownEdgeIds.has(e.id));

  // ---------------------------------------------------------------- rollback
  if (mode === 'rollback') {
    log(`\nPlan: remove ${installedNodes.length} node(s) and ${installedEdges.length} edge(s) carrying this business's quote-flow ids; nothing else.`);
    for (const n of installedNodes) log(`  - node ${n.id}  ${n.node_type}  ${n.field_key || n.keyword}`);
    for (const e of installedEdges) log(`  - edge ${e.id}  ${e.from_node_id} -> ${e.to_node_id}${e.label ? `  "${e.label}"` : ''}`);
    if (installedNodes.length === 0 && installedEdges.length === 0) { log('\nNothing to roll back: the quote flow is not installed.'); return 0; }
    // Edges leaving or entering a removed node vanish with it; an edge that is not ours must not be left pointing at nothing.
    const strayEdges = baseEdges.filter((e) => ownNodeIds.has(e.from_node_id) || ownNodeIds.has(e.to_node_id));
    if (strayEdges.length > 0) return fail(`${strayEdges.length} edge(s) that are not the installer's connect to its nodes (${strayEdges.map((e) => e.id).join(', ')}); someone wired into the flow since. Remove those in the canvas first.`);
    if (!confirm) { log('\nDry run only. Re-run with --rollback --confirm to apply.'); return 0; }

    if (existingNodes.length > 0) {
      try {
        await saveSnapshot(businessId, snapshotName('Before removing the quote flow'), existingNodes, existingEdges);
        log('Restore point saved (Versions tab).');
      } catch (error) {
        return fail(`could not save a restore point (${error.message}). Nothing was changed.`);
      }
    }
    const { error } = await supabase.rpc('save_flow_graph_full', {
      p_business_id: businessId, p_node_upserts: [], p_node_deletes: installedNodes.map((n) => n.id), p_edge_upserts: [], p_edge_deletes: installedEdges.map((e) => e.id)
    });
    if (error) throw error;
    const afterNodes = await read('flow_nodes');
    const afterEdges = await read('flow_edges');
    const clean = !afterNodes.some((n) => ownNodeIds.has(n.id)) && !afterEdges.some((e) => ownEdgeIds.has(e.id));
    const untouched = fingerprint(afterNodes) === fingerprint(baseNodes) && fingerprint(afterEdges) === fingerprint(baseEdges);
    await invalidateCache(businessId);
    log(`\nRemoved. Own rows gone: ${clean ? 'yes' : 'NO'}. Every other node and edge unchanged: ${untouched ? 'yes' : 'NO'}. Flow cache flushed.`);
    return clean && untouched ? 0 : 2;
  }

  // ---------------------------------------------------------------- install
  if (!record(installedNodes.length === 0 && installedEdges.length === 0, 'not installed yet (none of this business\'s quote-flow ids exist)')) {
    log(`\nAlready installed: ${installedNodes.length} node(s), ${installedEdges.length} edge(s). Nothing to do (use --rollback to remove them).`);
    return 0;
  }
  const { data: strangers, error: strangerErr } = await supabase.from('flow_nodes').select('id').in('id', ids.nodeIds);
  if (strangerErr) throw strangerErr;
  if (!record((strangers || []).length === 0, 'none of the derived ids is used by another business')) return fail('one of the derived ids exists in another business');

  const gate = await readinessGate({ businessId, business, options, deps });
  printChecks(gate.checks);
  for (const note of gate.notes) log(`  i ${note}`);
  if (gate.refusal) return fail(gate.refusal);

  const flow = planInstall({ businessId, baseNodes, baseEdges, options, ids });
  printChecks(flow.checks);
  for (const note of flow.notes) log(`  i ${note}`);
  if (flow.refusal) return fail(flow.refusal);
  log('  i migration 20261105120000 (route_picker / quote node types) cannot be checked from here - it must be applied; if not, the write fails as a whole and nothing is written');

  const { plan } = flow;
  log(`\nPlan: create ${plan.nodes.length} node(s) and ${plan.edges.length} edge(s). Existing rows modified: 0, deleted: 0.`);
  describePlan(plan, baseNodes, log);

  if (expectNodes !== null && expectNodes !== plan.nodes.length) return fail(`--expect-nodes=${expectNodes} but the plan has ${plan.nodes.length} nodes.`);
  if (expectEdges !== null && expectEdges !== plan.edges.length) return fail(`--expect-edges=${expectEdges} but the plan has ${plan.edges.length} edges.`);
  if (!confirm) { log('\nDry run only. Re-run with --confirm to apply (optionally --expect-nodes / --expect-edges from the counts above).'); return 0; }

  if (existingNodes.length > 0) {
    try {
      await saveSnapshot(businessId, snapshotName('Before quote flow'), existingNodes, existingEdges);
      log('\nRestore point saved (Versions tab).');
    } catch (error) {
      return fail(`could not save a restore point (${error.message}). Nothing was changed.`);
    }
  }
  const { error } = await supabase.rpc('save_flow_graph_full', {
    p_business_id: businessId, p_node_upserts: plan.nodes, p_node_deletes: [], p_edge_upserts: plan.edges, p_edge_deletes: []
  });
  if (error) throw error;

  const afterNodes = await read('flow_nodes');
  const afterEdges = await read('flow_edges');
  const created = afterNodes.filter((n) => ownNodeIds.has(n.id)).length === plan.nodes.length && afterEdges.filter((e) => ownEdgeIds.has(e.id)).length === plan.edges.length;
  const untouched = fingerprint(afterNodes.filter((n) => !ownNodeIds.has(n.id))) === fingerprint(baseNodes) &&
    fingerprint(afterEdges.filter((e) => !ownEdgeIds.has(e.id))) === fingerprint(baseEdges);
  await invalidateCache(businessId);
  log(`\nCreated ${plan.nodes.length} node(s), ${plan.edges.length} edge(s): ${created ? 'all present' : 'MISSING ROWS'}. Every pre-existing node and edge byte-identical: ${untouched ? 'yes' : 'NO'}. Flow cache flushed.`);
  return created && untouched ? 0 : 2;
};

module.exports = {
  PROTECTED_NAME, CATEGORIES, OWN_FIELD_KEYS, COPY, DEFAULT_KEYWORD, DEFAULT_ALIASES,
  findAnchors, firstOrder, edgeRow, buildPlan, copyProblems, triggerShadowProblems, takenWords, walkPlan, pathProblems,
  planInstall, readinessGate, findProtectedBusinessIds, snapshotName, describePlan, fingerprint, run
};
