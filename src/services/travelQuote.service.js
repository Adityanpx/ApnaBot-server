// Travel quotes, owner's side (/api/travel/quote-settings, /quotes, /api/reports/quotes): the extras
// and timing settings, the quote list, cancelling a quote and the report numbers. Creating, accepting
// and expiring quotes is the WhatsApp side (not in this file). Every function takes the businessId
// from the logged-in user.
//
// The ADVANCE is the business-wide setting (businesses.require_advance_payment /
// advance_payment_type / advance_payment_value, edited through PUT /api/business); it is returned
// read-only next to the settings so the Rates screen shows it in one place.
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { DEFAULT_SETTINGS, validateSettingsInput } = require('../utils/travelQuote');
const { getPeriodRanges } = require('./reports.service');

const fail = (statusCode, message, errors = null) => Object.assign(new Error(message), { statusCode, errors });

const PAGE_SIZE_MAX = 50;
const STATUSES = ['sent', 'accepted', 'paid', 'expired', 'cancelled', 'handoff'];

const settingsFromRow = (row) => {
  if (!row) return { ...DEFAULT_SETTINGS };
  const camel = toCamelCase(row);
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, camel[key] ?? DEFAULT_SETTINGS[key]]));
};

const loadSettingsRow = async (businessId) => {
  const { data, error } = await supabase.from('travel_quote_settings').select('*').eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

/** The advance fields the Rates screen shows read-only (edited via PUT /api/business). */
const loadAdvance = async (businessId) => {
  const { data, error } = await supabase.from('businesses')
    .select('require_advance_payment, advance_payment_type, advance_payment_value, payment_qr_url')
    .eq('id', businessId).maybeSingle();
  if (error) throw error;
  if (!data) throw fail(404, 'Business not found');
  return {
    requireAdvancePayment: !!data.require_advance_payment,
    advancePaymentType: data.advance_payment_type,
    advancePaymentValue: data.advance_payment_value === null ? null : Number(data.advance_payment_value),
    hasPaymentQr: !!data.payment_qr_url
  };
};

/** Saved settings (or the defaults when none are saved yet) plus the read-only advance. */
const getSettings = async (businessId) => ({
  settings: settingsFromRow(await loadSettingsRow(businessId)),
  advance: await loadAdvance(businessId)
});

/** Saves the fields sent (creating the row on first save). */
const updateSettings = async (businessId, body) => {
  const row = await loadSettingsRow(businessId);
  const { errors, value } = validateSettingsInput(body, settingsFromRow(row));
  if (errors.length > 0) throw fail(400, errors[0], errors);
  const { data, error } = await supabase.from('travel_quote_settings')
    .upsert({ business_id: businessId, ...value }, { onConflict: 'business_id' }).select().single();
  if (error) throw error;
  return { settings: settingsFromRow(data), advance: await loadAdvance(businessId) };
};

/** Quotes, newest first, with the customer; optional status filter. */
const listQuotes = async (businessId, { status, page = 1, limit = 20 } = {}) => {
  if (status !== undefined && !STATUSES.includes(status)) throw fail(400, `status must be one of: ${STATUSES.join(', ')}`);
  const pageNo = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(limit, 10) || 20));
  let query = supabase.from('travel_quotes')
    .select('*, customer:customers(id, name, whatsapp_number), vehicle:vehicles(id, custom_name, catalog:vehicle_type_catalog(name))', { count: 'exact' })
    .eq('business_id', businessId);
  if (status) query = query.eq('status', status);
  const from = (pageNo - 1) * pageSize;
  const { data, error, count } = await query.order('sent_at', { ascending: false }).range(from, from + pageSize - 1);
  if (error) throw error;
  const quotes = (data || []).map(({ customer, vehicle, ...q }) => ({
    ...toCamelCase(q),
    customer: customer ? { id: customer.id, name: customer.name, whatsappNumber: customer.whatsapp_number } : null,
    vehicleName: vehicle ? (vehicle.custom_name || vehicle.catalog?.name || null) : null
  }));
  return { quotes, pagination: { page: pageNo, limit: pageSize, total: count || 0 } };
};

