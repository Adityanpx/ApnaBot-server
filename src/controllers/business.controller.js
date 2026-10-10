const axios = require('axios');
const businessService = require('../services/business.service');
const tenantService = require('../services/tenant.service');
const subscriptionService = require('../services/subscription.service');
const bookingService = require('../services/booking.service');
const businessCategoryService = require('../services/businessCategory.service');
const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { generateTokens } = require('../services/auth.service');
const logger = require('../utils/logger');
const r2 = require('../services/r2.service');
const { r2KeyFromUrl } = require('../utils/r2Key');
const config = require('../config/env');
const { isValidLanguageCode, LANGUAGE_CATALOG } = require('../utils/languageCatalog');
const { validateFlowFields } = require('../utils/flowFieldsValidation');
const { cleanValue } = require('../utils/templateValue');
const { META_API_BASE } = require('../services/whatsapp.service');
const templateSyncService = require('../services/templateSync.service');
const onboardingService = require('../services/whatsappOnboarding.service');
const { withPaymentIssue, dismissPaymentIssue } = require('../services/accountHealth.service');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves the WABA's phone number ID server-side, for the "connect existing
 * WhatsApp Business app" (QR migration) signup path where Meta's FINISH
 * postMessage often arrives before the number migration has finished on
 * Meta's side, so the frontend doesn't reliably get a phoneNumberId. Retries
 * a few times since the registration can still be in flight.
 */
const resolvePhoneNumberIdForWaba = async (wabaId, accessToken) => {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info('resolvePhoneNumberIdForWaba: starting attempt', { wabaId, attempt, maxAttempts });

    const response = await axios.get(`${META_API_BASE}/${wabaId}/phone_numbers`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const numbers = response.data.data || [];

    logger.info('resolvePhoneNumberIdForWaba: Graph API returned phone numbers', {
      wabaId,
      attempt,
      count: numbers.length
    });

    if (numbers.length === 1) {
      return numbers[0].id;
    }

    if (numbers.length > 1) {
      throw new Error('MULTIPLE_PHONE_NUMBERS');
    }

    if (attempt < maxAttempts) {
      logger.info('resolvePhoneNumberIdForWaba: no phone number yet, retrying', { wabaId, attempt, maxAttempts });
      await sleep(2000);
    }
  }
  return null;
};

/**
 * GET /api/business
 * Get the logged-in owner's business profile
 */
const getBusiness = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return successResponse(res, 200, null, 'No business created yet');
    }

    const business = await businessService.getBusinessByOwnerId(req.user.userId);

    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    // Remove accessToken from response (never expose it). travelSettings
    // fields are also flattened onto the top level for backward
    // compatibility with existing frontend reads (enableDistanceFares etc.
    // used to be plain businesses columns before business_travel_settings,
    // migration 20260921130000) — travelSettings itself stays too, for
    // callers that prefer the nested shape.
    const businessData = { ...businessService.flattenTravelSettings(business), _id: business.id };
    delete businessData.accessToken;
    delete businessData.whatsappRegisterPin;
    withPaymentIssue(businessData);

    const { remaining, resetAt } = bookingService.getPreviewCreditsStatus(business);
    businessData.previewCreditsRemaining = remaining;
    businessData.previewCreditsResetAt = resetAt;
    // Lets the apps hide wallet UI while billing is off (the /api/wallet routes 404).
    businessData.walletEnabled = config.WALLET_BILLING_ENABLED === true;

    return successResponse(res, 200, businessData);
  } catch (error) {
    logger.error('Error in getBusiness:', error);
    next(error);
  }
};

/**
 * POST /api/business
 * Create business (only if user does not have one yet)
 */
