// The WhatsApp side of a travel quote: the engine (bookingGraph.service.js) hands over {quote:{action}}
// when a customer reaches the quote step; the webhook passes it to handleResult. Taps on the quote's
// buttons ("quote:{id}:confirm|change|talk|paid", utils/quoteIds.js) go to handleTap.
//
// State lives in travel_quotes, never in the 5-minute booking session. Every status change is one
// guarded UPDATE (…where status = …), so a double tap or a sweep running at the same moment cannot
// do a step twice:
//   sent --Confirm--> accepted (+ booking, one per quote) --owner marks paid--> paid
//   sent --expires_at passes--> expired            (the sweep, services/quoteSweep.service.js)
//   handoff: a lead ("Other route", nothing fits), not a priced quote
//
// Sending: each message is saved to the chat (messages) and sent through the outbound queue, in order.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const socketService = require('./socket.service');
const businessService = require('./business.service');
const bookingService = require('./booking.service');
const handoffService = require('./handoff.service');
const notificationService = require('./notification.service');
const travelQuoteService = require('./travelQuote.service');
const paymentService = require('./payment.service');
const bookingGraphService = require('./bookingGraph.service');
const { addToWhatsappQueueAndWait } = require('../queues/whatsapp.queue');
const { buildInteractivePayload } = require('../utils/interactivePayload');
const { applyMessageTemplate } = require('../utils/messageTemplating');
const { computeQuote, computeAdvance } = require('../utils/travelQuote');
const { getSystemMessage } = require('../utils/systemMessages');
const { quoteTapId } = require('../utils/quoteIds');
const { money, formatUntil } = require('../utils/quoteText');
const { findFlowEntryNodeId } = require('../utils/flowGraphValidation');

const HOUR_MS = 60 * 60 * 1000;
// createQuote refuses to send a price that does not match the quote (handleResult hands the customer to the owner instead).
const PRICE_MISMATCH = 'QUOTE_PRICE_MISMATCH';

/** The language a message goes out in: the customer's if the business still offers it, else its first. */
const languageOf = ({ tenant, customer }) => {
  const enabled = Array.isArray(tenant.enabledLanguages) && tenant.enabledLanguages.length > 0 ? tenant.enabledLanguages : null;
  if (customer.preferredLanguage && (!enabled || enabled.includes(customer.preferredLanguage))) return customer.preferredLanguage;
  return enabled ? enabled[0] : 'en';
};

// ---- text -----------------------------------------------------------------------------------------

const extraLine = (extra, lang, quote) => {
  const amount = money(extra.amount);
  if (extra.key === 'night_charge') return getSystemMessage('quoteExtraNight', lang, { amount });
  if (extra.key === 'driver_allowance') {
    const allowance = quote.collected?.pricing?.allowance;
    if (allowance) {
      const key = allowance.basis === 'night' ? 'quoteExtraDriverNights' : 'quoteExtraDriverDays';
      return getSystemMessage(key, lang, { units: allowance.units, perUnit: money(allowance.perUnit), amount });
    }
    return getSystemMessage('quoteExtraDriver', lang, { days: quote.collected?.days ?? '', amount }); // a quote saved before per-vehicle allowances
  }
  return getSystemMessage('quoteExtraMinimum', lang, { amount });
};

/** From -> To, trip type, date, pickup time, passengers, vehicle: the trip, as the customer chose it. */
const tripLines = (quote, lang) => {
  const c = quote.collected || {};
  const msg = (key, vars) => getSystemMessage(key, lang, vars);
  const lines = [`${c.fromLabel} → ${c.toLabel}`,
    msg('quoteTripLine', { trip: msg(quote.trip_type === 'round_trip' ? 'quoteTripRoundTrip' : 'quoteTripOneWay') })];
  if (quote.trip_type === 'round_trip' && c.days) lines.push(msg('quoteDaysLine', { days: c.days }));
  if (c.date) lines.push(msg('quoteDateLine', { date: c.date }));
  if (c.pickupTime) lines.push(msg('quoteTimeLine', { time: c.pickupTime }));
  if (c.passengers) lines.push(msg('quotePassengersLine', { passengers: c.passengers }));
  if (c.vehicleName) lines.push(msg('quoteVehicleLine', { vehicle: c.vehicleName }));
  return lines;
};

