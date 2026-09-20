// Public, unauthenticated, token-gated endpoints backing the web-form
// booking link (an alternative to a Meta WhatsApp Flow — see
// webhook.controller.js's 'web_form_trigger' branch, which mints the token
// and sends the customer this page's link). No `protect`/`requireBusiness`
// middleware: a customer holding a valid, unexpired, unused token IS the
// authorization.
const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const bookingService = require('../services/booking.service');
const whatsappService = require('../services/whatsapp.service');
const placesService = require('../services/places.service');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Loads a booking_form_tokens row by its token column and classifies it.
 * @param {string} token
 * @returns {Promise<{ row: Object|null, status: 'ok'|'not_found'|'expired'|'used' }>}
 */
const loadToken = async (token) => {
  const { data, error } = await supabase
    .from('booking_form_tokens').select('*').eq('token', token).maybeSingle();
  if (error) throw error;
  if (!data) return { row: null, status: 'not_found' };
  if (data.used_at) return { row: toCamelCase(data), status: 'used' };
  if (new Date(data.expires_at).getTime() < Date.now()) return { row: toCamelCase(data), status: 'expired' };
  return { row: toCamelCase(data), status: 'ok' };
};

/**
 * Resolves which field list a token should render/submit against. A token
 * minted from a specific flow_node (flow_node_id set — see
 * webhook.controller.js's web_form_trigger branch) uses that node's own
 * form_fields when it has any configured; otherwise (no flow_node_id at all,
 * a pre-migration token, or a node that exists but has no form_fields set)
 * falls back to the business-wide businesses.flow_fields, same as before
 * per-node fields existed. Kept as an explicit fallback chain rather than
 * silently collapsing "node with no fields configured" into "business-wide
 * default" without it being visible here.
 */
const resolveFlowFields = async (formToken, business) => {
  if (formToken.flowNodeId) {
    const { data: node, error } = await supabase
      .from('flow_nodes').select('form_fields').eq('id', formToken.flowNodeId).maybeSingle();
    if (error) throw error;
    if (node?.form_fields && node.form_fields.length > 0) {
      return node.form_fields;
    }
    return business.flowFields || [];
  }
  return business.flowFields || [];
};

/**
 * GET /api/public/service-form/:token
 * Returns just enough to render the form: the business's name and its
 * configured fields (node-scoped form_fields when the token's flow node has
 * any configured, else the business's flow_fields — see resolveFlowFields).
 */
const getServiceForm = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { row: formToken, status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const business = await businessService.getBusinessById(formToken.businessId);
    if (!business) {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }

    return successResponse(res, 200, {
      businessName: business.name,
      flowFields: await resolveFlowFields(formToken, business)
    });
  } catch (error) {
    logger.error('Error in getServiceForm:', error);
    next(error);
  }
};

/**
 * POST /api/public/service-form/:token/submit
 * Body: { values: { [fieldName]: string } }
 */