const createBusiness = async (req, res, next) => {
  try {
    const { name, businessCategory, subCategories, displayName, address, city } = req.body;

    // Check if user already has a business. users.business_id alone isn't
    // enough — also check ownership directly, so a user whose
    // users.business_id is null but who already owns a businesses row
    // can't create a second one and repoint users.business_id.
    if (req.user.businessId) {
      return errorResponse(res, 409, 'You already have a business. Use PUT /api/business to update it.');
    }
    const ownedBusiness = await businessService.getBusinessByOwnerId(req.user.userId);
    if (ownedBusiness) {
      return errorResponse(res, 409, 'You already have a business. Use PUT /api/business to update it.');
    }

    // Validate required fields
    if (!cleanValue(name)) {
      return errorResponse(res, 400, 'Business name is required');
    }

    if (!businessCategory) {
      return errorResponse(res, 400, 'Business category is required');
    }

    // Validate business category
    if (!(await businessCategoryService.isEnabledCategory(businessCategory))) {
      const enabledCategories = await businessCategoryService.getEnabledCategories();
      return errorResponse(res, 400, `Invalid business category. Must be one of: ${enabledCategories.map((category) => category.value).join(', ')}`);
    }

    // Validate sub-categories (only meaningful when businessCategory is
    // 'multi_brand', but accepted/validated whenever present). A sub-category
    // just needs to exist in the known category list (isKnownCategory) — it
    // doesn't need to be independently enabled for direct signup, since it's
    // tagging what this business also does rather than opening its own
    // standalone signup path (e.g. 'cab' can be a sub-category tag even
    // while direct 'cab' signup stays disabled).
    if (subCategories !== undefined) {
      if (!Array.isArray(subCategories) || subCategories.some((c) => typeof c !== 'string')) {
        return errorResponse(res, 400, 'subCategories must be an array of category strings');
      }
      if (subCategories.includes('multi_brand')) {
        return errorResponse(res, 400, "subCategories cannot include 'multi_brand'");
      }
      const allCategories = await businessCategoryService.getAllCategories();
      const knownValues = new Set(allCategories.map((category) => category.value));
      const unknownCategories = subCategories.filter((c) => !knownValues.has(c));
      if (unknownCategories.length > 0) {
        return errorResponse(res, 400, `Unknown sub-categories: ${unknownCategories.join(', ')}`);
      }
    }

    // Create business. Two concurrent requests can both pass the ownership
    // check above; the loser hits businesses_owner_user_id_key (migration
    // 20260926120000) and gets the same 409 instead of a 500.
    let business;
    try {
      business = await businessService.createBusiness(req.user.userId, {
        name,
        businessCategory,
        subCategories,
        displayName,
        address,
        city
      });
    } catch (createErr) {
      if (createErr.code === '23505' && (createErr.message || '').includes('businesses_owner_user_id_key')) {
        return errorResponse(res, 409, 'You already have a business. Use PUT /api/business to update it.');
      }
      throw createErr;
    }

    // Generate new tokens with businessId
    const userPayload = {
      userId: req.user.userId,
      email: req.user.email,
      role: req.user.role,
      businessId: business.id
    };

    // Starts a new session (its own refresh token, stored in Redis)
    const { accessToken, refreshToken } = await generateTokens(userPayload);

    // Remove accessToken from business data (see getBusiness's comment on
    // flattenTravelSettings for why travelSettings fields are also flattened
    // onto the top level here)
    const businessData = { ...businessService.flattenTravelSettings(business), _id: business.id };
    delete businessData.accessToken;
    delete businessData.whatsappRegisterPin;
    withPaymentIssue(businessData);

    return successResponse(res, 201, {
      business: businessData,
      accessToken,
      refreshToken,
      message: 'Business created successfully.'
    });
  } catch (error) {
    logger.error('Error in createBusiness:', error);
    next(error);
  }
};

/**
 * PUT /api/business
 * Update business profile
 */