/**
 * The quote message: the trip, the fare broken down into what was computed (fare + night charge /
 * driver allowance / minimum charge), the total, whether toll is included (shown, never added), the
 * advance when one is asked, and how long the quote is valid.
 */
const buildQuoteText = (quote, lang) => {
  const msg = (key, vars) => getSystemMessage(key, lang, vars);
  const extras = Array.isArray(quote.extras) ? quote.extras : [];
  const pricing = quote.collected?.pricing || null;
  const lines = [msg('quoteHeader'), '', ...tripLines(quote, lang), ''];
  if (pricing?.method === 'formula') {
    // billed km x the vehicle's rate, why that many km, then the allowance / night / minimum lines
    const byDistance = Math.round(pricing.billedKm * 10) === Math.round(2 * pricing.oneWayKm * 10);
    lines.push(
      msg('quoteKmFareLine', { km: money(pricing.billedKm), rate: money(pricing.ratePerKm), amount: money(quote.base_fare) }),
      byDistance
        ? msg('quoteBilledByDistance', { km: money(pricing.billedKm), one: money(pricing.oneWayKm) })
        : msg('quoteBilledByMin', { km: money(pricing.billedKm), days: pricing.days, min: money(pricing.minKmPerDay) }),
      ...extras.map(e => extraLine(e, lang, quote))
    );
  } else if (pricing?.method === 'package') {
    lines.push(msg('quotePackageFareLine', { amount: money(quote.base_fare) }), ...extras.map(e => extraLine(e, lang, quote)));
  } else if (extras.length > 0) {
    lines.push(msg('quoteBaseFareLine', { amount: money(quote.base_fare) }), ...extras.map(e => extraLine(e, lang, quote)));
  }
  lines.push(msg('quoteTotalLine', { amount: money(quote.total_amount) }), '');
  lines.push(msg(quote.collected?.tollIncluded ? 'quoteTollIncluded' : 'quoteTollExtra'));
  if (pricing?.method === 'formula') lines.push(msg('quoteActualKmNote'));
  if (quote.advance_amount !== null && quote.advance_amount !== undefined) {
    lines.push(msg('quoteAdvanceLine', { amount: money(quote.advance_amount) }));
  }
  lines.push('', msg('quoteValidUntil', { until: formatUntil(quote.expires_at, lang) }));
  return lines.join('\n');
};

const quoteButtons = (quote, lang) => {
  const hasAdvance = quote.advance_amount !== null && quote.advance_amount !== undefined;
  return [
    { title: getSystemMessage(hasAdvance ? 'quoteBtnConfirmPay' : 'quoteBtnConfirm', lang), nextKeyword: quoteTapId(quote.id, 'confirm') },
    { title: getSystemMessage('quoteBtnChange', lang), nextKeyword: quoteTapId(quote.id, 'change') },
    { title: getSystemMessage('quoteBtnTalk', lang), nextKeyword: quoteTapId(quote.id, 'talk') }
  ];
};

// ---- sending --------------------------------------------------------------------------------------

/**
 * Saves one bot message to the chat and sends it, waiting for the send so messages keep their order.
 * A failed send is logged, not thrown (the quote itself is already saved).
 */
