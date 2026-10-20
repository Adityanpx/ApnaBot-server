const catalogService = require('../services/catalog.service');
const collectionService = require('../services/catalogCollection.service');
const { uploadCatalogImages: uploadImages, MAX_FILES } = require('../services/catalogMedia.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Catalogue API (mounted at /api/catalog, routes/catalog.routes.js). Services answer { error: { status,
// message, errors } } for an expected failure; anything thrown goes to the error handler.

const respondError = (res, { error }) => errorResponse(res, error.status, error.message, error.errors || null);

const wantsMediaCleanup = (req) => req.query.deleteUnusedMedia === 'true' || (req.body && req.body.deleteUnusedMedia === true);

const handler = (name, fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    logger.error(`Error in ${name}:`, error);
    next(error);
  }
};

/** GET /api/catalog -> { exists, settings, defaults, node, menu, plan, counts, limits, autoTranslated, warnings, replaced } */
const getCatalog = handler('getCatalog', async (req, res) => {
  successResponse(res, 200, await catalogService.loadCatalogView(req.user.businessId));
});

/**
 * PUT /api/catalog  Body: any subset of the settings, plus replaceKeywordNodes?: boolean.
 * 409 errors.code KEYWORD_EXISTS lists the clashing reply nodes; resend with replaceKeywordNodes: true to
 * deactivate them and move their incoming buttons to the catalogue.
 */
const updateCatalog = handler('updateCatalog', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : null;
  if (!body) return errorResponse(res, 400, 'Request body must be an object.');
  const replaceKeywordNodes = body.replaceKeywordNodes;
  delete body.replaceKeywordNodes;
  if (replaceKeywordNodes !== undefined && typeof replaceKeywordNodes !== 'boolean') {
    return errorResponse(res, 400, 'replaceKeywordNodes must be true or false.');
  }
  const result = await catalogService.updateSettings(req.user.businessId, body, { replaceKeywordNodes: replaceKeywordNodes === true });
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result.view, 'Catalogue saved');
});

/** GET /api/catalog/collections -> { collections } */
const listCollections = handler('listCollections', async (req, res) => {
  successResponse(res, 200, { collections: await collectionService.listCollections(req.user.businessId) });
});

/** POST /api/catalog/collections -> 201 { collection } */
const createCollection = handler('createCollection', async (req, res) => {
  const result = await collectionService.createCollection(req.user.businessId, req.body);
  if (result.error) return respondError(res, result);
  return successResponse(res, 201, result, 'Collection created');
});

/** GET /api/catalog/collections/:id -> { collection } */
const getCollection = handler('getCollection', async (req, res) => {
  const collection = await collectionService.getCollection(req.user.businessId, req.params.id);
  if (!collection) return errorResponse(res, 404, 'Collection not found.');
  return successResponse(res, 200, { collection });
});

/** PUT /api/catalog/collections/:id -> { collection, orphanedMedia, deletedMediaIds } */
const updateCollection = handler('updateCollection', async (req, res) => {
  const result = await collectionService.updateCollection(req.user.businessId, req.params.id, req.body, { deleteUnusedMedia: wantsMediaCleanup(req) });
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Collection saved');
});

/** DELETE /api/catalog/collections/:id[?deleteUnusedMedia=true] -> { deletedItems, orphanedMedia, deletedMediaIds } */
const deleteCollection = handler('deleteCollection', async (req, res) => {
  const result = await collectionService.deleteCollection(req.user.businessId, req.params.id, { deleteUnusedMedia: wantsMediaCleanup(req) });
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Collection deleted');
});

/** PUT /api/catalog/collections/reorder  Body { ids: [every collection id, new order] } -> { collections } */
const reorderCollections = handler('reorderCollections', async (req, res) => {
  const result = await collectionService.reorderCollections(req.user.businessId, req.body && req.body.ids);
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Order saved');
});

/** GET /api/catalog/collections/:id/items?limit&offset -> { items, total, limit, offset } */
const listItems = handler('listItems', async (req, res) => {
  const result = await collectionService.listItems(req.user.businessId, req.params.id, req.query);
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result);
});

/** POST /api/catalog/collections/:id/items  Body { items: [{ mediaId, designNo?, priceText?, caption?, captionTranslations? }] } -> 201 { items } */
const createItems = handler('createItems', async (req, res) => {
  const result = await collectionService.createItems(req.user.businessId, req.params.id, req.body && req.body.items);
  if (result.error) return respondError(res, result);
  return successResponse(res, 201, result, 'Photos added');
});

/** PUT /api/catalog/collections/:id/items/reorder  Body { ids } -> { items, total, limit, offset } */
const reorderItems = handler('reorderItems', async (req, res) => {
  const result = await collectionService.reorderItems(req.user.businessId, req.params.id, req.body && req.body.ids);
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Order saved');
});

/** POST /api/catalog/collections/:id/items/bulk -> { affected, ... } */
const bulkItems = handler('bulkItems', async (req, res) => {
  const result = await collectionService.bulkItems(req.user.businessId, req.params.id, req.body);
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Done');
});

/** PUT /api/catalog/items/:itemId -> { item, orphanedMedia, deletedMediaIds } */
const updateItem = handler('updateItem', async (req, res) => {
  const result = await collectionService.updateItem(req.user.businessId, req.params.itemId, req.body, { deleteUnusedMedia: wantsMediaCleanup(req) });
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Photo saved');
});

/** DELETE /api/catalog/items/:itemId[?deleteUnusedMedia=true] -> { orphanedMedia, deletedMediaIds } */
const deleteItem = handler('deleteItem', async (req, res) => {
  const result = await collectionService.deleteItem(req.user.businessId, req.params.itemId, { deleteUnusedMedia: wantsMediaCleanup(req) });
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result, 'Photo deleted');
});

/** POST /api/catalog/media (multipart, field "files", up to 10) -> 201 { uploaded, failed, results, storage } */
const uploadMedia = handler('uploadCatalogMedia', async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return errorResponse(res, 400, `Send 1 to ${MAX_FILES} photos in the "files" field.`, { code: 'NO_FILES' });
  const result = await uploadImages(req.user.businessId, files);
  if (result.uploaded === 0) {
    const first = result.results[0];
    return errorResponse(res, 400, first ? first.error : 'No photo could be uploaded.', { code: first ? first.code : 'UPLOAD_FAILED', ...result });
  }
  return successResponse(res, 201, result, `${result.uploaded} photo${result.uploaded === 1 ? '' : 's'} uploaded`);
});

/** GET /api/catalog/insights?days=7|30 -> { insights: { days, since, totals, collections } } */
const getInsights = handler('getCatalogInsights', async (req, res) => {
  const result = await catalogService.getInsights(req.user.businessId, parseInt(req.query.days, 10) || 7);
  if (result.error) return respondError(res, result);
  return successResponse(res, 200, result);
});

/** GET /api/catalog/share -> { keyword, whatsappNumber, businessName, waLink, reason, catalogueEnabled } */
const getShare = handler('getCatalogShare', async (req, res) => {
  successResponse(res, 200, await catalogService.getShareInfo(req.user.businessId));
});

module.exports = {
  getCatalog, updateCatalog, listCollections, createCollection, getCollection, updateCollection, deleteCollection,
  reorderCollections, listItems, createItems, reorderItems, bulkItems, updateItem, deleteItem, uploadMedia,
  getInsights, getShare
};
