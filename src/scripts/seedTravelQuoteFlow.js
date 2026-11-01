// src/scripts/seedTravelQuoteFlow.js
//
// Adds the chat travel-quote flow to SG TRAVELS - and only SG Travels - as new flow_nodes / flow_edges:
//
//   entry   "Get a quote" button on the "Our Rates" reply (shown first)   and   the keyword "quote"
//   flow    tripType (One Way / Round Trip) -> routePicker -> passengers (1-4 / 5-6 / 7+) -> vehicle carousel
//           (rate-card fares, filtered by seats) -> travelDate -> pickupTime -> [numberOfDays if Round Trip]
//           -> quote           (+ the manual "Other date" / "Other time" siblings, each with its own edge)
//
// WHAT IT NEVER DOES: modify, reorder or delete any existing node or edge, or touch another business, the
// category templates or the Travel default snapshot. Every row it creates has a fixed id from the
// 5eed7a01-… range (the "tag"): --rollback removes exactly those ids and nothing else; running it twice
// is refused because those ids already exist.
//
// HOW IT WRITES: through save_flow_graph_full, the RPC the canvas editor saves with - one transaction, so
// either every new row exists or none does - called with ONLY the new rows (no deletes, no existing row in
// the payload). The editor's PUT /api/flow-graph/full could not be used instead: it deletes every row not
// echoed back, rewrites every column of every echoed row, and refuses the route_picker / quote node types.
// Afterwards it re-reads the graph and checks every pre-existing row is byte-identical, and flushes the
// bot-flow cache (flow:<id>).
//
// MAIN MENU: the menu ("hi") is a 3-button reply and WhatsApp shows at most 3 reply buttons (the sender cuts
// the rest), so a 4th button there would silently hide "Contact Us". By default the entry is the Rates
// reply's button + the keyword. --menu-button adds a first button to the main menu too, and is refused
// while that menu is a buttons reply that already has 3 buttons (switch it to a list in the canvas first).
//
// REFUSES: any business id other than SG Travels' (hard-coded), a business named like Search cab AI, a
// business without the travel_quotes switch on, or without at least one active route with an active fare.
// Needs migration 20261105120000_flow_quote_node_types.sql applied (otherwise the RPC fails as a whole and
// nothing is written).
//
// Dry-run by default (prints exactly what it would do, writes nothing). --confirm applies.
//
// Usage:
//   node src/scripts/seedTravelQuoteFlow.js                          (dry run)
//   node src/scripts/seedTravelQuoteFlow.js --confirm
//   node src/scripts/seedTravelQuoteFlow.js --menu-button            (dry run incl. the main-menu button)
//   node src/scripts/seedTravelQuoteFlow.js --rollback               (dry run: what would be removed)
//   node src/scripts/seedTravelQuoteFlow.js --rollback --confirm
//   --expect-nodes=N --expect-edges=M  abort unless the plan has exactly these counts (copy from the dry run)
const { LIMITS } = require('../utils/flowSpec');

const SG_TRAVELS_ID = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';
const REFUSED_NAME = /search\s*cab/i;

// ── Tag: fixed ids ──────────────────────────────────────────────────────────────────────────────
const tagId = (n) => `5eed7a01-0000-4000-8000-${String(n).padStart(12, '0')}`;
const N = {
  trigger: tagId(1), tripType: tagId(2), routePicker: tagId(3), passengers: tagId(4), vehicle: tagId(5),
  travelDate: tagId(6), travelDateManual: tagId(7), pickupTime: tagId(8), pickupTimeManual: tagId(9),
  numberOfDays: tagId(10), quote: tagId(11)
};
const E = {
  rates: tagId(101), menu: tagId(102), triggerToTrip: tagId(103), tripToPicker: tagId(104), pickerToPax: tagId(105),
  paxToVehicle: tagId(106), vehicleToDate: tagId(107), dateToTime: tagId(108), dateManualToTime: tagId(109),
  timeToDays: tagId(110), timeToQuote: tagId(111), timeManualToDays: tagId(112), timeManualToQuote: tagId(113), daysToQuote: tagId(114)
};
const NODE_ID_LIST = Object.values(N);
const EDGE_ID_LIST = Object.values(E);

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
const TRIGGER_KEYWORD = 'quote';
const TRIGGER_ALIASES = ['get a quote', 'quotation', 'कोटेशन'];

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
 * (the reply that has a button to the 'book' reply; keyword 'hi'), and their buttons.
 */
