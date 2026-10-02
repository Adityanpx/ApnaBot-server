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
const { BUSINESS_COURSES_SOURCE, COURSE_BATCHES_SOURCE } = require('../utils/flowFieldsValidation');
const { courseIndexFromPageKeyword, formTitleForKeyword, formRequestForKeyword } = require('../utils/coachingBotSettings');
const { isTravelFeaturedCategory } = require('../config/categoryFeatures');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a booking_form_tokens row by its token column and classifies it.
 * @param {string} token
 * @returns {Promise<{ row: Object|null, status: 'ok'|'not_found'|'expired'|'used' }>}
 */
const loadToken = async (token) => {
  // booking_form_tokens.token is a uuid column: anything else (a mistyped
  // or truncated link) would make Postgres throw "invalid input syntax for
  // type uuid" → 500. It can't match a row, so it's simply not found.
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return { row: null, status: 'not_found' };
  const { data, error } = await supabase
    .from('booking_form_tokens').select('*').eq('token', token).maybeSingle();
  if (error) throw error;
  if (!data) return { row: null, status: 'not_found' };
  if (data.used_at) return { row: toCamelCase(data), status: 'used' };
  if (new Date(data.expires_at).getTime() < Date.now()) return { row: toCamelCase(data), status: 'expired' };
  return { row: toCamelCase(data), status: 'ok' };
};

/**
 * The token's form node ({ form_fields, keyword }), or null when the token
 * has no flow_node_id or the node no longer exists.
 */
