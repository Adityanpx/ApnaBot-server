const contactImportService = require('../services/contactImport.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Services return { status, error } for problems the owner can fix.
const send = (res, result, okStatus = 200, message) => (result && result.error
  ? errorResponse(res, result.status, result.error)
  : successResponse(res, okStatus, result, message));

/**
 * POST /api/contacts/import/preview
 * multipart/form-data with field `file` (.csv / .xlsx, ≤ 5 MB, ≤ 5,000 rows)
 * or JSON { sheetUrl } (a public Google Sheet). Returns { previewToken,
 * expiresAt, source, fileName, sheetUrl, headers, mapping, counts:
 * { total, new, existing, invalid, duplicate } | null, sampleRows,
 * invalidRows }. Nothing is saved to customers yet.
 */
const previewImport = async (req, res, next) => {
  try {
    const result = await contactImportService.preview(req.user.businessId, req.user.userId, {
      file: req.file,
      sheetUrl: req.body && req.body.sheetUrl
    });
    return send(res, result);
  } catch (error) {
    logger.error('Error in previewImport:', error);
    next(error);
  }
};

/**
 * POST /api/contacts/import/preview/:token/recount
 * Body { mapping: { phoneColumn, nameColumn?, firstNameColumn?, lastNameColumn? } }
 * — the preview's counts and samples for a different column choice.
 */
const recountImport = async (req, res, next) => {
  try {
    return send(res, await contactImportService.recount(req.user.businessId, req.params.token, req.body));
  } catch (error) {
    logger.error('Error in recountImport:', error);
    next(error);
  }
};

/**
 * POST /api/contacts/import/commit
 * Body { previewToken, mapping?, groupId? | newGroupName?, optInAttested?,
 * attestationConfirmed? }. optInAttested: true (owner only) needs
 * attestationConfirmed: true and opts in the NEW customers only.
 */
const commitImport = async (req, res, next) => {
  try {
    return send(res, await contactImportService.commit(req.user.businessId, req.user, req.body || {}), 201, 'Contacts imported');
  } catch (error) {
    logger.error('Error in commitImport:', error);
    next(error);
  }
};

/** GET /api/contacts/import — the latest 50 imports, each with canUndo / undoDeadline. */
const listImports = async (req, res, next) => {
  try {
    return send(res, await contactImportService.listBatches(req.user.businessId));
  } catch (error) {
    logger.error('Error in listImports:', error);
    next(error);
  }
};

/**
 * DELETE /api/contacts/import/:batchId
 * Undo, within 7 days: deletes the customers this import created that never
 * messaged / booked (even if they got a broadcast), removes the group
 * memberships it added. Returns { deletedCount, keptCount, membershipsRemoved }.
 */
const undoImport = async (req, res, next) => {
  try {
    return send(res, await contactImportService.undo(req.user.businessId, req.params.batchId), 200, 'Import undone');
  } catch (error) {
    logger.error('Error in undoImport:', error);
    next(error);
  }
};

module.exports = {
  previewImport,
  recountImport,
  commitImport,
  listImports,
  undoImport
};