const updateBusiness = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    // Set only via POST/DELETE /payment-qr (uploaded to R2), never a raw URL.
    delete req.body.paymentQrUrl;

    if (req.body.name !== undefined && !cleanValue(req.body.name)) {
      return errorResponse(res, 400, 'Business name cannot be empty');
    }

    if (req.body.disabledBookingFields !== undefined) {
      // Validate against this business's own flow_nodes, not the shared
      // business_type_templates row — a business's flow can diverge from its
      // category template after creation, so that's the only correct source
      // of "what fields does this business actually have". field_key is NOT
      // unique per business (an authored node and its manual/computed
      // fallback sibling share one — see 20260829140000_flow_nodes_edges.sql's
      // header comment), so dedupe by field_key when building the map; every
      // sibling pair's required value matches in practice, confirmed against
      // real data before relying on it here.
      const { data: nodes } = await supabase
        .from('flow_nodes')
        .select('field_key, required')
        .eq('business_id', businessId)
        .in('node_type', ['question', 'vehicle_carousel', 'rentalPackage']);
      const flowFieldsByKey = new Map();
      for (const node of nodes || []) {
        if (!flowFieldsByKey.has(node.field_key)) {
          flowFieldsByKey.set(node.field_key, node);
        }
      }

      const invalidFieldKeys = req.body.disabledBookingFields.filter(fieldKey => {
        const flowField = flowFieldsByKey.get(fieldKey);
        return !flowField || flowField.required === true;
      });

      if (invalidFieldKeys.length > 0) {
        return errorResponse(res, 400, `Cannot disable field(s): ${invalidFieldKeys.join(', ')}. Each must be an optional field defined in this business's booking flow.`);
      }
    }

    if (req.body.enabledLanguages !== undefined) {
      const { enabledLanguages } = req.body;
      if (!Array.isArray(enabledLanguages) || enabledLanguages.length < 1 || enabledLanguages.length > 3) {
        return errorResponse(res, 400, 'enabledLanguages must include between 1 and 3 languages.');
      }
      const invalidCodes = enabledLanguages.filter(code => !isValidLanguageCode(code));
      if (invalidCodes.length > 0) {
        return errorResponse(res, 400, `Invalid language code(s): ${invalidCodes.join(', ')}. Must be one of: ${Object.keys(LANGUAGE_CATALOG).join(', ')}`);
      }
      const uniqueCodes = new Set(enabledLanguages);
      if (uniqueCodes.size !== enabledLanguages.length) {
        return errorResponse(res, 400, 'enabledLanguages must not contain duplicate language codes.');
      }
      if (!enabledLanguages.includes('en')) {
        return errorResponse(res, 400, 'English cannot be removed from enabled languages.');
      }
    }

    if (req.body.requireAdvancePayment === true) {
      // type/value can arrive in this same request, or already be set on the
      // business from a prior save (toggling on again after toggling off) —
      // only fetch the existing row if this request doesn't supply both.
      let { advancePaymentType, advancePaymentValue } = req.body;
      const existing = await businessService.getBusinessById(businessId);
      if (advancePaymentType === undefined) advancePaymentType = existing?.advancePaymentType;
      if (advancePaymentValue === undefined) advancePaymentValue = existing?.advancePaymentValue;
      // The advance is requested by sending the payment QR (booking.service.js
      // createBookingAndConfirmation) — without one there's nothing to send.
      if (!existing?.paymentQrUrl) {
        return errorResponse(res, 400, 'Upload your payment QR code before turning on advance payment.');
      }
      if (!['fixed', 'percentage'].includes(advancePaymentType)) {
        return errorResponse(res, 400, "advancePaymentType must be 'fixed' or 'percentage' when requireAdvancePayment is enabled.");
      }
      if (typeof advancePaymentValue !== 'number' || advancePaymentValue <= 0) {
        return errorResponse(res, 400, 'advancePaymentValue must be a positive number when requireAdvancePayment is enabled.');
      }
    }

    const business = await businessService.updateBusiness(businessId, req.body);

    // The webhook re-caches the tenant on every inbound message, so a stale
    // cached name/displayName would otherwise persist past the TTL and keep
    // showing customers the old {{businessName}} indefinitely.
    if ((req.body.name !== undefined || req.body.displayName !== undefined) && business.phoneNumberId) {
      try {
        await tenantService.invalidateTenantCache(business.phoneNumberId);
      } catch (error) {
        logger.error('Error invalidating tenant cache after business name update:', error);
      }
    }

    // Remove accessToken from response (see getBusiness's comment on
    // flattenTravelSettings)
    const businessData = { ...businessService.flattenTravelSettings(business), _id: business.id };
    delete businessData.accessToken;
    delete businessData.whatsappRegisterPin;
    withPaymentIssue(businessData);

    return successResponse(res, 200, businessData);
  } catch (error) {
    logger.error('Error in updateBusiness:', error);
    next(error);
  }
};

// A WhatsApp list message allows at most 10 rows total (Meta limit). We
// reserve one row for the always-appended "Other" option, so at most 9
// business-entered cities are accepted.
const MAX_SERVED_CITIES = 9;

/**
 * GET /api/business/served-cities
 * Get the logged-in business's servedCities list
 */
const getServedCities = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const servedCities = await businessService.getServedCities(businessId);

    return successResponse(res, 200, { servedCities: servedCities || [] });
  } catch (error) {
    logger.error('Error in getServedCities:', error);
    next(error);
  }
};

/**
 * PUT /api/business/served-cities
 * Replace the business's servedCities list
 * Body: { cities: string[] }
 */
const updateServedCities = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { cities } = req.body;
    if (!Array.isArray(cities)) {
      return errorResponse(res, 400, 'cities must be an array of strings');
    }

    // Trim, drop empties, and dedupe case-insensitively (keeping the first
    // occurrence's casing) — stored casing is for display, matching
    // elsewhere is case-insensitive.
    const seen = new Set();
    const sanitizedCities = [];
    for (const city of cities) {
      if (typeof city !== 'string') continue;
      const trimmed = city.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      sanitizedCities.push(trimmed);
    }

    if (sanitizedCities.length > MAX_SERVED_CITIES) {
      return errorResponse(res, 400, `A maximum of ${MAX_SERVED_CITIES} served cities is supported (WhatsApp list messages allow at most 10 options, including "Other").`);
    }

    const servedCities = await businessService.updateServedCities(businessId, sanitizedCities);

    return successResponse(res, 200, { servedCities: servedCities || [] });
  } catch (error) {
    logger.error('Error in updateServedCities:', error);
    next(error);
  }
};

