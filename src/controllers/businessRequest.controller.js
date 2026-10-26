const businessRequestService = require('../services/businessRequest.service');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const logger = require('../utils/logger');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/admin/business-requests?status=&page=&limit=
 * Newest first. Each item: the request + businessName / businessCategory (joined, current) and the
 * signup snapshot ownerName / ownerEmail / contactPhone.
 */
const listRequests = async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status !== undefined && !businessRequestService.STATUSES.includes(status)) {
      return errorResponse(res, 400, `status must be one of: ${businessRequestService.STATUSES.join(', ')}`);
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

    const { requests, total } = await businessRequestService.listRequests({ status, page, limit });
    return successResponse(res, 200, { requests, pagination: getPagination(total, page, limit) });
  } catch (error) {
    logger.error('Error in listBusinessRequests:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/business-requests/:id
 * Body: { status?: 'new'|'contacted'|'set_up', notes?: string|null } - at least one.
 */
const updateRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_PATTERN.test(id)) return errorResponse(res, 404, 'Request not found');

    const body = req.body || {};
    const changes = {};
    if (body.status !== undefined) {
      if (!businessRequestService.STATUSES.includes(body.status)) {
        return errorResponse(res, 400, `status must be one of: ${businessRequestService.STATUSES.join(', ')}`);
      }
      changes.status = body.status;
    }
    if (body.notes !== undefined) {
      if (body.notes !== null && typeof body.notes !== 'string') {
        return errorResponse(res, 400, 'notes must be a string or null');
      }
      if (typeof body.notes === 'string' && body.notes.length > businessRequestService.NOTES_MAX) {
        return errorResponse(res, 400, `notes must be ${businessRequestService.NOTES_MAX} characters or less`);
      }
      changes.notes = body.notes === null || !body.notes.trim() ? null : body.notes.trim();
    }
    if (Object.keys(changes).length === 0) {
      return errorResponse(res, 400, 'Nothing to update: send status and/or notes');
    }

    const updated = await businessRequestService.updateRequest(id, changes);
    if (!updated) return errorResponse(res, 404, 'Request not found');
    return successResponse(res, 200, updated, 'Request updated');
  } catch (error) {
    logger.error('Error in updateBusinessRequest:', error);
    next(error);
  }
};

module.exports = { listRequests, updateRequest };
