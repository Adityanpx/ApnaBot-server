const crypto = require('crypto');
const redis = require('../config/redis');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { getLocalizedText } = require('../utils/localization');
const businessService = require('./business.service');
const paymentService = require('./payment.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { addToSessionTimeoutQueue } = require('../queues/sessionTimeout.queue');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const distanceMatrixService = require('./distanceMatrix.service');
const logger = require('../utils/logger');

const tripTypeMap = { 'One Way': 'oneway', 'Round Trip': 'round_trip', 'Local Rental': 'local' };

/**
 * Normalize a 'buttons'/'list' field's option entry to a {value, label,
 * labelTranslations} shape. Plain strings (every seeded row today) become
 * their own value and label. VALUE is what gets written into
 * session.collected (and so must stay English — tripTypeMap and the other
 * 'Other'/'Other date'/'Other time' sentinel checks key off it); LABEL is
 * what gets rendered into buttons/list rows shown to the customer.
 */
const normalizeOption = (opt) =>
  typeof opt === 'string'
    ? { value: opt, label: opt, labelTranslations: null }
    : { value: opt.value, label: opt.label ?? opt.value,
        labelTranslations: opt.labelTranslations ?? null };

/**
 * Build the customer-facing copy of a field, with the label resolved to the
 * customer's language. Options are additionally translated/normalized only
 * for 'buttons'/'list' fields (decided on runtime fieldType, not fieldKey,
 * since the graph engine's servedCities overlay turns pickupLocation/
 * dropLocation into 'list' fields for businesses with servedCities
 * configured) — free-text fields have no option list to translate, but
 * their label is translated the same as any other field type. The caller's
 * field object is never mutated: matching a later reply needs the raw
 * options (value + labelTranslations), so this always returns a new object
 * rather than localizing in place.
 * @param {Object} field
 * @param {string|null|undefined} languageCode
 * @returns {Object}
 */
const localizeField = (field, languageCode) => {
  if (!field) return field;
  const localized = { ...field, label: getLocalizedText(field, 'label', languageCode) };
  if (field.fieldType === 'buttons' || field.fieldType === 'list') {
    localized.options = (field.options || []).map(opt => {
      const normalized = normalizeOption(opt);
      return { ...normalized, label: getLocalizedText(normalized, 'label', languageCode) };
    });
  }
  return localized;
};

/**
 * Format a Date as DD/MM/YYYY, matching the format customers are asked to
 * type manually when they answer the travelDate question with free text.
 */
const formatDateDDMMYYYY = (date) => {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getFullYear()}`;
};

/**
 * Resolve a travelDate quick-reply option ("Today"/"Tomorrow") to the actual
 * calendar date, in the same DD/MM/YYYY format as manual entry.
 */
const resolveTravelDateOption = (option) => {
  const date = new Date();
  if (option === 'Tomorrow') {
    date.setDate(date.getDate() + 1);
  }
  return formatDateDDMMYYYY(date);
};

// Matches the session-timeout notification window (SESSION_TIMEOUT_DELAY_MS
// below) so an expired-and-silently-gone session and a notified session
// happen at the same time - see saveBookingSession.
const BOOKING_SESSION_TTL = 300; // 5 minutes in seconds
const SESSION_TIMEOUT_DELAY_MS = 300000; // 5 minutes in ms

const FREE_MONTHLY_PREVIEW_CREDITS = 20;

/**
 * Find active route-fare based vehicle options for a pickup/drop pair.
 * @returns {Promise<Array>} Populated RouteFare docs (vehicleId + catalogId populated), or [] if none/invalid input
 */
const findMatchingVehicleOptions = async (businessId, pickupLocation, dropLocation, tripType) => {
  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const fromCity = (pickupLocation || '').toLowerCase().trim();
  const toCity = (dropLocation || '').toLowerCase().trim();
  if (!fromCity || !toCity) return [];
  try {
    const { data, error } = await supabase
      .from('route_fares')
      .select('*, vehicle:vehicles(id, custom_name, custom_photo_url, is_active, catalog:vehicle_type_catalog(name, photo_url, seats))')
      .eq('business_id', businessId).eq('from_city', fromCity).eq('to_city', toCity)
      .eq('trip_type', mappedTripType).eq('is_active', true);
    if (error) throw error;
    const result = (data || []).filter(rf => rf.vehicle && rf.vehicle.is_active);
    logger.info('Route fare lookup', { businessId, fromCity, toCity, tripType: mappedTripType, matchCount: result.length });
    return result;
  } catch (error) {
    logger.error('Error finding matching vehicle options:', error);
    return [];
  }
};

/**
 * Map joined route_fares rows to the option shape stored on a vehicle_carousel field.
 */
const buildVehicleCarouselOptions = (routeFares) => routeFares.map((rf, idx) => ({
  index: idx,
  routeFareId: rf.id,
  vehicleId: rf.vehicle.id,
  name: rf.vehicle.custom_name || rf.vehicle.catalog.name,
  photoUrl: rf.vehicle.custom_photo_url || rf.vehicle.catalog.photo_url || null,
  seats: rf.vehicle.catalog.seats || null,
  fare: rf.fare,
  source: 'route_fare'
}));

/**
 * Find distance-estimated vehicle options for a pickup/drop pair, for businesses
 * that have opted in via Business.enableDistanceFares. Falls back to [] on any
 * "can't compute" condition (opt-out, no Google result, no priced vehicles)
 * so the caller can fall through to the next tier without special-casing.
 *
 * For round trips where numberOfDays is known, distance is estimated as
 * numberOfDays * business.roundTripPerDayKm instead of doubling the one-way
 * distance, and the Google/cache one-way lookup is skipped entirely since
 * it isn't needed for that calculation.
 * @param {string|number} [numberOfDays] - customer-provided day count for round trips
 * @returns {Promise<Array>} Carousel-shaped options with source: 'distance_estimate', or []
 */
const findDistanceBasedVehicleOptions = async (businessId, pickupLocation, dropLocation, tripType, numberOfDays) => {
  const business = await businessService.getBusinessById(businessId);
  if (!business || business.enableDistanceFares !== true) {
    logger.warn('Distance fares lookup skipped: not enabled or business not found', { businessId, enableDistanceFares: business?.enableDistanceFares });
    return [];
  }

  const mappedTripType = tripTypeMap[tripType] || 'oneway';
  const days = Number(numberOfDays);
  const useDayBasedEstimate = mappedTripType === 'round_trip' && Number.isFinite(days) && days > 0;

  let distanceKm;
  if (useDayBasedEstimate) {
    const perDayKm = business.roundTripPerDayKm || 250;
    distanceKm = days * perDayKm;
  } else {
    const fromCity = (pickupLocation || '').toLowerCase().trim();
    const toCity = (dropLocation || '').toLowerCase().trim();
    if (!fromCity || !toCity) {
      logger.warn('Distance fares lookup skipped: empty pickup/drop location', { businessId, pickupLocation, dropLocation });
      return [];
    }

    const cacheKey = `distance:${businessId}:${fromCity}:${toCity}`;
    let oneWayDistanceKm = null;
    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null && cached !== undefined) {
        oneWayDistanceKm = Number(cached);
      }
    } catch (error) {
      logger.error('Error reading distance cache:', error);
    }

    if (oneWayDistanceKm === null) {
      oneWayDistanceKm = await distanceMatrixService.getDistanceKm(pickupLocation, dropLocation);
      if (oneWayDistanceKm === null) {
        logger.warn('Distance fares lookup skipped: distance lookup failed', { businessId, fromCity, toCity });
        return [];
      }
      try {
        await redis.set(cacheKey, oneWayDistanceKm, 'EX', 604800);
      } catch (error) {
        logger.error('Error writing distance cache:', error);
      }
    }

    distanceKm = mappedTripType === 'round_trip' ? oneWayDistanceKm * 2 : oneWayDistanceKm;
  }

  let vehicles;
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('*, catalog:vehicle_type_catalog(name, photo_url, seats)')
      .eq('business_id', businessId).eq('is_active', true).not('per_km_rate', 'is', null);
    if (error) throw error;
    vehicles = data || [];
  } catch (error) {
    logger.error('Error finding distance-based vehicle options:', error);
    return [];
  }

  if (vehicles.length === 0) {
    logger.warn('Distance fares lookup skipped: no active/priced vehicles found', { businessId });
    return [];
  }

  const driverDaTotal = (useDayBasedEstimate && business.roundTripDriverDaEnabled)
    ? business.roundTripDriverDaAmount * days
    : 0;

  const options = vehicles.map((vehicle, idx) => {
    const baseFare = Math.round((distanceKm * vehicle.per_km_rate) / 10) * 10;
    const option = {
      index: idx,
      vehicleId: vehicle.id,
      name: vehicle.custom_name || vehicle.catalog.name,
      photoUrl: vehicle.custom_photo_url || vehicle.catalog.photo_url || null,
      seats: vehicle.catalog.seats || null,
      fare: baseFare + driverDaTotal,
      source: 'distance_estimate',
      distanceKm: Math.round(distanceKm * 10) / 10
    };
    if (driverDaTotal > 0) {
      option.driverDaIncluded = true;
      option.driverDaTotal = driverDaTotal;
      option.driverDaPerDay = business.roundTripDriverDaAmount;
      option.driverDaDays = days;
    }
    return option;
  });

  logger.info('Distance-based fares computed', { businessId, fromCity: pickupLocation, toCity: dropLocation, distanceKm, vehicleCount: vehicles.length });
  return options;
};

/**
 * Three-tier vehicle carousel lookup: real route fares first, then a
 * distance-based estimate for opted-in businesses. Returns [] if neither source
 * has anything to offer, so callers fall through to the generic vehicleType list.
 * @param {string|number} [numberOfDays] - passed through to the distance-estimate tier for round trips
 */
const findBestVehicleCarouselOptions = async (businessId, pickupLocation, dropLocation, tripType, numberOfDays) => {
  const matchedRouteFares = await findMatchingVehicleOptions(businessId, pickupLocation, dropLocation, tripType);
  if (matchedRouteFares.length > 0) {
    return buildVehicleCarouselOptions(matchedRouteFares);
  }
  return findDistanceBasedVehicleOptions(businessId, pickupLocation, dropLocation, tripType, numberOfDays);
};

/**
 * Group a business's active rental packages by packageKey, deduplicating across
 * vehicles (per-vehicle price differences are resolved later, at the
 * vehicleType/carousel step). Returns a Map<packageKey, label> so callers
 * can build both the display option list and a label->packageKey lookup.
 */
const groupRentalPackagesByKey = async (businessId) => {
  const byKey = new Map();
  try {
    const { data, error } = await supabase
      .from('rental_packages').select('package_key, label').eq('business_id', businessId).eq('is_active', true);
    if (error) throw error;
    for (const pkg of data || []) {
      if (!byKey.has(pkg.package_key)) {
        byKey.set(pkg.package_key, pkg.label || pkg.package_key);
      }
    }
  } catch (error) {
    logger.error('Error grouping rental packages:', error);
  }
  return byKey;
};

/**
 * Build carousel-shaped vehicle options for a specific rental package key,
 * one per vehicle offering that package. Mirrors buildVehicleCarouselOptions'
 * shape (source: 'rental_package' instead of 'route_fare').
 * @returns {Promise<Array>}
 */
const findRentalVehicleCarouselOptions = async (businessId, packageKey) => {
  try {
    const { data, error } = await supabase
      .from('rental_packages')
      .select('*, vehicle:vehicles(id, custom_name, custom_photo_url, is_active, catalog:vehicle_type_catalog(name, photo_url, seats))')
      .eq('business_id', businessId).eq('package_key', packageKey).eq('is_active', true);
    if (error) throw error;

    return (data || [])
      .filter(rp => rp.vehicle && rp.vehicle.is_active)
      .map((rp, idx) => ({
        index: idx,
        rentalPackageId: rp.id,
        vehicleId: rp.vehicle.id,
        name: rp.vehicle.custom_name || rp.vehicle.catalog.name,
        photoUrl: rp.vehicle.custom_photo_url || rp.vehicle.catalog.photo_url || null,
        seats: rp.vehicle.catalog.seats || null,
        fare: rp.price,
        source: 'rental_package',
        extraKmRate: rp.extra_km_rate,
        extraHrRate: rp.extra_hr_rate
      }));
  } catch (error) {
    logger.error('Error finding rental vehicle carousel options:', error);
    return [];
  }
};

/**
 * Get Redis key for booking session
 */
const getSessionKey = (businessId, customerNumber) => {
  return `booking_session:${businessId}:${customerNumber}`;
};

/**
 * Get booking session from Redis
 * @param {string} businessId
 * @param {string} customerNumber
 * @returns {Promise<Object|null>}
 */
const getBookingSession = async (businessId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    const sessionData = await redis.get(sessionKey);
    if (!sessionData) {
      return null;
    }
    return JSON.parse(sessionData);
  } catch (error) {
    logger.error('Error getting booking session:', error);
    return null;
  }
};

/**
 * Save booking session to Redis, and schedule a proactive "session ended"
 * WhatsApp notification for SESSION_TIMEOUT_DELAY_MS from now. A fresh
 * timeoutToken is minted on every save and stamped onto sessionData before
 * it's written - the delayed job re-checks this token against whatever is
 * live in Redis when it fires, so only the most recent save's job (the one
 * matching the session's current token) ever actually notifies; every
 * earlier step's job for this session finds a rotated (or deleted) token
 * and no-ops.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} sessionData
 * @param {string} phoneNumberId - business's WhatsApp phone number id, for the timeout notification
 * @param {string} encryptedAccessToken - business's encrypted WhatsApp access token, for the timeout notification
 */
const saveBookingSession = async (businessId, customerNumber, sessionData, phoneNumberId, encryptedAccessToken) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    sessionData.timeoutToken = crypto.randomUUID();
    await redis.set(sessionKey, JSON.stringify(sessionData), 'EX', BOOKING_SESSION_TTL);
    await addToSessionTimeoutQueue({
      businessId,
      customerNumber,
      phoneNumberId,
      encryptedAccessToken,
      expectedToken: sessionData.timeoutToken
    }, { delay: SESSION_TIMEOUT_DELAY_MS });
  } catch (error) {
    logger.error('Error saving booking session:', error);
    throw error;
  }
};

/**
 * Delete booking session from Redis
 * @param {string} businessId
 * @param {string} customerNumber
 */
const deleteBookingSession = async (businessId, customerNumber) => {
  try {
    const sessionKey = getSessionKey(businessId, customerNumber);
    await redis.del(sessionKey);
  } catch (error) {
    logger.error('Error deleting booking session:', error);
    throw error;
  }
};

/**
 * Records that a booking session started (a "lead"), for reports-feature
 * conversion tracking — deliberately separate from whether it ever reaches
 * createBookingAndConfirmation. Throws on failure so callers can fire-and-forget
 * with .catch(), matching this codebase's non-critical-write convention.
 * @param {string} businessId
 * @param {string} customerId
 */
const recordBookingLead = async (businessId, customerId) => {
  const { error } = await supabase.from('booking_leads').insert({
    business_id: businessId,
    customer_id: customerId
  });
  if (error) throw error;
};

/**
 * Pure field/fare/note-line formatting shared by createBookingAndConfirmation's
 * real confirmation text and flowGraphPreview.controller.js's synthetic
 * "booking would be created here" summary — same (collected, orderedFields,
 * localRentalUnconfigured) inputs, different header/footer wrapped around
 * this body. No DB access, no side effects, extracted verbatim (byte-identical
 * output) out of createBookingAndConfirmation's old inline block.
 * @param {Object} collected
 * @param {Array<{fieldKey: string, label: string, summaryLabel: string}>} orderedFields
 * @param {boolean} localRentalUnconfigured
 * @returns {string}
 */
const buildBookingSummaryBody = (collected, orderedFields, localRentalUnconfigured) => {
  const fieldLines = orderedFields
    .map(f => {
      const value = collected[f.fieldKey];
      if (value === undefined || value === null || value === '') {
        return null;
      }
      const label = f.summaryLabel || f.label.replace('?', '');
      return label + ': *' + value + '*';
    })
    .filter(line => line !== null)
    .join('\n');

  const hasFare = collected.vehicleFare !== undefined && collected.vehicleFare !== null;
  const fareLine = !hasFare
    ? ''
    : collected.fareSource === 'distance_estimate'
      ? '\nFare: *₹' + collected.vehicleFare + ' (estimated, based on distance)*' +
        '\nDistance: *' + collected.distanceKm + ' km*'
      : '\nFare: *₹' + collected.vehicleFare + '*';

  const driverDaLine = collected.driverDaTotal
    ? '\nDriver DA: *₹' + collected.driverDaTotal + ' (' + collected.driverDaDays + ' days × ₹' + collected.driverDaPerDay + ')*'
    : '';

  const tollNoteLine = hasFare
    ? '\n\n_Note: Toll & parking charges are not included in this fare and will be collected separately._'
    : '';

  const extraRateNoteLine = (collected.fareSource === 'rental_package' &&
    collected.extraKmRate !== undefined && collected.extraKmRate !== null &&
    collected.extraHrRate !== undefined && collected.extraHrRate !== null)
    ? '\n\n_Extra km: ₹' + collected.extraKmRate + '/km, Extra hour: ₹' + collected.extraHrRate + '/hr beyond package limits._'
    : '';

  const localRentalUnconfiguredNoteLine = localRentalUnconfigured
    ? '\n\n_Note: this business hasn\'t set up rental packages yet — our team will call you to confirm pricing for this rental._'
    : '';

  return fieldLines + fareLine + driverDaLine + tollNoteLine + extraRateNoteLine + localRentalUnconfiguredNoteLine;
};

/**
 * Shared booking-completion tail for both engines: insert the `bookings` row,
 * delete the Redis session, bump usage, build the WhatsApp confirmation text,
 * and emit the `new_booking` socket event. Extracted verbatim out of
 * processBookingStep's old inline tail so bookingGraph.service.js's
 * finalizeGraphBooking can reuse the exact same, already-proven formatting
 * logic instead of duplicating it — the two engines differ only in what
 * ordered-field-with-labels array they have (session.fields for the old
 * step/fields model, session.answeredFields for the graph model), which is
 * why that's a parameter here rather than read off a `session` shape neither
 * caller fully shares.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} collected - session.collected (field answers + fare/vehicle bookkeeping)
 * @param {Array<{fieldKey: string, label: string, summaryLabel: string}>} orderedFields -
 *   the fields actually answered, in answer order, for the fieldLines summary
 * @param {boolean} localRentalUnconfigured
 * @returns {Promise<string>} the confirmation text
 */
const createBookingAndConfirmation = async (businessId, customerNumber, collected, orderedFields, localRentalUnconfigured) => {
  const { data: customer, error: custErr } = await supabase
    .from('customers').select('id, name').eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
  if (custErr || !customer) {
    logger.error('Cannot create booking: no customer record found', {
      businessId, customerNumber, custErr, collected
    });
    throw new Error(`Cannot create booking: no customer record found for ${customerNumber} on business ${businessId}`);
  }

  const bookingCode = 'CAB' + Math.floor(1000 + Math.random() * 9000);

  // Advance-payment collection: compute this BEFORE inserting the booking
  // row, since it changes what payment_status/payment_amount get written.
  // advanceAmount stays null (== no advance required) unless the business
  // has opted in AND the amount is actually computable — a 'percentage'
  // business with a non-fare booking type (no collected.vehicleFare) can't
  // compute a sane amount, so that case falls back to normal (no-advance)
  // behavior rather than inventing a number.
  const business = await businessService.getBusinessById(businessId);
  let advanceAmount = null;
  if (business?.requireAdvancePayment) {
    if (business.advancePaymentType === 'percentage') {
      if (collected.vehicleFare === undefined || collected.vehicleFare === null) {
        logger.error('Cannot compute percentage advance payment: booking has no vehicleFare', {
          businessId, customerNumber, advancePaymentValue: business.advancePaymentValue
        });
      } else {
        advanceAmount = Math.round(collected.vehicleFare * (business.advancePaymentValue / 100) * 100) / 100;
      }
    } else if (business.advancePaymentType === 'fixed') {
      advanceAmount = business.advancePaymentValue;
    }
  }

  const bookingInsert = {
    business_id: businessId,
    customer_id: customer.id,
    customer_number: customerNumber,
    status: 'pending',
    fields: collected,
    payment_status: advanceAmount !== null ? 'pending' : 'not_required',
    booking_code: bookingCode,
    fare_amount: collected.vehicleFare ?? null
  };
  if (advanceAmount !== null) {
    bookingInsert.payment_amount = advanceAmount;
  }

  const { data: bookingRow, error: bookingErr } = await supabase.from('bookings').insert(bookingInsert).select().single();
  if (bookingErr) throw bookingErr;
  const booking = toCamelCase(bookingRow);

  // Delete session from Redis
  await deleteBookingSession(businessId, customerNumber);

  // Increment booking usage (fire and forget)
  usageService.incrementUsage(businessId, 'booking').catch(err =>
    logger.error('Error incrementing booking usage:', err)
  );

  if (advanceAmount !== null) {
    // Booking isn't confirmed yet — skip the normal fieldLines/fare summary
    // entirely and send a payment-link message instead. createRazorpayPaymentLink
    // itself writes payment_link/payment_id back onto this booking row.
    const paymentLink = await paymentService.createRazorpayPaymentLink(
      booking.id,
      Math.round(advanceAmount * 100),
      customer.name || 'Customer',
      customerNumber,
      `Advance payment for booking ${bookingCode}`
    );

    const advanceConfirmationText = `Almost done! To confirm your booking, please pay the advance of ₹${advanceAmount} here: ${paymentLink.short_url}\n\nBooking ID: *${bookingCode}*`;

    try {
      socketService.emitToBusiness(businessId.toString(), 'new_booking', {
        booking,
        customerNumber
      });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }

    return advanceConfirmationText;
  }

  // Build confirmation message (WhatsApp bold = *value*)
  const confirmationText = '✅ *Booking request received!*\n' +
    'Booking ID: *' + bookingCode + '*\n\n' +
    buildBookingSummaryBody(collected, orderedFields, localRentalUnconfigured) +
    '\n\nOur team will contact you shortly to confirm. 🚕';

  // Emit Socket.io event (wrap in try/catch)
  try {
    socketService.emitToBusiness(businessId.toString(), 'new_booking', {
      booking,
      customerNumber
    });
  } catch (socketError) {
    logger.error('Error emitting socket event:', socketError);
  }

  return confirmationText;
};

/**
 * Booking-completion tail for the graph engine — the counterpart to
 * processBookingStep's now-shared createBookingAndConfirmation call.
 * bookingGraph.service.js's advanceGraphSession deliberately stops at
 * {done:true, collected} without inserting a row or building confirmation
 * text (kept out of that pure-of-side-effects core); the caller (Step 12's
 * webhook.controller.js wiring) calls this once it sees {done:true}.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {Object} session - the graph session at completion (collected,
 *   answeredFields, localRentalUnconfigured, displayOverrides)
 * @returns {Promise<string>} the confirmation text
 */
const finalizeGraphBooking = async (businessId, customerNumber, session) => {
  try {
    // session.collected holds the RAW answers the graph engine matched edge
    // conditions against (e.g. travelDate = "Today", not a calendar date —
    // see bookingGraph.service.js's advanceGraphSession). displayOverrides
    // holds the handful of fields that need a different value once the
    // session is over and only display (confirmation text + the persisted
    // bookings.fields row) remains — merged in here, at the one point
    // both engines' completion paths funnel through, so it's never visible
    // to edge-condition matching.
    const displayCollected = { ...session.collected, ...(session.displayOverrides || {}) };
    return await createBookingAndConfirmation(businessId, customerNumber, displayCollected, session.answeredFields, session.localRentalUnconfigured);
  } catch (error) {
    logger.error('Error finalizing graph booking:', error);
    throw error;
  }
};

/**
 * Read-only preview of the vehicle carousel a customer would see for a given
 * pickup/drop/tripType, for the dashboard's Conversation Preview. Delegates
 * straight to the real fare-lookup logic (route fares first, then distance
 * estimate) so preview results match production - no session is touched.
 * @param {string} businessId
 * @param {string} pickupLocation
 * @param {string} dropLocation
 * @param {string} tripType
 * @returns {Promise<Array>} Carousel-shaped vehicle options, or []
 */
const getVehicleCarouselPreview = async (businessId, pickupLocation, dropLocation, tripType) => {
  return findBestVehicleCarouselOptions(businessId, pickupLocation, dropLocation, tripType);
};

/**
 * First-of-next-month, local midnight, relative to the given date.
 */
const getNextMonthStart = (from) => {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0);
};

/**
 * Read-only preview-credit status for a business (remaining count + next reset
 * date), for display on GET /business. Mirrors the lazy-reset math in
 * checkAndConsumeManualPreviewCredit but never mutates/persists, so it's
 * safe to call on every GET.
 * @param {Object} business - a business object with previewCreditsUsed, previewCreditsResetAt, previewCreditsPurchased
 * @returns {{ remaining: number, resetAt: Date }}
 */
const getPreviewCreditsStatus = (business) => {
  const now = new Date();
  // previewCreditsResetAt comes back as an ISO string from Supabase (unlike
  // the Date instance Mongoose used to hand back) — parse before comparing.
  const resetAtDate = business.previewCreditsResetAt ? new Date(business.previewCreditsResetAt) : null;
  const isDue = !resetAtDate || now >= resetAtDate;
  const used = isDue ? 0 : business.previewCreditsUsed;
  const resetAt = isDue ? getNextMonthStart(now) : resetAtDate;
  const remaining = Math.max(0, FREE_MONTHLY_PREVIEW_CREDITS - used) + (business.previewCreditsPurchased || 0);
  return { remaining, resetAt };
};

/**
 * Gate + consume one manual preview credit for the dashboard's Fleet page
 * "Preview as customer" button. Free monthly quota (FREE_MONTHLY_PREVIEW_CREDITS)
 * lazily resets on the first call past previewCreditsResetAt; purchased
 * credits (previewCreditsPurchased) only start decrementing once the free
 * quota for the month is exhausted. Self-contained: loads and saves the business
 * itself, so callers can invoke it directly.
 * @param {string} businessId
 * @returns {Promise<{ allowed: boolean, remaining: number }>}
 */
const checkAndConsumeManualPreviewCredit = async (businessId) => {
  const { data: business, error } = await supabase
    .from('businesses')
    .select('preview_credits_used, preview_credits_reset_at, preview_credits_purchased')
    .eq('id', businessId)
    .maybeSingle();
  if (error) throw error;
  if (!business) {
    throw new Error('Business not found');
  }

  const now = new Date();
  let used = business.preview_credits_used;
  let resetAt = business.preview_credits_reset_at ? new Date(business.preview_credits_reset_at) : null;
  const purchased = business.preview_credits_purchased;

  if (!resetAt || now >= resetAt) {
    used = 0;
    resetAt = getNextMonthStart(now);
  }

  const remaining = Math.max(0, FREE_MONTHLY_PREVIEW_CREDITS - used) + purchased;

  if (remaining <= 0) {
    const { error: saveErr } = await supabase.from('businesses').update({
      preview_credits_used: used,
      preview_credits_reset_at: resetAt.toISOString()
    }).eq('id', businessId);
    if (saveErr) throw saveErr;
    return { allowed: false, remaining: 0 };
  }

  let finalUsed = used;
  let finalPurchased = purchased;
  if (used < FREE_MONTHLY_PREVIEW_CREDITS) {
    finalUsed = used + 1;
  } else {
    finalPurchased = purchased - 1;
  }

  const { error: saveErr } = await supabase.from('businesses').update({
    preview_credits_used: finalUsed,
    preview_credits_reset_at: resetAt.toISOString(),
    preview_credits_purchased: finalPurchased
  }).eq('id', businessId);
  if (saveErr) throw saveErr;

  return { allowed: true, remaining: remaining - 1 };
};

module.exports = {
  getBookingSession,
  saveBookingSession,
  deleteBookingSession,
  recordBookingLead,
  findMatchingVehicleOptions,
  getVehicleCarouselPreview,
  getPreviewCreditsStatus,
  checkAndConsumeManualPreviewCredit,
  normalizeOption,
  // Exported for bookingGraph.service.js to reuse rather than duplicate —
  // pure DB/fare lookups with no dependency on any session shape.
  localizeField,
  findBestVehicleCarouselOptions,
  findRentalVehicleCarouselOptions,
  groupRentalPackagesByKey,
  resolveTravelDateOption,
  // Booking-completion tail for the graph engine (Step 12 wiring) — see the
  // function's own doc comment for why this lives here instead of in
  // bookingGraph.service.js or inline in webhook.controller.js.
  finalizeGraphBooking,
  // Pure formatting reused by flowGraphPreview.controller.js for its
  // synthetic "booking would be created" summary — see its own doc comment.
  buildBookingSummaryBody
};
