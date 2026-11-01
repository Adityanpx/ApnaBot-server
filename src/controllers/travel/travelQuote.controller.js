const travelRouteService = require('../../services/travelRoute.service');
const travelQuoteService = require('../../services/travelQuote.service');
const { successResponse, errorResponse } = require('../../utils/response');
const logger = require('../../utils/logger');

const VALID_PERIODS = ['week', 'month'];

// Thin wrappers: the services throw errors carrying .statusCode (errorHandler maps them).
const handler = (name, fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (!error.statusCode) logger.error(`Error in ${name}:`, error);
    next(error);
  }
};

/** GET /api/travel/routes */
const getRoutes = handler('getRoutes', async (req, res) => {
  const routes = await travelRouteService.listRoutes(req.user.businessId);
  return successResponse(res, 200, { routes });
});

/** POST /api/travel/routes - create, or update when the from/to pair exists */
const createRoute = handler('createRoute', async (req, res) => {
  const route = await travelRouteService.createRoute(req.user.businessId, req.body);
  return successResponse(res, 201, route, 'Route saved successfully');
});

/** PUT /api/travel/routes/:id */
const updateRoute = handler('updateRoute', async (req, res) => {
  const route = await travelRouteService.updateRoute(req.user.businessId, req.params.id, req.body);
  return successResponse(res, 200, route, 'Route updated successfully');
});

/** DELETE /api/travel/routes/:id */
const deleteRoute = handler('deleteRoute', async (req, res) => {
  await travelRouteService.deleteRoute(req.user.businessId, req.params.id);
  return successResponse(res, 200, null, 'Route deleted successfully');
});

/** GET /api/travel/quote-settings -> { settings, advance } */
const getSettings = handler('getSettings', async (req, res) => {
  return successResponse(res, 200, await travelQuoteService.getSettings(req.user.businessId));
});

/** PUT /api/travel/quote-settings (extras + timing; the advance is edited via PUT /api/business) */
const updateSettings = handler('updateSettings', async (req, res) => {
  const result = await travelQuoteService.updateSettings(req.user.businessId, req.body);
  return successResponse(res, 200, result, 'Settings saved successfully');
});

/** GET /api/travel/quotes?status=&page=&limit= */
const getQuotes = handler('getQuotes', async (req, res) => {
  const { status, page, limit } = req.query;
  return successResponse(res, 200, await travelQuoteService.listQuotes(req.user.businessId, { status, page, limit }));
});

/** PUT /api/travel/quotes/:id/cancel */
const cancelQuote = handler('cancelQuote', async (req, res) => {
  const quote = await travelQuoteService.cancelQuote(req.user.businessId, req.params.id);
  return successResponse(res, 200, quote, 'Quote cancelled');
});

/** GET /api/reports/quotes?period=week|month */
const getQuoteReport = handler('getQuoteReport', async (req, res) => {
  const { period } = req.query;
  if (!VALID_PERIODS.includes(period)) {
    return errorResponse(res, 400, `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}`);
  }
  return successResponse(res, 200, await travelQuoteService.getQuoteReport(req.user.businessId, period));
});

module.exports = {
  getRoutes, createRoute, updateRoute, deleteRoute,
  getSettings, updateSettings, getQuotes, cancelQuote, getQuoteReport
};