const findAnchors = (nodes, edges) => {
  const replies = nodes.filter((n) => n.node_type === 'reply');
  const byKeyword = (kw) => replies.find((n) => String(n.keyword || '').trim().toLowerCase() === kw) || null;
  const outgoing = (node) => (node ? edges.filter((e) => e.from_node_id === node.id) : []);
  const rates = byKeyword('rates');
  const menu = byKeyword('hi');
  return { rates, ratesEdges: outgoing(rates), menu, menuEdges: outgoing(menu) };
};

/** Display order that puts a new button before the existing ones, without changing them. */
const firstOrder = (existingEdges) => Math.min(0, ...existingEdges.map((e) => e.display_order ?? 0)) - 1;

/**
 * @param {{ businessId: string, anchors: Object, menuButton?: boolean }} args
 * @returns {{ nodes: Object[], edges: Object[] }} rows exactly as save_flow_graph_full takes them
 */
const buildPlan = ({ businessId, anchors, menuButton = false }) => {
  const nodes = [
    nodeRow({
      id: N.trigger, node_type: 'reply', keyword: TRIGGER_KEYWORD, match_type: 'exact', hindi_aliases: TRIGGER_ALIASES,
      reply_kind: 'booking_trigger', content_type: 'text', ...translated(COPY.triggerLabel)
    }),
    question(N.tripType, 1, 'tripType', 'Trip type', COPY.tripType, { content_type: 'buttons', options: COPY.tripTypeOptions }),
    nodeRow({
      id: N.routePicker, node_type: 'route_picker', field_key: 'routePicker', summary_label: 'Route', required: true, order: 2,
      content_type: 'list', is_computed: true, ...translated(COPY.routePicker)
    }),
    question(N.passengers, 3, 'passengers', 'Passengers', COPY.passengers, { content_type: 'buttons', options: COPY.passengerOptions }),
    nodeRow({
      id: N.vehicle, node_type: 'vehicle_carousel', field_key: 'vehicleType', summary_label: 'Vehicle', required: true, order: 4,
      content_type: 'list', is_computed: true, ...translated(COPY.vehicle)
    }),
    question(N.travelDate, 5, 'travelDate', 'Date', COPY.travelDate, { content_type: 'buttons', options: COPY.travelDateOptions }),
    question(N.travelDateManual, 5, 'travelDate', 'Date', COPY.travelDateManual, { content_type: 'text' }),
    question(N.pickupTime, 6, 'pickupTime', 'Pickup time', COPY.pickupTime, { content_type: 'list', options: COPY.pickupTimeOptions }),
    question(N.pickupTimeManual, 6, 'pickupTime', 'Pickup time', COPY.pickupTimeManual, { content_type: 'text' }),
    question(N.numberOfDays, 7, 'numberOfDays', 'Days', COPY.numberOfDays, { content_type: 'list', options: COPY.numberOfDaysOptions }),
    nodeRow({
      id: N.quote, node_type: 'quote', field_key: 'quote', summary_label: 'Quote', required: true, order: 8,
      content_type: 'text', is_computed: true, ...translated(COPY.quote)
    })
  ];

  const roundTrip = { field: 'tripType', equals: 'Round Trip' };
  const edges = [
    edgeRow({ id: E.triggerToTrip, from_node_id: N.trigger, to_node_id: N.tripType }),
    edgeRow({ id: E.tripToPicker, from_node_id: N.tripType, to_node_id: N.routePicker }),
    edgeRow({ id: E.pickerToPax, from_node_id: N.routePicker, to_node_id: N.passengers }),
    edgeRow({ id: E.paxToVehicle, from_node_id: N.passengers, to_node_id: N.vehicle }),
    edgeRow({ id: E.vehicleToDate, from_node_id: N.vehicle, to_node_id: N.travelDate }),
    edgeRow({ id: E.dateToTime, from_node_id: N.travelDate, to_node_id: N.pickupTime }),
    edgeRow({ id: E.dateManualToTime, from_node_id: N.travelDateManual, to_node_id: N.pickupTime }),
    edgeRow({ id: E.timeToDays, from_node_id: N.pickupTime, to_node_id: N.numberOfDays, condition: roundTrip, display_order: 0 }),
    edgeRow({ id: E.timeToQuote, from_node_id: N.pickupTime, to_node_id: N.quote, display_order: 1 }),
    edgeRow({ id: E.timeManualToDays, from_node_id: N.pickupTimeManual, to_node_id: N.numberOfDays, condition: roundTrip, display_order: 0 }),
    edgeRow({ id: E.timeManualToQuote, from_node_id: N.pickupTimeManual, to_node_id: N.quote, display_order: 1 }),
    edgeRow({ id: E.daysToQuote, from_node_id: N.numberOfDays, to_node_id: N.quote })
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
 * The new "quote" trigger must not take over a message an existing node answers today. Every keyword and
 * alias of every existing reply node is run through the real matcher with and without the new node.
 */
const triggerShadowProblems = (existingNodes, newNodeRow) => {
  // Lazy: pulls in Redis through chatbot.service, which a test or a dry run of the pure parts does not need.
  const { matchNodeInList } = require('../services/chatbot.service');
  const { toCamelCase } = require('../utils/caseConvert');
  const before = existingNodes.filter((n) => n.node_type === 'reply').map(toCamelCase);
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
  for (const text of [TRIGGER_KEYWORD, ...TRIGGER_ALIASES]) {
    const hit = matchNodeInList(after, text, { unicode: true });
    if (!hit || hit.id !== N.trigger) problems.push(`"${text}" does not reach the new quote trigger (it reaches ${hit ? hit.keyword : 'nothing'})`);
  }
  return problems;
};

const fingerprint = (rows) => JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : 1)));