const deliver = async (ctx, { text, buttons = null, imageUrl = null, ruleId = null }) => {
  const { tenant, customer, customerNumber } = ctx;
  let row = null;
  try {
    const { data, error } = await supabase.from('messages').insert({
      business_id: tenant.businessId, customer_id: customer.id, customer_number: customerNumber,
      direction: 'outbound', type: imageUrl ? 'image' : 'text', content: text, media_url: imageUrl, status: 'sent',
      triggered_rule_id: ruleId, sender_type: 'bot', is_read: true,
      interactive_payload: buttons ? buildInteractivePayload({ message: text, buttons }) : null
    }).select().single();
    if (error) throw error;
    row = toCamelCase(data);
  } catch (error) {
    logger.error('Quote: could not save the outbound message row:', { message: error.message });
  }
  try {
    await addToWhatsappQueueAndWait({
      businessId: tenant.businessId, phoneNumberId: tenant.phoneNumberId, encryptedAccessToken: tenant.accessToken,
      to: customerNumber, type: imageUrl ? 'image' : 'text', message: text,
      ...(imageUrl ? { imageUrl } : {}), ...(buttons ? { buttons } : {}), ...(row ? { messageId: row.id } : {})
    });
  } catch (error) {
    logger.error('Quote: sending a message failed:', { businessId: tenant.businessId, message: error.message });
  }
  if (row) {
    try {
      socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', { customer, message: row, customerNumber });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }
  }
};

const sendUnavailable = (ctx) => deliver(ctx, { text: getSystemMessage('quoteUnavailable', languageOf(ctx)) });

const sendExpired = (ctx, quote) => {
  const lang = languageOf(ctx);
  return deliver(ctx, {
    text: getSystemMessage('quoteExpired', lang),
    buttons: [{ title: getSystemMessage('quoteBtnNew', lang), nextKeyword: quoteTapId(quote.id, 'change') }]
  });
};

// ---- data -----------------------------------------------------------------------------------------

/** The customer's own quote (a tap from another customer's chat never finds it). */
const loadQuote = async (ctx, quoteId) => {
  const { data, error } = await supabase.from('travel_quotes').select('*')
    .eq('id', quoteId).eq('business_id', ctx.tenant.businessId).eq('customer_id', ctx.customer.id).maybeSingle();
  if (error) throw error;
  return data;
};

/** A new quote or a new handoff makes the customer's older open quotes' reminders pointless: suppress them. */
const suppressOlderReminders = async (businessId, customerId) => {
  const { error } = await supabase.from('travel_quotes').update({ reminder_sent_at: new Date().toISOString() })
    .eq('business_id', businessId).eq('customer_id', customerId).eq('status', 'sent').is('reminder_sent_at', null);
  if (error) logger.error('Quote: could not suppress older reminders:', { message: error.message });
};

const entryNodeIdFor = async (businessId, nodeId) => {
  try {
    const { nodes, edges } = await bookingGraphService.loadGraph(businessId);
    return findFlowEntryNodeId(nodes, edges, nodeId);
  } catch (error) {
    logger.error('Quote: could not work out the flow entry:', { businessId, message: error.message });
    return null;
  }
};

/** The part of a priced Round Trip kept on the quote (and read by the quote text, booking and Quotes tab). */
const pricingSnapshot = (priced) => (priced.method === 'formula'
  ? {
    method: 'formula', days: priced.days, oneWayKm: priced.oneWayKm, minKmPerDay: priced.minKmPerDay, billedKm: priced.billedKm,
    ratePerKm: priced.ratePerKm, kmCharge: priced.kmCharge, allowance: priced.allowance
  }
  : { method: 'package' });

const tripTypeOf = (value) => (bookingService.normalizeTripType(value) === 'round_trip' ? 'round_trip' : 'oneway');

/** Prices the trip from the session, saves the quote (status sent) and returns the row. */
const createQuote = async (ctx, session, quoteNodeId) => {
  const { tenant, customer } = ctx;
  const businessId = tenant.businessId;
  const c = { ...session.collected, ...(session.displayOverrides || {}) };
  const baseFare = Number(session.collected.vehicleFare);
  if (!(baseFare > 0)) throw new Error('Quote: the session has no vehicle fare to quote from');

  const tripType = tripTypeOf(c.tripType);
  const [{ settings }, business, routeResult, entryNodeId] = await Promise.all([
    travelQuoteService.getSettings(businessId),
    businessService.getBusinessById(businessId),
    supabase.from('travel_routes').select('toll_included').eq('id', c.quoteRouteId).eq('business_id', businessId).maybeSingle(),
    entryNodeIdFor(businessId, quoteNodeId)
  ]);
  if (!business) throw new Error('Business not found');
  if (routeResult.error) throw routeResult.error;

  const days = parseInt(c.numberOfDays, 10);
  // A Round Trip was priced at the vehicle tap (bookingGraph.service.js, the same priceVehicleTrip that priced
  // the card): the quote uses that price, so the card, the tap and the quote cannot disagree.
  const tapPricing = tripType === 'round_trip' && c.quotePricing ? c.quotePricing : null;
  if (tapPricing && tapPricing.method === 'formula' && tapPricing.days !== days) {
    throw Object.assign(new Error('Quote: the Round Trip was priced for a different number of days than the quote'), { code: PRICE_MISMATCH });
  }
  const priced = computeQuote({
    baseFare,
    tripType,
    roundTrip: tapPricing && tapPricing.method === 'formula' ? tapPricing : null,
    pickupMinute: Number.isInteger(c.pickupMinute) ? c.pickupMinute : null,
    tollOverride: routeResult.data ? routeResult.data.toll_included : null,
    settings
  });
  const advance = computeAdvance(business, priced.total);

  const sentAt = new Date();
  await suppressOlderReminders(businessId, customer.id);
  const { data, error } = await supabase.from('travel_quotes').insert({
    business_id: businessId,
    customer_id: customer.id,
    route_id: c.quoteRouteId,
    route_fare_id: c.routeFareId || null,
    vehicle_id: c.vehicleId || null,
    from_city: c.pickupLocation,
    to_city: c.dropLocation,
    trip_type: tripType,
    collected: {
      fromLabel: c.quoteFromLabel, toLabel: c.quoteToLabel, tripLabel: tripType === 'round_trip' ? 'Round Trip' : 'One Way',
      date: c.travelDate || null, pickupTime: c.pickupTime || null, pickupMinute: Number.isInteger(c.pickupMinute) ? c.pickupMinute : null,
      passengers: c.passengers || null, days: Number.isInteger(days) && days >= 1 ? days : null,
      vehicleName: c.vehicleName || null, tollIncluded: priced.tollIncluded, flowEntryNodeId: entryNodeId,
      // how a Round Trip was priced: method (package | formula) and, for the formula, days / billed km / rate / allowance
      ...(tapPricing ? { pricing: pricingSnapshot(tapPricing) } : {})
    },
    base_fare: priced.baseFare,
    extras: priced.extras,
    total_amount: priced.total,
    advance_amount: advance,
    status: 'sent',
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + settings.validHours * HOUR_MS).toISOString()
  }).select().single();
  if (error) throw error;
  return data;
};