/** Owner cancels a quote the customer hasn't accepted. One guarded UPDATE, so a race with Confirm can't both win. */
const cancelQuote = async (businessId, id) => {
  const { data, error } = await supabase.from('travel_quotes').update({ status: 'cancelled' })
    .eq('id', id).eq('business_id', businessId).eq('status', 'sent').select().maybeSingle();
  if (error) throw error;
  if (data) return toCamelCase(data);
  const { data: existing, error: findErr } = await supabase.from('travel_quotes').select('status')
    .eq('id', id).eq('business_id', businessId).maybeSingle();
  if (findErr) throw findErr;
  if (!existing) throw fail(404, 'Quote not found');
  throw fail(409, `Only a quote that is still waiting for the customer can be cancelled (this one is ${existing.status}).`);
};

const statsFor = async (businessId, start, end) => {
  const { data, error } = await supabase.rpc('report_travel_quote_stats', {
    p_business_id: businessId, p_start: start.toISOString(), p_end: end.toISOString()
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) || {};
  const n = (v) => Number(v) || 0;
  const sent = n(row.sent);
  return {
    sent, accepted: n(row.accepted), paid: n(row.paid), expired: n(row.expired), cancelled: n(row.cancelled),
    handoff: n(row.handoff), quotedAmount: n(row.quoted_amount), advanceCollected: n(row.advance_collected),
    conversionRate: sent === 0 ? 0 : n(row.paid) / sent
  };
};

const growthPercent = (current, previous) => (previous === 0 ? null : ((current - previous) / previous) * 100);

/** Quotes sent, accepted, advances paid and conversion for the period vs the one before (same shape as /reports/summary). */
const getQuoteReport = async (businessId, period) => {
  const { currentStart, currentEnd, previousStart, previousEnd } = getPeriodRanges(period);
  const [current, previous] = await Promise.all([
    statsFor(businessId, currentStart, currentEnd),
    statsFor(businessId, previousStart, previousEnd)
  ]);
  return {
    current,
    previous,
    growth: {
      sent: growthPercent(current.sent, previous.sent),
      paid: growthPercent(current.paid, previous.paid),
      advanceCollected: growthPercent(current.advanceCollected, previous.advanceCollected),
      conversionRate: growthPercent(current.conversionRate, previous.conversionRate)
    }
  };
};

/**
 * The routes a customer can be quoted for a trip type: active travel_routes that have at least one
 * active fare of that trip type on an active vehicle (the route_picker node's source; live, per turn).
 * @param {string} tripType  'oneway' | 'round_trip'
 * @returns {Promise<{id, fromCity, toCity, fromLabel, toLabel, region, sortOrder}[]>}
 */
const listQuotableRoutes = async (businessId, tripType) => {
  const [routesRes, faresRes, vehiclesRes] = await Promise.all([
    supabase.from('travel_routes').select('*').eq('business_id', businessId).eq('is_active', true),
    supabase.from('route_fares').select('route_id, vehicle_id').eq('business_id', businessId).eq('trip_type', tripType).eq('is_active', true),
    supabase.from('vehicles').select('id').eq('business_id', businessId).eq('is_active', true)
  ]);
  for (const res of [routesRes, faresRes, vehiclesRes]) if (res.error) throw res.error;
  const activeVehicles = new Set((vehiclesRes.data || []).map(v => v.id));
  const routesWithFare = new Set((faresRes.data || []).filter(f => f.route_id && activeVehicles.has(f.vehicle_id)).map(f => f.route_id));
  return (routesRes.data || []).filter(r => routesWithFare.has(r.id)).map(r => ({
    id: r.id,
    fromCity: r.from_city,
    toCity: r.to_city,
    fromLabel: r.from_label,
    toLabel: r.to_label,
    region: r.region,
    sortOrder: r.sort_order ?? 0
  }));
};

const BOOKING_FIELD_LABELS = {
  tripType: 'Trip type', pickupLocation: 'Pickup', dropLocation: 'Drop', travelDate: 'Date', pickupTime: 'Pickup time',
  passengers: 'Passengers', numberOfDays: 'Days', vehicleName: 'Vehicle', quoteTotal: 'Quote total'
};

/**
 * The booking a customer's Confirm creates from a quote (never createBookingAndConfirmation: that one
 * prices from the session, this one from the saved quote). One booking per quote: bookings.quote_id is
 * unique, so a second call for the same quote returns the booking that already exists.
 *   advance asked (quote.advance_amount)  status pending, payment_status pending, payment_details
 *                                         requestedVia 'advance' - the owner marks it paid, which confirms it
 *   no advance                            status confirmed, payment_status not_required
 * fare_amount = the quote total.
 * @param {{ quote: Object, business: Object, customer: Object, customerNumber: string }} args
 *   quote = the snake_case travel_quotes row; business = camelCase (displayName / name); customer = camelCase
 * @returns {Promise<{ booking: Object, created: boolean }>} booking is the camelCase row
 */
const createQuoteBooking = async ({ quote, business, customer, customerNumber }) => {
  const existing = async () => {
    const { data, error } = await supabase.from('bookings').select('*').eq('quote_id', quote.id).maybeSingle();
    if (error) throw error;
    return data;
  };
  const found = await existing();
  if (found) return { booking: toCamelCase(found), created: false };

  const c = quote.collected || {};
  const advance = quote.advance_amount === null || quote.advance_amount === undefined ? null : Number(quote.advance_amount);
  const letters = ((business?.displayName || business?.name || '').toUpperCase().match(/[A-Z]/g) || []);
  const bookingCode = (letters.length >= 2 ? letters.slice(0, 2).join('') : 'BK') + Math.floor(1000 + Math.random() * 9000);
  const fields = {
    tripType: c.tripLabel, pickupLocation: c.fromLabel, dropLocation: c.toLabel, travelDate: c.date, pickupTime: c.pickupTime,
    passengers: c.passengers, ...(c.days ? { numberOfDays: c.days } : {}), vehicleName: c.vehicleName, vehicleId: quote.vehicle_id,
    vehicleFare: quote.base_fare, fareSource: 'route_fare', routeFareId: quote.route_fare_id, quoteId: quote.id, quoteTotal: quote.total_amount
  };
  const insert = {
    business_id: quote.business_id,
    customer_id: quote.customer_id,
    customer_number: customerNumber,
    status: advance !== null ? 'pending' : 'confirmed',
    fields,
    field_labels: BOOKING_FIELD_LABELS,
    payment_status: advance !== null ? 'pending' : 'not_required',
    booking_code: bookingCode,
    fare_amount: quote.total_amount,
    quote_id: quote.id,
    ...(advance !== null ? { payment_amount: advance, payment_details: { requestedVia: 'advance', quoteId: quote.id } } : {})
  };
  const { data, error } = await supabase.from('bookings').insert(insert).select().single();
  if (error) {
    if (error.code === '23505') {
      // A second Confirm won the insert: that booking is the quote's booking.
      const winner = await existing();
      if (winner) return { booking: toCamelCase(winner), created: false };
    }
    throw error;
  }
  const booking = toCamelCase(data);

  const notificationService = require('./notification.service');
  notificationService.notify(quote.business_id, 'booking_new', {
    bookingId: booking.id, customerId: quote.customer_id, customerName: customer?.name, customerNumber,
    summary: c.vehicleName || c.tripLabel || null, date: c.date || null
  });
  try {
    require('./socket.service').emitToBusiness(String(quote.business_id), 'new_booking', { booking, customerNumber });
  } catch (socketError) {
    require('../utils/logger').error('Error emitting socket event:', socketError);
  }
  if (advance === null) {
    // Confirmed without waiting for a payment: the same Contacted -> Converted step as any confirmation.
    try {
      await require('./customerPipeline.service').advancePipelineStage(quote.customer_id, 'converted');
    } catch (pipelineError) {
      require('../utils/logger').error('Error advancing the customer pipeline for a confirmed quote booking:', pipelineError);
    }
  }
  return { booking, created: true };
};

module.exports = { STATUSES, getSettings, updateSettings, listQuotes, cancelQuote, getQuoteReport, listQuotableRoutes, createQuoteBooking };