const submitServiceForm = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { row: formToken, status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const values = req.body?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return errorResponse(res, 400, 'values must be an object');
    }

    const business = await businessService.getBusinessById(formToken.businessId);
    if (!business) {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    const flowFields = await resolveFlowFields(formToken, business);

    // A required field hidden by an unmet visibleWhen condition (e.g.
    // "Number of days" when Trip Type isn't "Round Trip") must not block
    // submission — only fields actually shown to the customer are required.
    const isFieldApplicable = (field, values) =>
      !field.visibleWhen || values[field.visibleWhen.field] === field.visibleWhen.equals;

    const missingLabels = flowFields
      .filter(field => isFieldApplicable(field, values) && field.required &&
        (values[field.name] === undefined || values[field.name] === null || String(values[field.name]).trim() === ''))
      .map(field => field.label);
    if (missingLabels.length > 0) {
      return errorResponse(res, 400, `Missing required field(s): ${missingLabels.join(', ')}`);
    }

    const collected = {};
    for (const field of flowFields) {
      if (values[field.name] === undefined) continue;

      if (field.type === 'address_autocomplete') {
        // Value is a JSON string encoding { description, lat, lng } (see
        // utils/flowFieldsValidation.js's validateFlowFields doc comment) —
        // client-submitted, so never trust it's well-formed.
        let parsed;
        try {
          parsed = JSON.parse(values[field.name]);
        } catch (parseError) {
          return errorResponse(res, 400, `${field.label} has an invalid value`);
        }
        if (!parsed || typeof parsed.description !== 'string' || !parsed.description.trim()) {
          return errorResponse(res, 400, `${field.label} has an invalid value`);
        }
        // Only the human-readable description goes into `collected`,
        // matching every other field type's plain-string value used for
        // the confirmation message; parsed.lat/parsed.lng are validated
        // above but not needed anywhere else in this handler today.
        collected[field.name] = parsed.description;
      } else {
        collected[field.name] = values[field.name];
      }
    }
    const orderedFields = flowFields.map(field => ({
      fieldKey: field.name,
      label: field.label,
      summaryLabel: field.label
    }));

    // If this business has a distance-fare Vehicle Picker (icon_select +
    // pickup/drop address fields), re-derive the fare server-side from the
    // live route/vehicle data instead of trusting whatever the client
    // submitted — the client never sends a fare at all in this flow, only
    // field values, so this is where the fare enters `collected` at all.
    const vehicleField = flowFields.find(f => f.type === 'icon_select' && f.source === 'vehicle_catalog');
    const pickupField = flowFields.find(f => f.role === 'pickup');
    const dropField = flowFields.find(f => f.role === 'drop');
    if (vehicleField && pickupField && dropField) {
      const tripTypeField = flowFields.find(f => f.role === 'tripType');
      const numberOfDaysField = flowFields.find(f => f.role === 'numberOfDays');

      const options = await bookingService.findDistanceBasedVehicleOptions(
        formToken.businessId,
        collected[pickupField.name],
        collected[dropField.name],
        tripTypeField ? collected[tripTypeField.name] : undefined,
        numberOfDaysField ? collected[numberOfDaysField.name] : undefined
      );
      const matchedOption = options.find(opt => opt.name === collected[vehicleField.name]);
      if (!matchedOption) {
        logger.warn('Vehicle-quote re-verification failed at submit', {
          businessId: formToken.businessId,
          submittedVehicle: collected[vehicleField.name],
          availableVehicles: options.map(opt => opt.name)
        });
        return errorResponse(res, 400, 'Could not verify a fare for the selected vehicle. Please go back and choose again.');
      }

      collected.vehicleFare = matchedOption.fare;
      collected.fareSource = 'distance_estimate';
      collected.distanceKm = matchedOption.distanceKm;
      if (matchedOption.driverDaTotal) {
        collected.driverDaTotal = matchedOption.driverDaTotal;
        collected.driverDaDays = matchedOption.driverDaDays;
        collected.driverDaPerDay = matchedOption.driverDaPerDay;
      }
      // Decorate the vehicle field's own display value with its per-km rate
      // (e.g. "Swift Dzire (₹13/km)") rather than adding a separate line —
      // buildBookingSummaryBody renders orderedFields verbatim, one line per
      // field, so this is the one place that string can be attached to the
      // vehicle's line specifically.
      collected[vehicleField.name] = `${matchedOption.name} (₹${matchedOption.perKmRate}/km)`;
    }

    const confirmationText = await bookingService.createBookingAndConfirmation(
      formToken.businessId,
      formToken.customerNumber,
      collected,
      orderedFields,
      false
    );

    // Booking is already created at this point — a failure marking the
    // token used or sending the WhatsApp confirmation is logged, not
    // surfaced as a failure to the web page, since the main side effect
    // (the booking row) already succeeded.
    try {
      const { error: usedError } = await supabase
        .from('booking_form_tokens').update({ used_at: new Date().toISOString() }).eq('id', formToken.id);
      if (usedError) throw usedError;

      await whatsappService.sendTextMessage(
        business.phoneNumberId,
        business.accessToken,
        formToken.customerNumber,
        confirmationText
      );
    } catch (postBookingError) {
      logger.error('Error marking booking form token used / sending WhatsApp confirmation:', {
        businessId: formToken.businessId,
        customerNumber: formToken.customerNumber,
        message: postBookingError.message,
        stack: postBookingError.stack
      });
    }

    return successResponse(res, 200, null, 'Your request has been submitted successfully.');
  } catch (error) {
    logger.error('Error in submitServiceForm:', error);
    next(error);
  }
};