/** A lead row (status handoff): "Other route", or no vehicle fits. Carries what the customer had chosen. */
const saveHandoffQuote = async (ctx, session, reason, flowNodeId, pricingReason = null) => {
  const businessId = ctx.tenant.businessId;
  const c = { ...session.collected, ...(session.displayOverrides || {}) };
  const { settings } = await travelQuoteService.getSettings(businessId);
  const now = new Date();
  const days = parseInt(c.numberOfDays, 10);
  const { data, error } = await supabase.from('travel_quotes').insert({
    business_id: businessId,
    customer_id: ctx.customer.id,
    route_id: c.quoteRouteId || null,
    vehicle_id: reason === 'price_on_request' ? (c.vehicleId || null) : null,
    from_city: c.pickupLocation || '',
    to_city: c.dropLocation || '',
    trip_type: c.tripType ? tripTypeOf(c.tripType) : '',
    collected: {
      reason, fromLabel: c.quoteFromLabel || null, toLabel: c.quoteToLabel || null, tripLabel: c.tripType || null,
      passengers: c.passengers || null, date: c.travelDate || null, flowEntryNodeId: await entryNodeIdFor(businessId, flowNodeId),
      // "Round Trip price needs the owner": what the customer chose and what was missing (missing_min_km, missing_distance, ...)
      ...(reason === 'price_on_request'
        ? { vehicleName: c.vehicleName || null, days: Number.isInteger(days) && days >= 1 ? days : null, pricingReason }
        : {})
    },
    base_fare: 0,
    extras: [],
    total_amount: 0,
    advance_amount: null,
    status: 'handoff',
    sent_at: now.toISOString(),
    expires_at: new Date(now.getTime() + settings.validHours * HOUR_MS).toISOString()
  }).select().single();
  if (error) throw error;
  return data;
};