// ── Orchestration (dependencies injected, so tests run it against an in-memory database) ───────────
/**
 * @param {{ mode: 'seed'|'rollback', confirm: boolean, menuButton: boolean, businessArg: string|null,
 *           expectNodes: number|null, expectEdges: number|null }} options
 * @param {{ supabase: Object, isQuotesEnabled: Function, listQuotableRoutes: Function, invalidateCache: Function, log: Function }} deps
 * @returns {Promise<number>} process exit code
 */
const run = async (options, deps) => {
  const { supabase, isQuotesEnabled, listQuotableRoutes, invalidateCache, log } = deps;
  const { mode, confirm, menuButton, businessArg, expectNodes, expectEdges } = options;
  const businessId = SG_TRAVELS_ID;
  const fail = (message) => { log(`\nREFUSED: ${message}`); return 1; };

  log(`MODE: ${mode === 'rollback' ? 'ROLLBACK' : 'SEED'} ${confirm ? '--confirm (writes)' : '(dry run - nothing is written)'}`);
  log(`Scope: business ${businessId} (SG Travels) only`);
  if (businessArg && businessArg !== businessId) return fail(`--business=${businessArg} is not SG Travels' id; this script works on ${businessId} only.`);

  const read = async (table, columns = '*') => {
    const { data, error } = await supabase.from(table).select(columns).eq('business_id', businessId);
    if (error) throw error;
    return data || [];
  };
  const { data: business, error: bizErr } = await supabase.from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;

  const checks = [];
  const record = (ok, text) => { checks.push({ ok, text }); log(`  ${ok ? '✓' : '✗'} ${text}`); return ok; };
  log('\nPreconditions:');
  if (!record(!!business, 'the business exists')) return fail('business not found');
  record(true, `name: ${business.name}, category: ${business.business_category}`);
  if (!record(!REFUSED_NAME.test(business.name || ''), 'it is not Search cab AI (a live production business)')) return fail('this is Search cab AI');
  if (!record(/sg\s*travels/i.test(business.name || '') && business.business_category === 'travels', 'it is SG Travels (category travels)')) return fail('not SG Travels');

  const existingNodes = await read('flow_nodes');
  const existingEdges = await read('flow_edges');
  const ownNodeIds = new Set(NODE_ID_LIST);
  const ownEdgeIds = new Set(EDGE_ID_LIST);
  const seededNodes = existingNodes.filter((n) => ownNodeIds.has(n.id));
  const seededEdges = existingEdges.filter((e) => ownEdgeIds.has(e.id));
  const baseNodes = existingNodes.filter((n) => !ownNodeIds.has(n.id));
  const baseEdges = existingEdges.filter((e) => !ownEdgeIds.has(e.id));

  // ---------------------------------------------------------------- rollback
  if (mode === 'rollback') {
    log(`\nPlan: remove ${seededNodes.length} node(s) and ${seededEdges.length} edge(s) carrying this script's ids (5eed7a01-…); nothing else.`);
    for (const n of seededNodes) log(`  - node ${n.id}  ${n.node_type}  ${n.field_key || n.keyword}`);
    for (const e of seededEdges) log(`  - edge ${e.id}  ${e.from_node_id} -> ${e.to_node_id}${e.label ? `  "${e.label}"` : ''}`);
    if (seededNodes.length === 0 && seededEdges.length === 0) { log('\nNothing to roll back: this script has not seeded SG Travels.'); return 0; }
    // Edges leaving or entering a removed node vanish with it; an edge of ours must not be the only thing left pointing at nothing.
    const strayEdges = baseEdges.filter((e) => ownNodeIds.has(e.from_node_id) || ownNodeIds.has(e.to_node_id));
    if (strayEdges.length > 0) return fail(`${strayEdges.length} edge(s) that are not this script's connect to its nodes (${strayEdges.map((e) => e.id).join(', ')}); someone wired into the flow since. Remove those in the canvas first.`);
    if (!confirm) { log('\nDry run only. Re-run with --rollback --confirm to apply.'); return 0; }

    const { error } = await supabase.rpc('save_flow_graph_full', {
      p_business_id: businessId, p_node_upserts: [], p_node_deletes: seededNodes.map((n) => n.id), p_edge_upserts: [], p_edge_deletes: seededEdges.map((e) => e.id)
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

  // ---------------------------------------------------------------- seed
  if (!record(seededNodes.length === 0 && seededEdges.length === 0, 'not seeded yet (none of this script\'s node / edge ids exist)')) {
    log(`\nAlready seeded: ${seededNodes.length} node(s), ${seededEdges.length} edge(s) carry this script's ids. Nothing to do (use --rollback to remove them).`);
    return 0;
  }
  const { data: strangers, error: strangerErr } = await supabase.from('flow_nodes').select('id').in('id', NODE_ID_LIST);
  if (strangerErr) throw strangerErr;
  if (!record((strangers || []).length === 0, 'none of the reserved ids is used by another business')) return fail('one of the reserved ids exists in another business');

  const quotesOn = await isQuotesEnabled(business.business_category, businessId);
  if (!record(quotesOn, 'the travel_quotes switch is ON for this business')) return fail('travel_quotes is not switched on for SG Travels (Super Admin > Features).');
  const routes = await listQuotableRoutes(businessId, 'oneway');
  if (!record(routes.length > 0, `at least one active route with an active fare (${routes.length} for One Way)`)) return fail('no active route with an active fare - add routes on the Rates screen first.');

  const anchors = findAnchors(baseNodes, baseEdges);
  if (anchors.rates) record(true, `"Our Rates" reply found (${anchors.ratesEdges.length} button(s) today)`);
  else log('  ! "Our Rates" reply not found - its button is skipped (the keyword entry still works)');
  if (anchors.rates && anchors.rates.content_type === 'buttons' && anchors.ratesEdges.length >= LIMITS.MAX_BUTTONS) {
    return fail(`the "Our Rates" reply already has ${anchors.ratesEdges.length} buttons (WhatsApp shows 3); a new one would hide another.`);
  }
  if (menuButton) {
    if (!anchors.menu) return fail('--menu-button: the main menu reply (keyword "hi") was not found.');
    if (anchors.menu.content_type === 'buttons' && anchors.menuEdges.length >= LIMITS.MAX_BUTTONS) {
      return fail(`--menu-button: the main menu is a buttons reply with ${anchors.menuEdges.length} buttons and WhatsApp shows at most 3 - a 4th would silently hide the last one. Switch the menu to a list in the canvas first, then re-run.`);
    }
    record(true, `main menu "${anchors.menu.keyword}" is ${anchors.menu.content_type} with ${anchors.menuEdges.length} button(s): room for one more`);
  } else if (anchors.menu) {
    log(`  i main menu "${anchors.menu.keyword}" is a ${anchors.menu.content_type} reply with ${anchors.menuEdges.length} button(s) - left alone (use --menu-button once it has room)`);
  }

  const plan = buildPlan({ businessId, anchors, menuButton });
  const copy = copyProblems(plan);
  if (!record(copy.length === 0, 'all copy fits WhatsApp limits (buttons 20, list rows 24) and has en / hi / mr')) return fail(copy.join('; '));
  const triggerRow = plan.nodes.find((n) => n.id === N.trigger);
  const shadow = triggerShadowProblems(baseNodes, triggerRow);
  if (!record(shadow.length === 0, 'the "quote" keyword takes no message that an existing reply answers today')) return fail(shadow.join('; '));
  const clash = baseNodes.filter((n) => n.field_key === 'tripType' || n.field_key === 'passengers' || n.field_key === 'routePicker');
  record(clash.length === 0, 'no existing question uses the field keys tripType / passengers / routePicker');
  if (clash.length > 0) return fail('an existing question already uses one of this flow\'s field keys.');
  log('  i migration 20261105120000 (route_picker / quote node types) cannot be checked from here - it must be applied; if not, the write fails as a whole and nothing is written');

  log(`\nPlan: create ${plan.nodes.length} node(s) and ${plan.edges.length} edge(s). Existing rows modified: 0, deleted: 0.`);
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
    log(`  + ${e.id}  ${nameOf(e.from_node_id)} -> ${nameOf(e.to_node_id)}${cond}${btn}`);
  }

  if (expectNodes !== null && expectNodes !== plan.nodes.length) return fail(`--expect-nodes=${expectNodes} but the plan has ${plan.nodes.length} nodes.`);
  if (expectEdges !== null && expectEdges !== plan.edges.length) return fail(`--expect-edges=${expectEdges} but the plan has ${plan.edges.length} edges.`);
  if (!confirm) { log('\nDry run only. Re-run with --confirm to apply (optionally --expect-nodes / --expect-edges from the counts above).'); return 0; }

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
  SG_TRAVELS_ID, N, E, NODE_ID_LIST, EDGE_ID_LIST, COPY, TRIGGER_KEYWORD, TRIGGER_ALIASES,
  findAnchors, firstOrder, buildPlan, copyProblems, triggerShadowProblems, run
};

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  const argValue = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const intArg = (name) => (argValue(name) === null ? null : Number(argValue(name)));
  const supabase = require('../config/supabase');
  const categoryFeatureService = require('../services/categoryFeature.service');
  const travelQuoteService = require('../services/travelQuote.service');
  const { invalidateRulesCache } = require('../services/chatbot.service');

  run({
    mode: process.argv.includes('--rollback') ? 'rollback' : 'seed',
    confirm: process.argv.includes('--confirm'),
    menuButton: process.argv.includes('--menu-button'),
    businessArg: argValue('business'),
    expectNodes: intArg('expect-nodes'),
    expectEdges: intArg('expect-edges')
  }, {
    supabase,
    isQuotesEnabled: (category, id) => categoryFeatureService.isEnabled(category, 'travel_quotes', id),
    listQuotableRoutes: (id, tripType) => travelQuoteService.listQuotableRoutes(id, tripType),
    invalidateCache: invalidateRulesCache,
    log: (line) => console.log(line)
  }).then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED (nothing was partially written - the write is one transaction):', err.message || err);
    process.exit(1);
  });
}
