const supabase = require('../config/supabase');
const { generateWebhookToken } = require('../utils/crypto');
const { encrypt } = require('../utils/crypto');
const { toCamelCase } = require('../utils/caseConvert');
const { computeFeatureFlags, isTravelFeaturedCategory } = require('../config/categoryFeatures');
const logger = require('../utils/logger');

const businessFieldMap = {
  name: 'name', displayName: 'display_name', address: 'address', city: 'city',
  profileImage: 'profile_image', upiId: 'upi_id', fallbackReply: 'fallback_reply',
  welcomeMessage: 'welcome_message',
  enableSmartFallback: 'enable_smart_fallback',
  vipEnabled: 'vip_enabled', vipCriteria: 'vip_criteria', vipThreshold: 'vip_threshold',
  disabledBookingFields: 'disabled_booking_fields',
  enabledLanguages: 'enabled_languages', welcomeMessageTranslations: 'welcome_message_translations',
  requireAdvancePayment: 'require_advance_payment', advancePaymentType: 'advance_payment_type',
  advancePaymentValue: 'advance_payment_value',
  businessHours: 'business_hours', footerMessage: 'footer_message',
  businessLatitude: 'business_latitude', businessLongitude: 'business_longitude',
  stopMessage: 'stop_message', stopMessageTranslations: 'stop_message_translations',
  startMessage: 'start_message', startMessageTranslations: 'start_message_translations',
  cancelMessage: 'cancel_message', cancelMessageTranslations: 'cancel_message_translations'
};

// Moved out of `businesses` into business_travel_settings (migration
// 20260921130000) — travel/cab-only fare config, kept as its own field map
// since it now targets a different table from updateBusiness's single call.
const travelSettingsFieldMap = {
  enableDistanceFares: 'enable_distance_fares', enableFleet: 'enable_fleet',
  roundTripPerDayKm: 'round_trip_per_day_km',
  roundTripDriverDaEnabled: 'round_trip_driver_da_enabled',
  roundTripDriverDaAmount: 'round_trip_driver_da_amount'
};

/**
 * Flattens a business object's `.travelSettings` fields (enableDistanceFares
 * etc.) back onto its top level, for API responses that used to return these
 * as plain businesses columns before the business_travel_settings split
 * (migration 20260921130000) — keeps GET/PUT /api/business backward
 * compatible with existing frontend reads. Deliberately picks only the
 * known field names (not a blind spread) so business_travel_settings' own
 * businessId/updatedAt don't leak onto/overwrite the business object's own.
 * @param {Object|null} business - camelCase business object, as returned by attachTravelSettings
 * @returns {Object|null} a NEW object; does not mutate the input
 */
const flattenTravelSettings = (business) => {
  if (!business) return business;
  const flattened = { ...business };
  if (business.travelSettings) {
    for (const field of Object.keys(travelSettingsFieldMap)) {
      flattened[field] = business.travelSettings[field];
    }
  }
  return flattened;
};

/**
 * Attaches `.travelSettings` (camelCase business_travel_settings row) to a
 * camelCase business object. Every business has a business_travel_settings
 * row (backfilled for all businesses at migration time, inserted for every
 * new business at signup — see createBusiness), but this only queries it
 * when the business's category is travel-featured, so a plain business fetch
 * doesn't pay for an unconditional join it'll never use.
 * @param {Object|null} business - camelCase business object (mutated in place)
 * @returns {Promise<Object|null>}
 */
const attachTravelSettings = async (business) => {
  if (!business || !isTravelFeaturedCategory(business.businessCategory, business.subCategories)) {
    return business;
  }
  const { data, error } = await supabase
    .from('business_travel_settings').select('*').eq('business_id', business.id).maybeSingle();
  if (error) throw error;
  business.travelSettings = data ? toCamelCase(data) : null;
  return business;
};

/**
 * Get business by owner user ID
 * @param {string} ownerUserId - The owner's user ID
 * @returns {Promise<Object|null>} camelCase business row, so existing callers written
 *   against the old Mongoose field names (business.businessCategory etc.) keep working
 */