/**
 * GET /api/business/served-cities/suggestions
 * Suggested prefill list of cities, built from this business's active
 * RouteFare routes. Read-only — never saves; the frontend's "prefill from my
 * existing routes" button decides what (if anything) to submit to
 * PUT /served-cities.
 */
const getServedCitySuggestions = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const suggestions = await businessService.getServedCitySuggestions(businessId);

    return successResponse(res, 200, { suggestions });
  } catch (error) {
    logger.error('Error in getServedCitySuggestions:', error);
    next(error);
  }
};

/**
 * POST /api/business/connect-whatsapp
 * Connect a WhatsApp number to the business, on one of two paths:
 *  - cloud_api: a fresh number - register it (/register with a 2-step PIN).
 *  - coexistence: a number already on the WhatsApp Business app - Meta
 *    registers it; we never call /register, and (flag permitting) request the
 *    contacts + history syncs.
 * The path is derived server-side from Meta's phone-number node; the body's
 * onboardingType is only a fallback hint. Body (camelCase or snake_case):
 * { code, wabaId, phoneNumberId?, onboardingType? }
 */
const connectWhatsapp = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const parsed = onboardingService.parseConnectBody(req.body || {});

    logger.info('connectWhatsapp: endpoint hit', {
      businessId,
      wabaId: parsed.wabaId || req.body?.wabaId || req.body?.waba_id,
      codePrefix: typeof parsed.code === 'string' ? parsed.code.slice(0, 10) : undefined,
      phoneNumberIdPresent: !!parsed.phoneNumberId,
      onboardingHint: parsed.onboardingHint
    });

    if (parsed.error) {
      return errorResponse(res, 400, parsed.error);
    }

    const { code, wabaId, onboardingHint } = parsed;
    let { phoneNumberId } = parsed;

    // If the client already has phoneNumberId (the normal case), keep the
    // early duplicate check before hitting Meta at all.
    if (phoneNumberId) {
      const existingBusiness = await businessService.getBusinessByPhoneNumberId(phoneNumberId);
      if (existingBusiness && existingBusiness.id !== businessId) {
        return errorResponse(res, 409, 'This WhatsApp number is already connected to another business.');
      }
    }

    // Exchange the OAuth code for an access token server-side (never trust a
    // client-supplied token)
    let accessToken;
    try {
      logger.info('connectWhatsapp: exchanging code for access token with Meta', { businessId, wabaId });

      const tokenResponse = await axios.get(`${META_API_BASE}/oauth/access_token`, {
        params: {
          client_id: config.META_APP_ID,
          client_secret: config.META_APP_SECRET,
          code
        }
      });
      accessToken = tokenResponse.data.access_token;

      logger.info('connectWhatsapp: access token received from Meta', { businessId, wabaId, tokenReceived: !!accessToken });
    } catch (error) {
      logger.error('Error exchanging WhatsApp signup code:', {
        businessId,
        wabaId,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to exchange authorization code with Meta');
    }

    if (!accessToken) {
      return errorResponse(res, 400, 'Meta did not return an access token');
    }

    // phoneNumberId is missing: Meta's finish event can fire before the number
    // has finished onboarding server-side. Fetch it from the WABA directly now
    // that we have an access token.
    if (!phoneNumberId) {
      logger.info('connectWhatsapp: phoneNumberId missing, resolving via resolvePhoneNumberIdForWaba', { businessId, wabaId });

      try {
        phoneNumberId = await resolvePhoneNumberIdForWaba(wabaId, accessToken);
      } catch (error) {
        if (error.message === 'MULTIPLE_PHONE_NUMBERS') {
          logger.error(`Multiple phone numbers found for WABA ${wabaId} while connecting business ${businessId}; refusing to auto-select.`, {
            businessId,
            wabaId
          });
          return errorResponse(res, 400, 'This WhatsApp Business Account has more than one phone number. Please contact support to complete this connection.');
        }
        logger.error('Error fetching phone numbers for WABA:', {
          businessId,
          wabaId,
          error: error.response?.data || error.message
        });
        return errorResponse(res, 400, 'Failed to fetch WhatsApp phone number details from Meta');
      }

      logger.info('connectWhatsapp: resolvePhoneNumberIdForWaba returned', { businessId, wabaId, phoneNumberId });

      if (!phoneNumberId) {
        return errorResponse(res, 400, "WhatsApp number registration is still processing on Meta's side - please try reconnecting in a minute.");
      }

      const existingBusiness = await businessService.getBusinessByPhoneNumberId(phoneNumberId);
      if (existingBusiness && existingBusiness.id !== businessId) {
        return errorResponse(res, 409, 'This WhatsApp number is already connected to another business.');
      }
    }

    // The business as it was before this connect: tells a repeat connect of the
    // same number from a new one, and which tenant cache key is now stale.
    const previous = await businessService.getBusinessById(businessId);
    const previousPhoneNumberId = previous?.phoneNumberId || null;
    const samePhone = previousPhoneNumberId === phoneNumberId;

    // Subscribe the app to this WABA's webhook events. This is a separate,
    // per-WABA opt-in Meta requires in addition to the app-level webhook
    // fields configured in the Meta App Dashboard - without it, Meta never
    // sends webhook POSTs for messages on this number even though the
    // connection itself succeeds. Not fatal: a business should still be
    // considered connected even if this call fails, but it must be visible
    // in logs since it silently breaks inbound messaging otherwise.
    try {
      logger.info('connectWhatsapp: subscribing app to WABA webhook events', { businessId, wabaId });

      await axios.post(`${META_API_BASE}/${wabaId}/subscribed_apps`, null, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      logger.info('connectWhatsapp: subscribed app to WABA webhook events', { businessId, wabaId });
    } catch (error) {
      logger.error('connectWhatsapp: failed to subscribe app to WABA webhook events - inbound messages will not be received until this is fixed', {
        businessId,
        wabaId,
        error: error.response?.data || error.message
      });
    }

    // Fetch the phone number's node (display number, verified name, platform)
    let phoneNode;
    try {
      phoneNode = await onboardingService.fetchPhoneNode(phoneNumberId, accessToken);
    } catch (error) {
      logger.error('Error fetching WhatsApp phone number details:', {
        businessId,
        wabaId,
        phoneNumberId,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to fetch WhatsApp phone number details from Meta');
    }
    logger.info('connectWhatsapp: phone number node (before onboarding steps)', { businessId, phoneNumberId, node: phoneNode });

    const whatsappNumber = (phoneNode.display_phone_number || '').replace(/[^0-9]/g, '');
    // Meta's verified_name only fills an empty display_name - never overwrites
    // a name the owner set. (`previous` is the row as it was before this connect.)
    const displayName = previous?.displayName ? undefined : phoneNode.verified_name;

    // Validate WhatsApp number format (10-15 digits, no + sign)
    const whatsappRegex = /^[0-9]{10,15}$/;
    if (!whatsappRegex.test(whatsappNumber)) {
      return errorResponse(res, 400, 'Could not determine a valid WhatsApp number for this phone number ID');
    }

    const { type: onboardingType, source: typeSource } = onboardingService.deriveOnboardingType(phoneNode.is_on_biz_app, onboardingHint);
    logger.info('connectWhatsapp: onboarding type', {
      businessId,
      phoneNumberId,
      onboardingType,
      typeSource,
      isOnBizApp: phoneNode.is_on_biz_app,
      platformType: phoneNode.platform_type,
      clientHint: onboardingHint
    });

    // Path A: a fresh Cloud API number must be registered or it can neither
    // send nor receive. Never on coexistence (Meta registers those) and never
    // when Meta already reports CLOUD_API (a repeat connect).
    if (onboardingService.shouldRegister(onboardingType, phoneNode.platform_type)) {
      try {
        const pin = await onboardingService.ensureRegisterPin(businessId);
        logger.info('connectWhatsapp: registering number', { businessId, phoneNumberId });
        await onboardingService.registerNumber(phoneNumberId, accessToken, pin);
        logger.info('connectWhatsapp: number registered', { businessId, phoneNumberId });
      } catch (error) {
        const mapped = onboardingService.mapRegisterError(error);
        // error.config carries the PIN - log only Meta's response.
        logger.error('connectWhatsapp: /register failed - business NOT marked connected', {
          businessId,
          phoneNumberId,
          metaCode: mapped.metaCode,
          error: error.response?.data || error.message
        });
        return errorResponse(res, mapped.status, mapped.message);
      }

      try {
        const nodeAfter = await onboardingService.fetchPhoneNode(phoneNumberId, accessToken);
        logger.info('connectWhatsapp: phone number node (after /register)', { businessId, phoneNumberId, node: nodeAfter });
      } catch (error) {
        logger.warn('connectWhatsapp: could not re-read phone number node after /register', {
          businessId,
          phoneNumberId,
          error: error.response?.data || error.message
        });
      }
    } else {
      logger.info('connectWhatsapp: /register skipped', {
        businessId,
        phoneNumberId,
        reason: onboardingType === 'coexistence' ? 'coexistence number' : `platform_type already ${phoneNode.platform_type}`
      });
    }

    // Connect WhatsApp (service encrypts the access token before saving). A
    // repeat connect of the same number keeps its original connect time - the
    // coexistence 24h sync window is measured from it.
    logger.info('connectWhatsapp: saving connection via businessService.connectWhatsapp', { businessId, wabaId, phoneNumberId });

    const business = await businessService.connectWhatsapp(businessId, {
      phoneNumberId,
      wabaId,
      whatsappNumber,
      accessToken,
      displayName,
      onboardingType,
      connectedAt: samePhone && previous?.whatsappConnectedAt ? undefined : new Date().toISOString(),
      resetCoexSync: !samePhone
    });

    // Invalidate caches after connecting so the new connection takes effect
    // immediately - both tenant keys if the number changed.
    await subscriptionService.invalidateSubscriptionCache(businessId.toString());
    await tenantService.invalidateTenantCache(phoneNumberId);
    if (previousPhoneNumberId && previousPhoneNumberId !== phoneNumberId) {
      await tenantService.invalidateTenantCache(previousPhoneNumberId);
    }

    // Path B: the one-time contacts + history syncs (see decideSyncs). After the
    // connection is saved, so a failed save can never spend them. Never fails
    // the onboarding.
    if (onboardingType === 'coexistence') {
      try {
        const syncs = onboardingService.decideSyncs({
          flagOn: config.COEXISTENCE_SYNC_ENABLED,
          type: onboardingType,
          existing: samePhone ? previous : null,
          phoneNumberId,
          nowMs: Date.now()
        });
        if (!syncs.contacts && !syncs.history) {
          logger.info(`connectWhatsapp: coexistence sync skipped (${syncs.reason || 'already requested'})`, { businessId, phoneNumberId });
        } else {
          const accepted = await onboardingService.requestCoexistenceSyncs(phoneNumberId, accessToken, syncs);
          await businessService.markCoexSyncRequested(businessId, accepted);
        }
      } catch (error) {
        logger.error('connectWhatsapp: coexistence sync step failed (onboarding continues)', {
          businessId,
          phoneNumberId,
          error: error.response?.data || error.message
        });
      }
    }

    // Pull the WABA's existing templates in (fire and forget — the connection
    // is already saved, so a failure here is only logged).
    templateSyncService.runSync(businessId).catch((syncErr) => {
      logger.error('connectWhatsapp: auto template sync failed', {
        businessId,
        error: syncErr.response?.data || syncErr.message
      });
    });

    // Remove secrets from response (see getBusiness's comment on
    // flattenTravelSettings)
    const businessData = { ...businessService.flattenTravelSettings(business), _id: business.id };
    delete businessData.accessToken;
    delete businessData.whatsappRegisterPin;
    withPaymentIssue(businessData);

    logger.info('connectWhatsapp: connection saved, returning success', { businessId, wabaId, phoneNumberId, onboardingType });

    return successResponse(res, 200, {
      business: businessData,
      onboarding_type: onboardingType,
      display_phone_number: phoneNode.display_phone_number,
      verified_name: phoneNode.verified_name,
      name_status: phoneNode.name_status
    }, 'WhatsApp connected successfully');
  } catch (error) {
    logger.error('Error in connectWhatsapp:', {
      businessId: req.user.businessId,
      wabaId: req.body?.wabaId || req.body?.waba_id,
      phoneNumberId: req.body?.phoneNumberId || req.body?.phone_number_id,
      error: error.response?.data || error.message || error
    });
    next(error);
  }
};

/**
 * POST /api/business/payment-issue/dismiss
 * The owner says the WhatsApp payment-method problem is fixed: clears the flag
 * GET /api/business reports as paymentIssue. It comes back if Meta fails a
 * send with the same error again.
 */
const dismissPaymentIssueHandler = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!(await dismissPaymentIssue(businessId))) {
      return errorResponse(res, 500, 'Could not update the payment status. Please try again.');
    }
    return successResponse(res, 200, { paymentIssue: null }, 'Payment issue dismissed');
  } catch (error) {
    logger.error('Error in dismissPaymentIssue:', error);
    next(error);
  }
};

