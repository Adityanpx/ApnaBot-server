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
 * GET /api/public/service-form/:token
 * Returns just enough to render the form: the business's name and its
 * configured flow_fields — not the whole business row.
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
      flowFields: business.flowFields || []
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
    const flowFields = business.flowFields || [];

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
      if (values[field.name] !== undefined) {
        collected[field.name] = values[field.name];
      }
    }
    const orderedFields = flowFields.map(field => ({
      fieldKey: field.name,
      label: field.label,
      summaryLabel: field.label
    }));

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

module.exports = { getServiceForm, submitServiceForm, getVehicleOptions };
