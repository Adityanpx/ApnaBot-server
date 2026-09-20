const businessMediaService = require('../services/businessMedia.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const VALID_MEDIA_TYPES = ['image', 'video', 'document'];

/**
 * POST /api/business/media
 * multipart/form-data, field name 'file'. media_type/size caps/quota are
 * enforced in businessMedia.service.js.
 */
const uploadMedia = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No file provided');
    }
    const businessId = req.user.businessId;

    const media = await businessMediaService.uploadBusinessMedia(businessId, req.file);

    return successResponse(res, 201, media, 'Media uploaded successfully');
  } catch (error) {
    logger.error('Error in uploadMedia:', error);
    next(error);
  }
};

/**
 * GET /api/business/media
 * Query: ?type=image|video|document (optional)
 */
const listMedia = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { type } = req.query;

    if (type !== undefined && !VALID_MEDIA_TYPES.includes(type)) {
      return errorResponse(res, 400, `type must be one of: ${VALID_MEDIA_TYPES.join(', ')}`);
    }

    const media = await businessMediaService.listBusinessMedia(businessId, type);

    return successResponse(res, 200, { media });
  } catch (error) {
    logger.error('Error in listMedia:', error);
    next(error);
  }
};

/**
 * DELETE /api/business/media/:id
 */
const deleteMedia = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { id } = req.params;

    await businessMediaService.deleteBusinessMedia(businessId, id);

    return successResponse(res, 200, null, 'Media deleted successfully');
  } catch (error) {
    logger.error('Error in deleteMedia:', error);
    next(error);
  }
};

/**
 * GET /api/business/storage-status
 */
const getStorageStatus = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const status = await businessMediaService.getStorageStatus(businessId);

    return successResponse(res, 200, status);
  } catch (error) {
    logger.error('Error in getStorageStatus:', error);
    next(error);
  }
};

module.exports = {
  uploadMedia,
  listMedia,
  deleteMedia,
  getStorageStatus
};