// ---- handoff --------------------------------------------------------------------------------------

/**
 * Raises the human-needed alert the way a "talk to a person" tap does (handoff.service when the business
 * has it on, else the plain push) and returns the reply text.
 * @returns {Promise<{ claimed: boolean, replyText: string }>} claimed false = an escalation was already open
 */
const raiseHandoff = async (ctx, { quoteRequest = null, replyKey = null } = {}) => {
  const { tenant, customer, customerNumber } = ctx;
  const lang = languageOf(ctx);
  const pushHumanNeeded = () => notificationService.notifyOnce(tenant.businessId, 'human_needed', {
    customerId: customer.id, customerName: customer.name, customerNumber, ...(quoteRequest ? { quoteRequest } : {})
  }, `${tenant.businessId}:${customer.id}`, 5 * 60);

  const settings = await handoffService.getActiveSettings(tenant.businessId);
  let claimed = true;
  if (settings) {
    try {
      ({ claimed } = await handoffService.raise({
        businessId: tenant.businessId, customer, customerNumber, reason: 'tap', settings, ...(quoteRequest ? { quoteRequest } : {})
      }));
    } catch (error) {
      logger.error('Quote: could not raise the handoff, falling back to the plain push:', error);
      pushHumanNeeded();
    }
  } else {
    pushHumanNeeded();
  }
  const replyText = replyKey
    ? getSystemMessage(replyKey, lang)
    : applyMessageTemplate(settings ? handoffService.replyTextFor(settings, lang) : getSystemMessage('handoffReply', lang), tenant, customer);
  return { claimed, replyText };
};

// ---- the engine's hand-over -----------------------------------------------------------------------

/**
 * @param {{ tenant: Object, customer: Object, customerNumber: string }} ctx
 * @param {Object} session  the booking session as the engine left it
 * @param {{ action: 'send'|'no_vehicle'|'handoff', reason: string|null, nodeId?: string, pricingReason?: string }} result
 */