/**
 * GET /api/public/service-form/:token/vehicle-options
 * Same shape as the owner-facing GET /api/business/vehicle-options, scoped
 * by token instead of auth — lets the public page render icon_select fields
 * with real vehicle photos without requiring login.
 */
const getVehicleOptions = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { row: formToken, status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const { data, error } = await supabase
      .from('vehicles')
      .select('id, custom_name, custom_photo_url, catalog:vehicle_type_catalog(name, photo_url)')
      .eq('business_id', formToken.businessId)
      .eq('is_active', true)
      .order('order', { ascending: true });
    if (error) throw error;

    const vehicleOptions = (data || []).map(vehicle => ({
      id: vehicle.id,
      name: vehicle.custom_name || vehicle.catalog.name,
      imageUrl: vehicle.custom_photo_url || vehicle.catalog.photo_url || null
    }));

    return successResponse(res, 200, { vehicleOptions });
  } catch (error) {
    logger.error('Error in getVehicleOptions:', error);
    next(error);
  }
};

/**
 * POST /api/public/service-form/:token/places-autocomplete
 * Body: { input: string }
 */
const placesAutocomplete = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const input = req.body?.input;
    if (typeof input !== 'string' || !input.trim()) {
      return errorResponse(res, 400, 'input must be a non-empty string');
    }

    const predictions = await placesService.getAutocompletePredictions(input.trim());
    if (predictions === null) {
      return errorResponse(res, 502, 'Could not fetch address suggestions right now.');
    }

    return successResponse(res, 200, { predictions });
  } catch (error) {
    logger.error('Error in placesAutocomplete:', error);
    next(error);
  }
};

/**
 * POST /api/public/service-form/:token/place-details
 * Body: { placeId: string }
 */
const placeDetails = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const placeId = req.body?.placeId;
    if (typeof placeId !== 'string' || !placeId.trim()) {
      return errorResponse(res, 400, 'placeId must be a non-empty string');
    }

    const details = await placesService.getPlaceDetails(placeId.trim());
    if (details === null) {
      return errorResponse(res, 502, 'Could not fetch address details right now.');
    }

    return successResponse(res, 200, details);
  } catch (error) {
    logger.error('Error in placeDetails:', error);
    next(error);
  }
};

/**
 * POST /api/public/service-form/:token/vehicle-quote
 * Body: { pickupDescription, dropDescription, tripType, numberOfDays }
 * Delegates to booking.service.js's findDistanceBasedVehicleOptions — the
 * same distance-fare logic the graph/WhatsApp engine uses — instead of
 * hand-rolling fare math a second time, so Round Trip's day-based distance
 * estimate, driver DA, and real per_km_rate values all come from one place.
 * That function requires business.travelSettings.enableDistanceFares to be turned on; if
 * it isn't, this now returns an empty vehicleQuotes list rather than the
 * unconditional per_km_rate quote this endpoint used to give.
 */
const getVehicleQuote = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { row: formToken, status } = await loadToken(token);

    if (status === 'not_found') {
      return errorResponse(res, 404, 'This booking link is invalid.');
    }
    if (status === 'expired') {
      return errorResponse(res, 410, 'This booking link has expired.');
    }
    if (status === 'used') {
      return errorResponse(res, 410, 'This booking link has already been used.');
    }

    const { pickupDescription, dropDescription, tripType, numberOfDays } = req.body || {};
    if (typeof pickupDescription !== 'string' || !pickupDescription.trim() ||
        typeof dropDescription !== 'string' || !dropDescription.trim()) {
      return errorResponse(res, 400, 'pickupDescription and dropDescription must be non-empty strings');
    }

    const options = await bookingService.findDistanceBasedVehicleOptions(
      formToken.businessId, pickupDescription, dropDescription, tripType, numberOfDays
    );

    const distanceKm = options.length > 0 ? options[0].distanceKm : null;
    const vehicleQuotes = options.map((option) => ({
      id: option.vehicleId,
      name: option.name,
      imageUrl: option.photoUrl,
      estimatedFare: option.fare,
      perKmRate: option.perKmRate
    }));

    return successResponse(res, 200, { distanceKm, vehicleQuotes });
  } catch (error) {
    logger.error('Error in getVehicleQuote:', error);
    next(error);
  }
};

module.exports = { getServiceForm, submitServiceForm, getVehicleOptions, placesAutocomplete, placeDetails, getVehicleQuote };
