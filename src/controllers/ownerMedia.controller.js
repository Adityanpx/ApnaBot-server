const supabase = require('../config/supabase');
const ownerMediaBackfill = require('../services/ownerMediaBackfill.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const loadBusiness = async (id) => {
  const { data, error } = await supabase
    .from('businesses').select('id, business_category, access_token, is_whatsapp_connected').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
};

/** Validates { days } (default and max 7); sends the 400 itself and returns null when invalid. */
const readDays = (req, res) => {
  const days = ownerMediaBackfill.parseDays((req.body || {}).days);
  if (days === null) {
    errorResponse(res, 400, `days must be a whole number from 1 to ${ownerMediaBackfill.MAX_DAYS}`);
    return null;
  }
  return days;
};

/**
 * POST /api/admin/businesses/:id/owner-media/backfill/preview   { days?: 1-7 }
 * How many phone-app media messages a backfill would download. Reads our own
 * database only - no Meta call, so estimatedBytes is null.
 */
const previewBackfill = async (req, res, next) => {
  try {
    const days = readDays(req, res);
    if (days === null) return;
    const business = await loadBusiness(req.params.id);
    if (!business) return errorResponse(res, 404, 'Business not found');
    return successResponse(res, 200, await ownerMediaBackfill.preview(business.id, days));
  } catch (error) {
    logger.error('Error in previewOwnerMediaBackfill:', error);
    next(error);
  }
};

/**
 * POST /api/admin/businesses/:id/owner-media/backfill   { days?: 1-7 }
 * Starts the background download (202). Needs the switch on for the business.
 */
const startBackfill = async (req, res, next) => {
  try {
    const days = readDays(req, res);
    if (days === null) return;
    const business = await loadBusiness(req.params.id);
    if (!business) return errorResponse(res, 404, 'Business not found');
    const result = await ownerMediaBackfill.start(business, days);
    if (result.error) return errorResponse(res, result.status, result.error);
    logger.info('Owner media backfill started by superadmin', { businessId: business.id, days, total: result.job.total, userId: req.user.userId });
    return successResponse(res, 202, result.job, 'Backfill started');
  } catch (error) {
    logger.error('Error in startOwnerMediaBackfill:', error);
    next(error);
  }
};

/** GET /api/admin/businesses/:id/owner-media/backfill/status - the latest job since the server started, or null. */
const getBackfillStatus = async (req, res, next) => {
  try {
    const business = await loadBusiness(req.params.id);
    if (!business) return errorResponse(res, 404, 'Business not found');
    return successResponse(res, 200, { job: ownerMediaBackfill.status(business.id) });
  } catch (error) {
    logger.error('Error in getOwnerMediaBackfillStatus:', error);
    next(error);
  }
};

module.exports = { previewBackfill, startBackfill, getBackfillStatus };