const handleResult = async (ctx, session, result) => {
  const { tenant, customerNumber } = ctx;
  const lang = languageOf(ctx);
  let quote = result;
  try {
    if (quote.action === 'send') {
      let row;
      try {
        row = await createQuote(ctx, session, quote.nodeId);
      } catch (error) {
        if (error.code !== PRICE_MISMATCH) throw error;
        // Never send a price that is not the one priced at the vehicle tap, and never leave the customer with
        // a generic error: the owner confirms the price (the hand-off below, with the trip in the alert).
        logger.error('Quote: price mismatch, handing the customer to the owner instead:', { businessId: tenant.businessId, message: error.message });
        quote = { action: 'handoff', reason: 'price_on_request', pricingReason: 'days_mismatch' };
      }
      if (row) {
        await deliver(ctx, { text: buildQuoteText(row, lang), buttons: quoteButtons(row, lang), ruleId: session.ruleId || null });
        return { quoteId: row.id };
      }
    }

    if (quote.action === 'no_vehicle') {
      const row = await saveHandoffQuote(ctx, session, 'no_vehicle', session.currentNodeId);
      await suppressOlderReminders(tenant.businessId, ctx.customer.id);
      await deliver(ctx, {
        text: getSystemMessage('quoteNoVehicle', lang),
        buttons: [
          { title: getSystemMessage('quoteBtnTalk', lang), nextKeyword: quoteTapId(row.id, 'talk') },
          { title: getSystemMessage('quoteBtnChange', lang), nextKeyword: quoteTapId(row.id, 'change') }
        ],
        ruleId: session.ruleId || null
      });
      return { quoteId: row.id };
    }

    // handoff: Other route / Other options / no routes / switch off / price_on_request
    const priceRequest = quote.reason === 'price_on_request';
    const c = session.collected || {};
    const { claimed, replyText } = await raiseHandoff(ctx, priceRequest
      ? {
        // the owner's alert says what to price: route, vehicle, days
        quoteRequest: { route: `${c.quoteFromLabel} → ${c.quoteToLabel}`, vehicle: c.vehicleName || null, days: parseInt(c.numberOfDays, 10) || null },
        replyKey: 'quotePriceOnRequestReply'
      }
      : {});
    let quoteId = null;
    // A lead row per open escalation, not per tap; none when the feature is off (nothing to report on).
    if (claimed && quote.reason !== 'switch_off') {
      quoteId = (await saveHandoffQuote(ctx, session, quote.reason, session.currentNodeId, quote.pricingReason || null)).id;
    }
    await deliver(ctx, { text: replyText, ruleId: session.ruleId || null });
    return { quoteId };
  } finally {
    // The quote lives in travel_quotes; the 5-minute session has nothing left to do.
    try {
      await bookingService.deleteBookingSession(tenant.businessId, customerNumber);
    } catch (error) {
      logger.error('Quote: could not delete the booking session:', { message: error.message });
    }
  }
};

// ---- taps -----------------------------------------------------------------------------------------

const sendPaymentRequest = async (ctx, quote, booking, business) => {
  const lang = languageOf(ctx);
  const hasAdvance = quote.advance_amount !== null && quote.advance_amount !== undefined;
  if (!hasAdvance) {
    const lines = [getSystemMessage('quoteConfirmedTitle', lang), getSystemMessage('bookingIdLine', lang, { code: booking.bookingCode }), '',
      ...tripLines(quote, lang), getSystemMessage('quoteTotalLine', lang, { amount: money(quote.total_amount) }), '',
      getSystemMessage('quoteConfirmedNext', lang)];
    return deliver(ctx, { text: lines.join('\n') });
  }
  const vars = { code: booking.bookingCode, amount: `₹${money(quote.advance_amount)}` };
  if (!business.paymentQrUrl) {
    // Advance on but no QR saved (an older setup): the team shares the payment details.
    return deliver(ctx, { text: getSystemMessage('advanceNoQr', lang, vars) });
  }
  await deliver(ctx, {
    text: paymentService.buildPaymentQrCaption({ upiId: business.upiId, intro: getSystemMessage('advanceQrIntro', lang, vars), languageCode: lang }),
    imageUrl: business.paymentQrUrl
  });
  // "I've paid" tells the owner to look; it never marks the booking paid.
  return deliver(ctx, {
    text: getSystemMessage('quotePaidPrompt', lang),
    buttons: [{ title: getSystemMessage('quoteBtnPaid', lang), nextKeyword: quoteTapId(quote.id, 'paid') }]
  });
};

