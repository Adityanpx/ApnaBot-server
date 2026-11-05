// The "ready to enable the quote flow?" checklist the owner sees (GET /api/travel/quote-readiness).
//
// One list of items, each { key, status, title, detail, ... }:
//   ok     nothing to do
//   warn   the flow would run, but something the owner should know or fix (or acknowledge)
//   block  the quote flow cannot be enabled until this is fixed
// ready = no item blocks; enabled = the switch is on AND the flow is installed. A Round Trip with no priceable route does not block: it asks the owner to acknowledge
// "Round Trip goes to my team" (acknowledgements[], required: true), as decided.
//
// buildReadiness() is pure (facts in, checklist out) so every rule is tested without a database; getQuoteReadiness()
// gathers the facts with select-only reads and the same functions the bot and the installer use, so the checklist can
// not disagree with them: routes via travelQuote.service#listQuotableRoutes (the route picker's own source), the
// keyword / Rates button / flow checks via quoteFlowInstaller.service#planInstall, Search cab AI via
// quoteFlowInstaller.service#findProtectedBusinessIds.
const { derive } = require('../utils/quoteFlowIds');
const { minSeatsFor } = require('../utils/travelQuote');
const installer = require('./quoteFlowInstaller.service');
const { LIMITS } = require('../utils/flowSpec');

// Languages the quote texts are written in. Any other enabled language shows English until the owner presses Translate.
const BUILT_IN_LANGUAGES = ['en', 'hi', 'mr'];
// The passenger answers of the quote flow (installer COPY.passengerOptions) and the seats each one needs.
const PASSENGER_BANDS = ['1-4', '5-6', '7+'];