const loadFormNode = async (formToken) => {
  if (!formToken.flowNodeId) return null;
  const { data: node, error } = await supabase
    .from('flow_nodes').select('form_fields, keyword').eq('id', formToken.flowNodeId).maybeSingle();
  if (error) throw error;
  return node;
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
 *
 * formNode: the token's flow node if the caller already loaded it
 * (loadFormNode — GET also needs its keyword); omitted → loaded here.
 */
const resolveFlowFields = async (formToken, business, formNode) => {
  if (formToken.flowNodeId) {
    const node = formNode !== undefined ? formNode : await loadFormNode(formToken);
    if (node?.form_fields && node.form_fields.length > 0) {
      return node.form_fields;
    }
    return business.flowFields || [];
  }
  return business.flowFields || [];
};

/**
 * Fills in options for dropdowns whose list comes from live data rather than
 * the stored field:
 *  - source 'business_courses': the business's active courses, in display
 *    order (see coaching/course.controller.js);
 *  - source 'course_batches': adds optionsByCourse { courseName: [batches] }
 *    for courses that have batches — the form shows the picked course's list,
 *    and the field's own options (e.g. Weekday / Weekend) otherwise.
 * A form with no course list is returned unchanged without any DB call, so
 * every other form behaves exactly as before.
 */
const resolveDynamicOptions = async (businessId, fields) => {
  const isCourseList = (f) => f.type === 'dropdown' && f.source === BUSINESS_COURSES_SOURCE;
  const isBatchList = (f) => f.type === 'dropdown' && f.source === COURSE_BATCHES_SOURCE;
  if (!fields.some(isCourseList)) return fields;
  const { data, error } = await supabase
    .from('business_courses').select('name, batches').eq('business_id', businessId).eq('is_active', true)
    .order('order', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw error;
  const names = (data || []).map(c => c.name);
  const optionsByCourse = Object.fromEntries((data || [])
    .filter(c => Array.isArray(c.batches) && c.batches.length > 0)
    .map(c => [c.name, c.batches]));
  return fields.map(f => {
    if (isCourseList(f)) return { ...f, options: names };
    if (isBatchList(f)) return { ...f, optionsByCourse };
    return f;
  });
};

/**
 * The options a field accepts for the answers given so far: a course-batches
 * field → the picked course's batches, else its own (fallback) options.
 */
const allowedOptions = (field, values) => {
  if (field.source === COURSE_BATCHES_SOURCE && field.optionsByCourse) {
    const byCourse = field.optionsByCourse[values[field.dependsOn]];
    if (Array.isArray(byCourse) && byCourse.length > 0) return byCourse;
  }
  return field.options || [];
};

/**
 * Starting values for the form, { [fieldName]: value }. Today only: a form
 * opened by tapping Free demo / Admission on a Bot Builder course page
 * (token.source_node_id — see webhook.controller.js — whose keyword is
 * page_course_N) pre-selects course N of the published course list in the
 * form's course-list dropdown, if that course is still one of its options.
 * Anything else (typed keyword, menu tap, hand-built flow, course since
 * hidden or renamed) → {} and the parent picks as before. Takes the
 * already-resolved fields, so a form with no course list makes no DB call.
 */
const resolvePrefill = async (formToken, fields) => {
  const courseField = fields.find(f => f.type === 'dropdown' && f.source === BUSINESS_COURSES_SOURCE);
  if (!courseField || !formToken.sourceNodeId) return {};

  const { data: sourceNode, error: nodeError } = await supabase
    .from('flow_nodes').select('keyword').eq('id', formToken.sourceNodeId).eq('business_id', formToken.businessId)
    .maybeSingle();
  if (nodeError) throw nodeError;
  const index = courseIndexFromPageKeyword(sourceNode?.keyword);
  if (index === null) return {};

  const { data: botSettings, error: settingsError } = await supabase
    .from('business_bot_settings').select('published_settings').eq('business_id', formToken.businessId)
    .maybeSingle();
  if (settingsError) throw settingsError;
  const name = botSettings?.published_settings?.courses?.[index]?.name;
  return typeof name === 'string' && courseField.options.includes(name) ? { [courseField.name]: name } : {};
};

/**
 * Page header for the form: { title, subtitle } for a published Bot Builder
 * form node (keyword demo/admission — coachingBotSettings.js
 * #formTitleForKeyword — and the business has published Bot Builder
 * settings), else null and the page keeps its generic header. Any other
 * keyword returns null without a DB call.
 */
const resolveFormTitle = async (formToken, formNode) => {
  const title = formTitleForKeyword(formNode?.keyword);
  if (!title) return null;
  return (await hasPublishedBotSettings(formToken.businessId)) ? title : null;
};

/**
 * Which Bot Builder form this is ({ key: 'demo'|'admission', title }), for
 * saving on the booking — same keyword + published check as
 * resolveFormTitle, else null. Any other keyword: null, no DB call.
 */
const resolveFormRequest = async (formToken, formNode) => {
  const request = formRequestForKeyword(formNode?.keyword);
  if (!request) return null;
  return (await hasPublishedBotSettings(formToken.businessId)) ? request : null;
};

const hasPublishedBotSettings = async (businessId) => {
  const { data: botSettings, error } = await supabase
    .from('business_bot_settings').select('published_at').eq('business_id', businessId)
    .maybeSingle();
  if (error) throw error;
  return !!botSettings?.published_at;
};

/**
 * GET /api/public/service-form/:token
 * Returns just enough to render the form: the business's name and its
 * configured fields (node-scoped form_fields when the token's flow node has
 * any configured, else the business's flow_fields — see resolveFlowFields),
 * plus prefill (starting values, see resolvePrefill) when there are any and
 * formTitle/formSubtitle (see resolveFormTitle) when known.
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

    const formNode = await loadFormNode(formToken);
    const flowFields = await resolveDynamicOptions(formToken.businessId, await resolveFlowFields(formToken, business, formNode));
    // Prefill / title failures must not block the form — the page just uses
    // no starting values / its generic header.
    let prefill = {};
    try {
      prefill = await resolvePrefill(formToken, flowFields);
    } catch (prefillError) {
      logger.error('Error resolving service form prefill:', prefillError);
    }
    let formTitle = null;
    try {
      formTitle = await resolveFormTitle(formToken, formNode);
    } catch (titleError) {
      logger.error('Error resolving service form title:', titleError);
    }

    return successResponse(res, 200, {
      businessName: business.name,
      // Lets the public form page keep its travel wording ("Book your ride",
      // "Confirm Booking", 24/7 Support) only for travel/cab businesses and
      // use neutral wording for every other category. Additive field.
      isTravelBusiness: isTravelFeaturedCategory(business.businessCategory, business.subCategories),
      flowFields,
      // Additive, only when non-empty: starting values, e.g.
      // { course: 'Abacus' } — see resolvePrefill.
      ...(Object.keys(prefill).length > 0 ? { prefill } : {}),
      // Additive, only when known: this form's own page header — see resolveFormTitle.
      ...(formTitle ? { formTitle: formTitle.title, formSubtitle: formTitle.subtitle } : {})
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
    const formNode = await loadFormNode(formToken);
    const flowFields = await resolveDynamicOptions(formToken.businessId, await resolveFlowFields(formToken, business, formNode));

    // A course-list dropdown must hold one of the business's current courses
    // (the list can change between opening the form and submitting it).
    const staleCourse = flowFields.find(f => f.source === BUSINESS_COURSES_SOURCE && f.type === 'dropdown' &&
      values[f.name] !== undefined && values[f.name] !== null && String(values[f.name]).trim() !== '' &&
      !f.options.includes(values[f.name]));
    if (staleCourse) {
      return errorResponse(res, 400, `${staleCourse.label}: please choose one of the listed options`);
    }
    // Same for a batch: one of the picked course's batches (or the fallback).
    const staleBatch = flowFields.find(f => f.source === COURSE_BATCHES_SOURCE && f.type === 'dropdown' &&
      values[f.name] !== undefined && values[f.name] !== null && String(values[f.name]).trim() !== '' &&
      !allowedOptions(f, values).includes(values[f.name]));
    if (staleBatch) {
      return errorResponse(res, 400, `${staleBatch.label}: please choose one of the batches listed for your course`);
    }

    // A required field hidden by an unmet visibleWhen condition (e.g.
    // "Number of days" when Trip Type isn't "Round Trip") must not block
    // submission — only fields actually shown to the customer are required.
    const isFieldApplicable = (field, values) =>
      !field.visibleWhen || values[field.visibleWhen.field] === field.visibleWhen.equals;

    const missingLabels = flowFields
      .filter(field => field.type !== 'display_text' && isFieldApplicable(field, values) && field.required &&
        (values[field.name] === undefined || values[field.name] === null || String(values[field.name]).trim() === ''))
      .map(field => field.label);
    if (missingLabels.length > 0) {
      return errorResponse(res, 400, `Missing required field(s): ${missingLabels.join(', ')}`);
    }

    const collected = {};
    for (const field of flowFields) {
      if (field.type === 'display_text') continue;
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
    const orderedFields = flowFields
      .filter(field => field.type !== 'display_text')
      .map(field => ({
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

    // Saved on the booking: which Bot Builder form this was (Free demo /
    // Admission) and the question labels as the customer saw them. A lookup
    // failure must not block the booking — it's saved without the form name.
    let formRequest = null;
    try {
      formRequest = await resolveFormRequest(formToken, formNode);
    } catch (formRequestError) {
      logger.error('Error resolving service form request type:', formRequestError);
    }
    const formMeta = {
      formKey: formRequest ? formRequest.key : null,
      formTitle: formRequest ? formRequest.title : null,
      fieldLabels: Object.fromEntries(orderedFields.map(f => [f.fieldKey, f.label]))
    };

    const confirmation = await bookingService.createBookingAndConfirmation(
      formToken.businessId,
      formToken.customerNumber,
      collected,
      orderedFields,
      false,
      formMeta
    );

    // Booking is already created at this point — a failure marking the
    // token used or sending the WhatsApp confirmation is logged, not
    // surfaced as a failure to the web page, since the main side effect
    // (the booking row) already succeeded.
    try {
      const { error: usedError } = await supabase
        .from('booking_form_tokens').update({ used_at: new Date().toISOString() }).eq('id', formToken.id);
      if (usedError) throw usedError;

      // imageUrl = payment QR when an advance is requested (text is its caption)
      if (confirmation.imageUrl) {
        await whatsappService.sendImageMessage(
          business.phoneNumberId,
          business.accessToken,
          formToken.customerNumber,
          confirmation.imageUrl,
          confirmation.text
        );
      } else {
        await whatsappService.sendTextMessage(
          business.phoneNumberId,
          business.accessToken,
          formToken.customerNumber,
          confirmation.text
        );
      }
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