/**
 * DELETE /api/business/disconnect-whatsapp
 * Disconnect WhatsApp from business
 */
const disconnectWhatsapp = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    // Get business first to get phoneNumberId for cache invalidation
    const business = await businessService.getBusinessById(businessId);
    const phoneNumberId = business?.phoneNumberId;

    // Disconnect WhatsApp
    await businessService.disconnectWhatsapp(businessId);

    logger.info('disconnectWhatsapp: WhatsApp disconnected', { businessId, userId: req.user.userId, phoneNumberId });

    // Invalidate tenant cache after disconnecting
    if (phoneNumberId) {
      await tenantService.invalidateTenantCache(phoneNumberId);
    }

    return successResponse(res, 200, null, 'WhatsApp disconnected successfully');
  } catch (error) {
    logger.error('Error in disconnectWhatsapp:', error);
    next(error);
  }
};

/**
 * GET /api/business/dashboard-stats
 * Get today's stats for business dashboard
 */
const getDashboardStats = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const stats = await businessService.getDashboardStats(businessId);

    return successResponse(res, 200, stats);
  } catch (error) {
    logger.error('Error in getDashboardStats:', error);
    next(error);
  }
};

/**
 * POST /api/business/upload-image
 * Upload profile image to R2
 */
const uploadProfileImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    // Upload to R2
    const result = await r2.uploadImage(
      req.file.buffer,
      'business-profiles',
      `business-${businessId}`,
      req.file.mimetype
    );

    // Update business with new profile image URL
    await businessService.updateBusiness(businessId, { profileImage: result.url });

    return successResponse(res, 200, { profileImage: result.url });
  } catch (error) {
    logger.error('Error in uploadProfileImage:', error);
    next(error);
  }
};