const confirm = async (ctx, quoteId) => {
  let quote = await loadQuote(ctx, quoteId);
  if (!quote) return sendUnavailable(ctx);

  if (quote.status === 'sent') {
    const nowIso = new Date().toISOString();
    if (new Date(quote.expires_at).getTime() <= Date.now()) {
      await supabase.from('travel_quotes').update({ status: 'expired' }).eq('id', quote.id).eq('status', 'sent');
      return sendExpired(ctx, quote);
    }
    // The claim: only one tap can move sent -> accepted, and only before the quote expires.
    const { data: claimed, error } = await supabase.from('travel_quotes')
      .update({ status: 'accepted', accepted_at: nowIso })
      .eq('id', quote.id).eq('status', 'sent').gt('expires_at', nowIso).select();
    if (error) throw error;
    // Lost the race (or it expired a moment ago): look again and treat it by what it is now.
    quote = claimed && claimed.length > 0 ? claimed[0] : await loadQuote(ctx, quoteId);
    if (!quote) return sendUnavailable(ctx);
  }

  if (quote.status === 'expired') return sendExpired(ctx, quote);
  if (quote.status !== 'accepted' && quote.status !== 'paid') return sendUnavailable(ctx);

  // accepted / paid: a repeat tap re-sends the same payment request (the booking already exists).
  const business = await businessService.getBusinessById(ctx.tenant.businessId);
  if (!business) throw new Error('Business not found');
  const { booking } = await travelQuoteService.createQuoteBooking({
    quote, business, customer: ctx.customer, customerNumber: ctx.customerNumber
  });
  if (quote.booking_id !== booking.id) {
    const { error } = await supabase.from('travel_quotes').update({ booking_id: booking.id }).eq('id', quote.id);
    if (error) logger.error('Quote: could not link the booking to its quote:', { quoteId: quote.id, message: error.message });
  }
  return sendPaymentRequest(ctx, quote, booking, business);
};

const paidClaim = async (ctx, quoteId) => {
  const quote = await loadQuote(ctx, quoteId);
  const lang = languageOf(ctx);
  const hasAdvance = quote && quote.advance_amount !== null && quote.advance_amount !== undefined;
  if (!quote || !hasAdvance || (quote.status !== 'accepted' && quote.status !== 'paid')) return sendUnavailable(ctx);
  if (quote.status === 'paid') return deliver(ctx, { text: getSystemMessage('quotePaidAlready', lang) });

  // The owner is told once; a repeat tap gets the same thanks. Never marks anything paid.
  const { data: first, error } = await supabase.from('travel_quotes')
    .update({ customer_paid_claim_at: new Date().toISOString() }).eq('id', quote.id).is('customer_paid_claim_at', null).select();
  if (error) throw error;
  if (first && first.length > 0) {
    notificationService.notify(ctx.tenant.businessId, 'quote_paid_claim', {
      bookingId: quote.booking_id, customerId: ctx.customer.id, customerName: ctx.customer.name,
      customerNumber: ctx.customerNumber, amount: quote.advance_amount
    });
  }
  return deliver(ctx, { text: getSystemMessage('quotePaidThanks', lang) });
};

const talk = async (ctx, quoteId) => {
  const quote = await loadQuote(ctx, quoteId);
  if (!quote) return sendUnavailable(ctx);
  const { replyText } = await raiseHandoff(ctx);
  return deliver(ctx, { text: replyText });
};

/**
 * @param {{ tenant: Object, customer: Object, customerNumber: string }} ctx
 * @param {{ quoteId: string, action: 'confirm'|'change'|'talk'|'paid' }} tap  parseQuoteTapId's result
 * @returns {Promise<{ restart?: { entryNodeId: string } }>} restart = the caller starts the quote flow
 *   again at that question (it owns sending a field prompt)
 */
const handleTap = async (ctx, tap) => {
  if (tap.action === 'confirm') { await confirm(ctx, tap.quoteId); return {}; }
  if (tap.action === 'paid') { await paidClaim(ctx, tap.quoteId); return {}; }
  if (tap.action === 'talk') { await talk(ctx, tap.quoteId); return {}; }

  // change: start again. The old quote just runs out (its reminder is suppressed).
  const quote = await loadQuote(ctx, tap.quoteId);
  const entryNodeId = quote && quote.collected ? quote.collected.flowEntryNodeId : null;
  if (!entryNodeId) { await sendUnavailable(ctx); return {}; }
  await suppressOlderReminders(ctx.tenant.businessId, ctx.customer.id);
  return { restart: { entryNodeId } };
};

/** "This quote is no longer available": a tap whose id is malformed, unknown, or another customer's. */
const handleStaleTap = (ctx) => sendUnavailable(ctx);

module.exports = { buildQuoteText, quoteButtons, tripLines, handleResult, handleTap, handleStaleTap, languageOf };