const item = (key, status, title, detail, extra = {}) => ({ key, status, title, detail, ...extra });
const names = (list, max = 5) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`);
const hasText = (map, lang) => !!(map && typeof map[lang] === 'string' && map[lang].trim() !== '');

/**
 * @param {Object} facts
 * @param {boolean} facts.protectedBusiness      the business is the live production bot that is never written
 * @param {string}  facts.category
 * @param {boolean} facts.featureOn              travel_quotes switch (category or business override)
 * @param {number}  facts.oneWayRoutes           routes the quote flow can offer for One Way
 * @param {number}  facts.roundTripRoutes        ... for Round Trip
 * @param {Object[]} facts.routes                GET /api/travel/routes rows (camelCase), listed ones only
 * @param {Object[]} facts.vehicles              { name, isActive, perKmRate, minKmPerDay, driverAllowancePerDay, seats }
 * @param {boolean} facts.settingsSaved          a travel_quote_settings row exists
 * @param {{ requireAdvancePayment:boolean, advancePaymentType:string|null, advancePaymentValue:number|null, hasPaymentQr:boolean, hasUpi:boolean }} facts.advance
 * @param {boolean} facts.whatsappConnected
 * @param {{ status:string, endDate:string|null }|null} facts.subscription
 * @param {string[]} facts.languages             enabled languages ('en' first)
 * @param {{ used:number, cap:number, remaining:number }|null} facts.usage   translation characters this month
 * @param {Object[]} facts.nodes                 flow_nodes rows (snake_case)
 * @param {Object[]} facts.edges                 flow_edges rows
 * @param {string}  facts.businessId
 * @param {{ keyword?:string, aliases?:string[] }} [facts.entry]
 */
const buildReadiness = (facts) => {
  const items = [];
  const add = (...args) => { items.push(item(...args)); };
  const ids = derive(facts.businessId);
  const ownNodes = facts.nodes.filter((n) => ids.nodeIds.includes(n.id));
  const ownEdges = facts.edges.filter((e) => ids.edgeIds.includes(e.id));
  const baseNodes = facts.nodes.filter((n) => !ids.nodeIds.includes(n.id));
  const baseEdges = facts.edges.filter((e) => !ids.edgeIds.includes(e.id));

  // ── installed state ───────────────────────────────────────────────────────────────────────────
  const foreign = baseNodes.filter((n) => n.node_type === 'route_picker' || n.node_type === 'quote');
  let installedState = 'not_installed';
  // 'dormant' = installed at signup and not switched on yet: the keyword reply is inactive AND the Rates button is not there.
  // (A paused keyword with its button still present, or a deleted button with an active keyword, is just 'installed'.)
  const dormantTrigger = ownNodes.find((n) => n.id === ids.N.trigger);
  if (ownNodes.length === ids.nodeIds.length) {
    installedState = dormantTrigger && dormantTrigger.is_active === false && !ownEdges.some((e) => e.id === ids.E.rates) ? 'dormant' : 'installed';
  } else if (ownNodes.length > 0 || ownEdges.length > 0) installedState = 'partial';
  else if (foreign.length > 0) installedState = 'conflict';
  const installed = { state: installedState, nodes: ownNodes.length, edges: ownEdges.length };

  // ── the business itself ───────────────────────────────────────────────────────────────────────
  if (facts.protectedBusiness) {
    add('not_protected', 'block', 'Managed by hand', 'This business is a live production bot; the quote flow is never installed here from the app.');
  }
  const travel = installer.CATEGORIES.includes(facts.category);
  add('category', travel ? 'ok' : 'block', 'Travel business', travel ? `Category ${facts.category}.` : 'The quote flow is for travels and cab businesses only.');
  // Not a blocker: pressing "Enable quotes" is what switches it on (services/quoteFlowSwitch.service.js).
  add('feature', facts.featureOn ? 'ok' : 'warn', 'Quotes switched on for your business',
    facts.featureOn ? 'Travel quotes are switched on.' : 'Travel quotes are switched off. Pressing Enable quotes switches them on.');

  // ── routes and fares ──────────────────────────────────────────────────────────────────────────
  const activeRoutes = facts.routes.filter((r) => r.isActive !== false);
  add('routes_one_way', facts.oneWayRoutes > 0 ? 'ok' : 'block', 'One Way routes',
    facts.oneWayRoutes > 0
      ? `${facts.oneWayRoutes} route(s) have an active One Way price.`
      : 'Add at least one route with a One Way price for an active vehicle (Rates > Routes).', { count: facts.oneWayRoutes });
  const reasons = {};
  for (const route of activeRoutes) if (route.roundTrip && route.roundTrip.ready === false) reasons[route.roundTrip.reason] = (reasons[route.roundTrip.reason] || 0) + 1;
  const reasonText = Object.entries(reasons).map(([reason, n]) => `${n} x ${reason.replace(/_/g, ' ')}`).join(', ');
  if (facts.roundTripRoutes > 0) {
    add('routes_round_trip', 'ok', 'Round Trip routes', `${facts.roundTripRoutes} route(s) can be priced for Round Trip${reasonText ? ` (not ready: ${reasonText})` : ''}.`, { count: facts.roundTripRoutes });
  } else {
    add('routes_round_trip', 'warn', 'Round Trip routes',
      `No route can be priced for Round Trip${reasonText ? ` (${reasonText})` : ''}. Add a distance, a minimum km and a per-km rate, or a fixed Round Trip price. Until then a Round Trip customer is handed to your team.`,
      { count: 0, requiresAcknowledgement: 'round_trip_to_team' });
  }

  // ── vehicles ──────────────────────────────────────────────────────────────────────────────────
  const vehicles = facts.vehicles.filter((v) => v.isActive !== false);
  const missing = [];
  for (const v of vehicles) {
    const gaps = [];
    if (!(Number(v.perKmRate) > 0)) gaps.push('per-km rate');
    if (!(Number(v.minKmPerDay) > 0)) gaps.push('minimum km per day');
    if (v.driverAllowancePerDay === null || v.driverAllowancePerDay === undefined) gaps.push('driver allowance (counted as 0)');
    if (gaps.length > 0) missing.push(`${v.name} (${gaps.join(', ')})`);
  }
  add('vehicles', missing.length === 0 ? 'ok' : 'warn', 'Vehicle rates',
    missing.length === 0 ? `${vehicles.length} active vehicle(s) have a rate, minimum km and allowance.`
      : `Round Trip by km needs these on each vehicle (Fleet): ${names(missing)}. A vehicle without a fixed Round Trip price and without them is quoted "our team will confirm".`,
    { vehicles: missing });

  const unknownSeats = vehicles.filter((v) => v.seats === null || v.seats === undefined).map((v) => v.name);
  const uncovered = PASSENGER_BANDS.filter((band) => {
    const needed = minSeatsFor(band);
    return !vehicles.some((v) => v.seats === null || v.seats === undefined || v.seats >= needed);
  });
  if (uncovered.length > 0) {
    add('seats', 'warn', 'Seats', `No vehicle fits ${uncovered.map((b) => `"${b}" people`).join(' or ')}: those customers are handed to your team.${unknownSeats.length ? ` Seats unknown for ${names(unknownSeats)}.` : ''}`, { uncovered, unknownSeats });
  } else if (unknownSeats.length > 0) {
    add('seats', 'warn', 'Seats', `Seats are not set for ${names(unknownSeats)}: they are offered to every group size, even one they cannot carry.`, { uncovered, unknownSeats });
  } else {
    add('seats', 'ok', 'Seats', 'Every group size has a vehicle that fits.', { uncovered, unknownSeats });
  }

  // ── settings, advance, payment ────────────────────────────────────────────────────────────────
  add('settings', facts.settingsSaved ? 'ok' : 'warn', 'Quote settings reviewed',
    facts.settingsSaved ? 'Night charge, minimum charge, validity and the allowance basis are saved.'
      : 'Not saved yet: quotes use the defaults (no night charge, no minimum charge, valid 24 hours, allowance per day). Open Rates > Settings and save once to confirm.');
  const adv = facts.advance;
  if (!adv.requireAdvancePayment) {
    add('advance', 'warn', 'Advance payment', 'No advance is asked: when a customer taps Confirm, the booking is confirmed straight away without any payment.');
  } else if (!adv.hasPaymentQr) {
    add('advance', 'warn', 'Advance payment', 'An advance is asked but no payment QR is saved: customers are told your team will share the payment details.');
  } else {
    add('advance', 'ok', 'Advance payment',
      `An advance of ${adv.advancePaymentType === 'percentage' ? `${adv.advancePaymentValue}%` : `Rs ${adv.advancePaymentValue}`} is asked and the payment QR is saved${adv.hasUpi ? ' with the UPI id' : ' (no UPI id shown)'}.`);
  }

  // ── WhatsApp and subscription ─────────────────────────────────────────────────────────────────
  add('whatsapp', facts.whatsappConnected ? 'ok' : 'warn', 'WhatsApp connected',
    facts.whatsappConnected ? 'A WhatsApp number is connected.' : 'No WhatsApp number is connected: nothing reaches customers until it is.');
  add('subscription', facts.subscription ? 'ok' : 'warn', 'Plan active',
    facts.subscription ? `Plan ${facts.subscription.status}${facts.subscription.endDate ? ` until ${String(facts.subscription.endDate).slice(0, 10)}` : ''}.` : 'No active plan or trial: the bot does not answer customers.');

  // ── the flow: keyword, Rates button, anything else in the way ─────────────────────────────────
  const entry = facts.entry || {};
  // A dormant install already has its keyword; unless the owner is considering another one, that is the one checked.
  const stored = installedState === 'dormant' && dormantTrigger && !entry.keyword ? dormantTrigger : null;
  const keyword = String(entry.keyword || (stored && stored.keyword) || installer.DEFAULT_KEYWORD).trim().toLowerCase();
  const aliases = entry.aliases || (stored ? (stored.hindi_aliases || []) : (keyword === installer.DEFAULT_KEYWORD ? installer.DEFAULT_ALIASES : []));
  if (installedState === 'installed') {
    add('keyword', 'ok', 'Keyword', 'The quote flow is installed.');
    add('rates_button', 'ok', 'Rates button', 'The quote flow is installed.');
    add('flow', 'ok', 'Flow', 'The quote flow is installed.');
  } else {
    const taken = installer.takenWords(baseNodes, [keyword, ...aliases]);
    add('keyword', taken.length === 0 ? 'ok' : 'block', 'Keyword',
      taken.length === 0 ? `"${keyword}" is free.` : `Already used by an active reply: ${taken.join(', ')}. Choose another keyword.`, { keyword, aliases });
    const anchors = installer.findAnchors(baseNodes, baseEdges);
    let ratesStatus = 'ok';
    let ratesText = `The "Our Rates" reply has room for a "Get a quote" button (${anchors.ratesEdges.length} button(s) today).`;
    if (!anchors.rates) {
      ratesStatus = 'warn';
      ratesText = 'There is no "Our Rates" reply, so there is no button: customers start a quote by typing the keyword.';
    } else if (anchors.rates.content_type === 'buttons' && anchors.ratesEdges.length >= LIMITS.MAX_BUTTONS) {
      ratesStatus = 'block';
      ratesText = `The "Our Rates" reply already has ${anchors.ratesEdges.length} buttons and WhatsApp shows 3: a new one would hide another. Remove a button first.`;
    }
    add('rates_button', ratesStatus, 'Rates button', ratesText);
    // Everything else the installer would refuse (an existing quote flow, a field key of its own, a shadowed message ...)
    const flow = installer.planInstall({ businessId: facts.businessId, baseNodes, baseEdges, options: { keyword, aliases }, ids });
    const explained = taken.length > 0 || ratesStatus === 'block';
    if (flow.refusal && !explained) add('flow', 'block', 'Flow', flow.refusal);
    else add('flow', installedState === 'partial' || installedState === 'conflict' ? 'block' : 'ok', 'Flow',
      installedState === 'partial' ? 'A half-installed quote flow was found: remove it (rollback) and install again.'
        : installedState === 'conflict' ? 'The business already has a route picker / quote node of its own.'
          : 'Nothing in the existing flow is in the way; it is left exactly as it is.');
  }

  // ── languages and translation budget ──────────────────────────────────────────────────────────
  const others = facts.languages.filter((l) => l !== 'en');
  const notBuiltIn = others.filter((l) => !BUILT_IN_LANGUAGES.includes(l));
  const routeGaps = {};
  for (const lang of others) {
    routeGaps[lang] = activeRoutes.filter((r) => r.id
      && (!hasText(r.fromLabelTranslations, lang) || !hasText(r.toLabelTranslations, lang) || (r.region && !hasText(r.regionTranslations, lang)))).length;
  }
  const gapLangs = Object.entries(routeGaps).filter(([, n]) => n > 0);
  const langProblems = [];
  if (notBuiltIn.length > 0) langProblems.push(`the quote texts are written in English, Hindi and Marathi; ${notBuiltIn.join(', ')} show English until you press Translate`);
  if (gapLangs.length > 0) langProblems.push(`route names are not translated: ${gapLangs.map(([l, n]) => `${l} (${n})`).join(', ')}`);
  add('languages', langProblems.length === 0 ? 'ok' : 'warn', 'Languages',
    langProblems.length === 0 ? `Customers in ${facts.languages.join(', ')} get the quote in their language.` : `${langProblems.join('; ')}. A language you switch on later needs a Translate run too.`,
    { languages: facts.languages, notBuiltIn, routeGaps });
  if (facts.usage) {
    const needsTranslate = langProblems.length > 0;
    add('translation_budget', needsTranslate && facts.usage.remaining === 0 ? 'warn' : 'ok', 'Translation budget',
      `${facts.usage.remaining} of ${facts.usage.cap} translation characters left this month.`, { usage: facts.usage });
  }

  const ready = !items.some((i) => i.status === 'block');
  const acknowledgements = [{
    key: 'round_trip_to_team',
    text: 'Round Trip goes to my team',
    required: facts.roundTripRoutes === 0
  }];
  return { ready, enabled: !!facts.featureOn && installedState === 'installed', installed, keyword: { value: keyword, aliases }, acknowledgements, items };
};

// ── Gathering the facts (select-only) ───────────────────────────────────────────────────────────

const defaultDeps = () => {
  const supabase = require('../config/supabase');
  return {
    supabase,
    isEnabled: (category, businessId) => require('./categoryFeature.service').isEnabled(category, 'travel_quotes', businessId),
    listQuotableRoutes: (businessId, tripType) => require('./travelQuote.service').listQuotableRoutes(businessId, tripType),
    listRoutes: (businessId) => require('./travelRoute.service').listRoutes(businessId),
    getSubscription: async (businessId) => (await require('./currentSubscription.service').getCurrentSubscriptionRow(businessId, { statuses: ['active', 'trial'] })).data,
    getUsage: (businessId) => require('./translation.service').getUsage(businessId),
    findProtectedBusinessIds: () => installer.findProtectedBusinessIds(supabase)
  };
};

/**
 * @param {string} businessId
 * @param {{ keyword?: string, aliases?: string[] }} [entry]  the keyword the owner is considering (default "quote")
 * @param {Object} [overrides]  dependencies, for tests
 */
const getQuoteReadiness = async (businessId, entry = {}, overrides = {}) => {
  const deps = { ...defaultDeps(), ...overrides };
  const { supabase } = deps;
  const must = ({ data, error }) => { if (error) throw error; return data; };

  const business = must(await supabase.from('businesses')
    .select('id, business_category, enabled_languages, require_advance_payment, advance_payment_type, advance_payment_value, payment_qr_url, upi_id, phone_number_id')
    .eq('id', businessId).maybeSingle());
  if (!business) throw Object.assign(new Error('Business not found'), { statusCode: 404 });

  const featureOn = await deps.isEnabled(business.business_category, businessId);
  // The route lists need the quote tables, which exist for every business; a business without the switch simply has none.
  const [oneWay, roundTrip, routes, vehicleRows, settings, nodes, edges, subscription, protectedIds] = await Promise.all([
    deps.listQuotableRoutes(businessId, 'oneway'),
    deps.listQuotableRoutes(businessId, 'round_trip'),
    deps.listRoutes(businessId),
    supabase.from('vehicles').select('id, custom_name, is_active, per_km_rate, min_km_per_day, driver_allowance_per_day, catalog:vehicle_type_catalog(name, seats)').eq('business_id', businessId).then(must),
    supabase.from('travel_quote_settings').select('business_id').eq('business_id', businessId).maybeSingle().then(must),
    supabase.from('flow_nodes').select('*').eq('business_id', businessId).then(must),
    supabase.from('flow_edges').select('*').eq('business_id', businessId).then(must),
    deps.getSubscription(businessId),
    deps.findProtectedBusinessIds()
  ]);
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  let usage = null;
  try { usage = await deps.getUsage(businessId); } catch (error) { usage = null; }

  return buildReadiness({
    businessId,
    protectedBusiness: protectedIds.includes(businessId),
    category: business.business_category,
    featureOn,
    oneWayRoutes: oneWay.length,
    roundTripRoutes: roundTrip.length,
    routes: routes.filter((r) => !r.unlisted),
    vehicles: (vehicleRows || []).map((v) => ({
      name: v.custom_name || (v.catalog && v.catalog.name) || v.id,
      isActive: v.is_active,
      perKmRate: num(v.per_km_rate),
      minKmPerDay: num(v.min_km_per_day),
      driverAllowancePerDay: num(v.driver_allowance_per_day),
      seats: v.catalog && v.catalog.seats !== undefined ? num(v.catalog.seats) : null
    })),
    settingsSaved: !!settings,
    advance: {
      requireAdvancePayment: !!business.require_advance_payment,
      advancePaymentType: business.advance_payment_type,
      advancePaymentValue: num(business.advance_payment_value),
      hasPaymentQr: !!business.payment_qr_url,
      hasUpi: !!business.upi_id
    },
    whatsappConnected: !!business.phone_number_id,
    subscription: subscription ? { status: subscription.status, endDate: subscription.end_date || null } : null,
    languages: Array.isArray(business.enabled_languages) && business.enabled_languages.length > 0 ? business.enabled_languages : ['en'],
    usage,
    nodes: nodes || [],
    edges: edges || [],
    entry
  });
};

module.exports = { BUILT_IN_LANGUAGES, PASSENGER_BANDS, buildReadiness, getQuoteReadiness };