/**
 * POST /api/business/payment-qr
 * Upload/replace the owner's UPI payment QR image (multipart, field 'image').
 * Sent to customers as a WhatsApp image — see message.controller.js
 * sendPaymentQr and booking.service.js createBookingAndConfirmation.
 */
const uploadPaymentQr = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }
    // WhatsApp image messages accept only JPEG/PNG (uploadSingle also allows WebP).
    if (!['image/jpeg', 'image/png'].includes(req.file.mimetype)) {
      return errorResponse(res, 400, 'QR image must be a JPEG or PNG.');
    }

    const businessId = req.user.businessId;
    const existing = await businessService.getBusinessById(businessId);
    if (!existing) {
      return errorResponse(res, 404, 'No business found');
    }

    // Timestamped key: a replaced QR must not be served from a CDN/WhatsApp
    // cache under the old URL.
    const result = await r2.uploadImage(
      req.file.buffer,
      'payment-qr',
      `business-${businessId}-${Date.now()}`,
      req.file.mimetype
    );
    await businessService.updateBusiness(businessId, { paymentQrUrl: result.url });

    const oldKey = r2KeyFromUrl(existing.paymentQrUrl);
    if (oldKey) {
      r2.deleteImage(oldKey).catch(err => logger.error('Error deleting old payment QR from R2:', err));
    }

    return successResponse(res, 200, { paymentQrUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadPaymentQr:', error);
    next(error);
  }
};