const getBusinessByOwnerId = async (ownerUserId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('owner_user_id', ownerUserId).maybeSingle();
    if (error) throw error;
    return attachTravelSettings(toCamelCase(data));
  } catch (error) {
    logger.error('Error in getBusinessByOwnerId:', error);
    throw error;
  }
};

/**
 * Get business by ID
 * @param {string} businessId - The business ID
 * @returns {Promise<Object|null>}
 */
const getBusinessById = async (businessId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('id', businessId).maybeSingle();
    if (error) throw error;
    return attachTravelSettings(toCamelCase(data));
  } catch (error) {
    logger.error('Error in getBusinessById:', error);
    throw error;
  }
};

/**
 * Get business by phone number ID (used by webhook tenant resolution)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @returns {Promise<Object|null>}
 */
const getBusinessByPhoneNumberId = async (phoneNumberId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('*').eq('phone_number_id', phoneNumberId).maybeSingle();
    if (error) throw error;
    return attachTravelSettings(toCamelCase(data));
  } catch (error) {
    logger.error('Error in getBusinessByPhoneNumberId:', error);
    throw error;
  }
};

/**
 * Create a new business
 * @param {string} ownerUserId - The owner's user ID
 * @param {Object} data - Business data
 * @returns {Promise<Object>}
 */
const createBusiness = async (ownerUserId, data) => {
  try {
    const { name, businessCategory, subCategories, address, city, displayName } = data;

    const webhookVerifyToken = generateWebhookToken();

    const { data: business, error } = await supabase.from('businesses').insert({
      name,
      business_category: businessCategory,
      sub_categories: subCategories || [],
      address,
      city,
      display_name: displayName || name,
      owner_user_id: ownerUserId,
      webhook_verify_token: webhookVerifyToken,
      is_active: true,
      is_whatsapp_connected: false,
      booking_engine: 'graph'
    }).select().single();
    if (error) throw error;

    // Link owner -> business (User is on Supabase too, so this is a plain FK update now)
    const { error: userErr } = await supabase
      .from('users').update({ business_id: business.id }).eq('id', ownerUserId);
    if (userErr) throw userErr;

    // Every business gets a business_travel_settings row at signup (mirrors
    // the unconditional backfill in migration 20260921130000) — computed
    // defaults are all-false for non-travel-featured categories, same as the
    // old inline columns were before this split. Only actually read back
    // (attachTravelSettings) for travel-featured categories.
    const { data: travelSettings, error: travelSettingsErr } = await supabase
      .from('business_travel_settings').insert({
        business_id: business.id,
        ...computeFeatureFlags({ businessCategory, subCategories })
      }).select().single();
    if (travelSettingsErr) throw travelSettingsErr;

    // Deliberately NOT auto-seeding from a category template anymore. Every
    // new business starts with a literal empty graph — no flow_nodes/
    // flow_edges rows at all. Category templates still exist and are still
    // useful, but only as an explicit, owner-initiated action from the
    // Versions tab ("Import starter template", flowSnapshot.controller.js
    // #importCategoryTemplate) — never something applied silently at
    // signup. See business.service.js history for the prior auto-seed
    // behavior this replaces.
    const camelBusiness = toCamelCase(business);
    if (isTravelFeaturedCategory(businessCategory, subCategories)) {
      camelBusiness.travelSettings = toCamelCase(travelSettings);
    }
    return camelBusiness;
  } catch (error) {
    logger.error('Error in createBusiness:', error);
    throw error;
  }
};

/**
 * Update business profile
 * @param {string} businessId - The business ID
 * @param {Object} data - Fields to update
 * @returns {Promise<Object>}
 */
const updateBusiness = async (businessId, data) => {
  try {
    const updateData = {};
    for (const [field, column] of Object.entries(businessFieldMap)) {
      if (data[field] !== undefined) {
        updateData[column] = data[field];
      }
    }

    const travelSettingsUpdateData = {};
    for (const [field, column] of Object.entries(travelSettingsFieldMap)) {
      if (data[field] !== undefined) {
        travelSettingsUpdateData[column] = data[field];
      }
    }

    // A request touching only travel-settings fields (e.g. just
    // enableDistanceFares) would otherwise call .update({}) on businesses —
    // skip that call entirely and fetch the current row instead.
    let business;
    if (Object.keys(updateData).length > 0) {
      const { data: updated, error } = await supabase
        .from('businesses').update(updateData).eq('id', businessId).select().single();
      if (error) throw error;
      business = updated;
    } else {
      const { data: existing, error } = await supabase
        .from('businesses').select('*').eq('id', businessId).single();
      if (error) throw error;
      business = existing;
    }

    if (Object.keys(travelSettingsUpdateData).length > 0) {
      const { error: travelSettingsErr } = await supabase
        .from('business_travel_settings').update(travelSettingsUpdateData).eq('business_id', businessId);
      if (travelSettingsErr) throw travelSettingsErr;
    }

    return attachTravelSettings(toCamelCase(business));
  } catch (error) {
    logger.error('Error in updateBusiness:', error);
    throw error;
  }
};

/**
 * Get a business's servedCities list
 * @param {string} businessId - The business ID
 * @returns {Promise<Array<string>|null>}
 */
const getServedCities = async (businessId) => {
  try {
    const { data, error } = await supabase
      .from('business_travel_settings').select('served_cities').eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    return data ? (data.served_cities || []) : null;
  } catch (error) {
    logger.error('Error in getServedCities:', error);
    throw error;
  }
};

/**
 * Replace a business's servedCities list
 * @param {string} businessId - The business ID
 * @param {Array<string>} cities - Sanitized city list (trimmed, deduped, capped by the caller)
 * @returns {Promise<Array<string>|null>}
 */
const updateServedCities = async (businessId, cities) => {
  try {
    const { data, error } = await supabase
      .from('business_travel_settings').update({ served_cities: cities }).eq('business_id', businessId).select('served_cities').single();
    if (error) throw error;
    return data ? (data.served_cities || []) : null;
  } catch (error) {
    logger.error('Error in updateServedCities:', error);
    throw error;
  }
};

/**
 * Get a business's flowFields list (the web-form booking link's field config)
 * @param {string} businessId - The business ID
 * @returns {Promise<Array|null>}
 */
const getFlowFields = async (businessId) => {
  try {
    const { data, error } = await supabase
      .from('businesses').select('flow_fields').eq('id', businessId).maybeSingle();
    if (error) throw error;
    return data ? (data.flow_fields || []) : null;
  } catch (error) {
    logger.error('Error in getFlowFields:', error);
    throw error;
  }
};

/**
 * Replace a business's flowFields list
 * @param {string} businessId - The business ID
 * @param {Array} fields - Validated field list (see utils/flowFieldsValidation.js#validateFlowFields)
 * @returns {Promise<Array|null>}
 */
const updateFlowFields = async (businessId, fields) => {
  try {
    const { data, error } = await supabase
      .from('businesses').update({ flow_fields: fields }).eq('id', businessId).select('flow_fields').single();
    if (error) throw error;
    return data ? (data.flow_fields || []) : null;
  } catch (error) {
    logger.error('Error in updateFlowFields:', error);
    throw error;
  }
};

/**
 * Title-case a lowercase city name for display (RouteFare stores fromCity/toCity lowercased).
 */
const toTitleCase = (str) => str.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1));

/**
 * Suggested servedCities prefill list, built from this business's active
 * RouteFare routes (unique fromCity/toCity values, title-cased for display).
 * Read-only — callers decide whether/what to save via updateServedCities.
 * @param {string} businessId - The business ID
 * @returns {Promise<Array<string>>}
 */
const getServedCitySuggestions = async (businessId) => {
  try {
    const { data, error } = await supabase
      .from('route_fares').select('from_city, to_city').eq('business_id', businessId).eq('is_active', true);
    if (error) throw error;
    const seen = new Set();
    const suggestions = [];
    for (const rf of data || []) {
      for (const city of [rf.from_city, rf.to_city]) {
        if (!city || seen.has(city)) continue;
        seen.add(city);
        suggestions.push(toTitleCase(city));
      }
    }
    return suggestions.sort((a, b) => a.localeCompare(b));
  } catch (error) {
    logger.error('Error in getServedCitySuggestions:', error);
    return [];
  }
};