/**
 * DELETE /api/business/payment-qr
 * Remove the payment QR. Refused while advance payment is on, since the
 * booking flow sends this QR to request the advance.
 */
const deletePaymentQr = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const existing = await businessService.getBusinessById(businessId);
    if (!existing) {
      return errorResponse(res, 404, 'No business found');
    }
    if (existing.requireAdvancePayment) {
      return errorResponse(res, 400, 'Turn off advance payment before removing your payment QR code.');
    }

    await businessService.updateBusiness(businessId, { paymentQrUrl: null });

    const oldKey = r2KeyFromUrl(existing.paymentQrUrl);
    if (oldKey) {
      r2.deleteImage(oldKey).catch(err => logger.error('Error deleting payment QR from R2:', err));
    }

    return successResponse(res, 200, { paymentQrUrl: null });
  } catch (error) {
    logger.error('Error in deletePaymentQr:', error);
    next(error);
  }
};

/**
 * GET /api/business/flow-fields
 * Get the logged-in business's flow_fields (web-form booking link config)
 */
const getFlowFields = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const flowFields = await businessService.getFlowFields(businessId);

    return successResponse(res, 200, { flowFields: flowFields || [] });
  } catch (error) {
    logger.error('Error in getFlowFields:', error);
    next(error);
  }
};