/**
 * Connect WhatsApp to business
 * @param {string} businessId - The business ID
 * @param {Object} data - WhatsApp connection data
 * @returns {Promise<Object>}
 */
const connectWhatsapp = async (businessId, data) => {
  try {
    const { phoneNumberId, wabaId, whatsappNumber, accessToken, displayName } = data;

    const encryptedAccessToken = encrypt(accessToken);

    const updateData = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      whatsapp_number: whatsappNumber,
      access_token: encryptedAccessToken,
      is_whatsapp_connected: true
    };

    if (displayName) {
      updateData.display_name = displayName;
    }

    const { data: business, error } = await supabase
      .from('businesses').update(updateData).eq('id', businessId).select().single();
    if (error) throw error;

    return attachTravelSettings(toCamelCase(business));
  } catch (error) {
    logger.error('Error in connectWhatsapp:', error);
    throw error;
  }
};

/**
 * Disconnect WhatsApp from business
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>}
 */
const disconnectWhatsapp = async (businessId) => {
  try {
    const { data: business, error } = await supabase.from('businesses').update({
      phone_number_id: null,
      waba_id: null,
      whatsapp_number: null,
      access_token: null,
      is_whatsapp_connected: false
    }).eq('id', businessId).select().single();
    if (error) throw error;

    return toCamelCase(business);
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    throw error;
  }
};

/**
 * Get dashboard statistics for a business
 * @param {string} businessId - The business ID
 * @returns {Promise<Object>}
 */
const getDashboardStats = async (businessId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const safe = async (fn, label, fallback) => {
    try {
      return await fn();
    } catch (error) {
      logger.error(`getDashboardStats: ${label} failed (model not yet migrated?):`, error.message);
      return fallback;
    }
  };

  // eq: {column: value} filters; gteColumn/gteValue: an additional >= filter (for "today" cutoffs)
  const countRows = async (table, { eq = {}, gteColumn, gteValue } = {}) => {
    let query = supabase.from(table).select('*', { count: 'exact', head: true }).eq('business_id', businessId);
    for (const [column, value] of Object.entries(eq)) {
      query = query.eq(column, value);
    }
    if (gteColumn) query = query.gte(gteColumn, gteValue);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  };

  const [
    todayMessageCount,
    todayInboundCount,
    todayBookingCount,
    totalCustomers,
    newCustomersToday,
    pendingBookings,
    currentMonthUsage
  ] = await Promise.all([
    safe(() => countRows('messages', { gteColumn: 'created_at', gteValue: startOfToday.toISOString() }), 'todayMessageCount', 0),
    safe(() => countRows('messages', { eq: { direction: 'inbound' }, gteColumn: 'created_at', gteValue: startOfToday.toISOString() }), 'todayInboundCount', 0),
    safe(() => countRows('bookings', { gteColumn: 'created_at', gteValue: startOfToday.toISOString() }), 'todayBookingCount', 0),
    safe(() => countRows('customers'), 'totalCustomers', 0),
    safe(() => countRows('customers', { gteColumn: 'first_seen_at', gteValue: startOfToday.toISOString() }), 'newCustomersToday', 0),
    safe(() => countRows('bookings', { eq: { status: 'pending' } }), 'pendingBookings', 0),
    require('./usage.service').getUsageForBusiness(businessId)
  ]);

  return {
    todayMessageCount,
    todayInboundCount,
    todayBookingCount,
    totalCustomers,
    newCustomersToday,
    pendingBookings,
    currentMonthUsage: currentMonthUsage || null
  };
};

module.exports = {
  getBusinessByOwnerId,
  getBusinessById,
  getBusinessByPhoneNumberId,
  createBusiness,
  updateBusiness,
  attachTravelSettings,
  flattenTravelSettings,
  getServedCities,
  updateServedCities,
  getFlowFields,
  updateFlowFields,
  getServedCitySuggestions,
  connectWhatsapp,
  disconnectWhatsapp,
  getDashboardStats
};