/**
 * PUT /api/business/flow-fields
 * Replace the business's flow_fields
 * Body: { fields: [...] }
 */
const updateFlowFields = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { fields } = req.body;
    const validationError = validateFlowFields(fields);
    if (validationError) {
      return errorResponse(res, 400, validationError);
    }

    const flowFields = await businessService.updateFlowFields(businessId, fields);

    return successResponse(res, 200, { flowFields: flowFields || [] });
  } catch (error) {
    logger.error('Error in updateFlowFields:', error);
    next(error);
  }
};

// Hardcoded starter templates for POST /flow-fields/load-starter-template,
// keyed by business_category. Only categories with a real template belong
// here — loadFlowFieldsStarterTemplate 404s for anything else rather than
// inventing a template nobody asked for.
const FLOW_FIELDS_STARTER_TEMPLATES = {
  travels: [
    {
      name: 'trip_type',
      type: 'radio',
      label: 'Trip Type',
      options: ['One Way', 'Round Trip', 'Local Rental'],
      role: 'tripType',
      required: true
    },
    {
      name: 'pickup_location',
      type: 'address_autocomplete',
      label: 'Pickup Location',
      role: 'pickup',
      required: true
    },
    {
      name: 'drop_location',
      type: 'address_autocomplete',
      label: 'Drop Location',
      role: 'drop',
      required: false
    },
    {
      name: 'travel_date',
      type: 'date',
      label: 'Travel Date',
      required: true
    },
    {
      // No role: utils/flowFieldsValidation.js's ROLE_ALLOWED_TYPES only
      // recognizes pickup/drop/tripType/numberOfDays, and nothing
      // server-side reads a travelDate/returnDate role today — adding one
      // here would just fail validateFlowFields the moment this template is
      // PUT back.
      name: 'return_date',
      type: 'date',
      label: 'Return Date',
      visibleWhen: { field: 'trip_type', equals: 'Round Trip' },
      required: true
    },
    {
      // Placeholder options, not real pricing — this project has no fixed
      // default package list (rental_packages is a real per-business DB
      // table with owner-configured pricing). Owner is expected to edit
      // these before going live.
      name: 'rental_package',
      type: 'dropdown',
      label: 'Rental Package',
      options: ['4 Hrs / 40 KM', '8 Hrs / 80 KM', '12 Hrs / 120 KM', 'Full Day (24 Hrs)', 'Custom'],
      visibleWhen: { field: 'trip_type', equals: 'Local Rental' },
      required: true
    },
    {
      name: 'choose_a_vehicle',
      type: 'icon_select',
      label: 'Choose a Vehicle',
      source: 'vehicle_catalog',
      required: true
    },
    {
      name: 'note',
      type: 'textarea',
      label: 'Note',
      required: false
    }
  ]
};

/**
 * POST /api/business/flow-fields/load-starter-template
 * Body: { category }
 * Returns a hardcoded starter flow_fields array for the given category.
 * Does NOT save anything — the frontend shows this to the owner for
 * review/editing, and PUT /flow-fields (already validated) is what actually
 * persists it once confirmed.
 */
const loadFlowFieldsStarterTemplate = async (req, res, next) => {
  try {
    const { category } = req.body;

    if (!category || typeof category !== 'string') {
      return errorResponse(res, 400, 'category is required');
    }

    const template = FLOW_FIELDS_STARTER_TEMPLATES[category];
    if (!template) {
      return errorResponse(res, 404, 'No starter template available for this category yet');
    }

    return successResponse(res, 200, { fields: template });
  } catch (error) {
    logger.error('Error in loadFlowFieldsStarterTemplate:', error);
    next(error);
  }
};

/**
 * GET /api/business/vehicle-options
 * This business's active vehicles, for the flow-fields builder to preview
 * icon_select fields. Same shape as the public
 * GET /api/public/service-form/:token/vehicle-options counterpart.
 */
const getVehicleOptions = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { data, error } = await supabase
      .from('vehicles')
      .select('id, custom_name, custom_photo_url, catalog:vehicle_type_catalog(name, photo_url)')
      .eq('business_id', businessId)
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

module.exports = {
  getBusiness,
  createBusiness,
  updateBusiness,
  getServedCities,
  updateServedCities,
  getServedCitySuggestions,
  connectWhatsapp,
  disconnectWhatsapp,
  dismissPaymentIssue: dismissPaymentIssueHandler,
  getDashboardStats,
  uploadProfileImage,
  uploadPaymentQr,
  deletePaymentQr,
  getFlowFields,
  updateFlowFields,
  loadFlowFieldsStarterTemplate,
  getVehicleOptions
};
