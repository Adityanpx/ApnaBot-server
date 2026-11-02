const travelRouteService = require('../../services/travelRoute.service');
const travelQuoteService = require('../../services/travelQuote.service');
const quoteReadinessService = require('../../services/quoteReadiness.service');
const quoteFlowSwitchService = require('../../services/quoteFlowSwitch.service');
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

/**
 * GET /api/travel/quote-readiness[?keyword=&aliases=a,b] - the checklist for enabling the chat quote flow:
 * { ready, installed, keyword, acknowledgements, items[] } (services/quoteReadiness.service.js). Works while the
 * travel_quotes switch is off: that is one of its items.
 */
const getQuoteReadiness = handler('getQuoteReadiness', async (req, res) => {
  const keyword = typeof req.query.keyword === 'string' && req.query.keyword.trim() ? req.query.keyword : undefined;
  const aliases = typeof req.query.aliases === 'string' ? req.query.aliases.split(',').map((a) => a.trim()).filter(Boolean) : undefined;
  const readiness = await quoteReadinessService.getQuoteReadiness(req.user.businessId, { keyword, aliases });
  return successResponse(res, 200, readiness);
});

// Body of enable: { keyword?, aliases?, acknowledgeRoundTripTeam? } and nothing else (the business is never read from it).
const parseEnableBody = (body = {}) => {
  const { keyword, aliases, acknowledgeRoundTripTeam } = body || {};
  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.trim().length < 1 || keyword.trim().length > 40)) return { error: 'keyword must be 1-40 characters' };
  if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 10 || aliases.some((a) => typeof a !== 'string' || a.trim().length > 40))) return { error: 'aliases must be a list of up to 10 short words' };
  if (acknowledgeRoundTripTeam !== undefined && typeof acknowledgeRoundTripTeam !== 'boolean') return { error: 'acknowledgeRoundTripTeam must be true or false' };
  return { value: { keyword: keyword === undefined ? undefined : keyword.trim(), aliases, acknowledgeRoundTripTeam: acknowledgeRoundTripTeam === true } };
};

const sendSwitchResult = (res, result) => (result.ok
  ? successResponse(res, result.status, { readiness: result.readiness, alreadyEnabled: !!result.alreadyEnabled }, result.message)
  : errorResponse(res, result.status, result.message, { code: result.code, readiness: result.readiness || null, blockers: result.blockers || [] }));

/** POST /api/travel/quote-flow/enable (owner) - turn the quotes switch on for this business AND install the flow. Idempotent. */
const enableQuoteFlow = handler('enableQuoteFlow', async (req, res) => {
  const parsed = parseEnableBody(req.body);
  if (parsed.error) return errorResponse(res, 400, parsed.error);
  return sendSwitchResult(res, await quoteFlowSwitchService.enableQuoteFlow(req.user.businessId, parsed.value));
});

/** POST /api/travel/quote-flow/open-rates (owner) - switch travel_quotes on WITHOUT installing the flow, so routes can be added. Idempotent. */
const openRates = handler('openRates', async (req, res) => {
  const result = await quoteFlowSwitchService.openRates(req.user.businessId);
  return result.ok
    ? successResponse(res, result.status, { readiness: result.readiness, alreadyOpen: !!result.alreadyOpen }, result.message)
    : sendSwitchResult(res, result);
});

/** POST /api/travel/quote-flow/disable (owner) - remove the quote flow and turn the switch off. Idempotent. */
const disableQuoteFlow = handler('disableQuoteFlow', async (req, res) => sendSwitchResult(res, await quoteFlowSwitchService.disableQuoteFlow(req.user.businessId)));

/** GET /api/admin/businesses/:id/quote-readiness (superadmin) - the same checklist, for a chosen business. */
const adminGetQuoteReadiness = handler('adminGetQuoteReadiness', async (req, res) => {
  const keyword = typeof req.query.keyword === 'string' && req.query.keyword.trim() ? req.query.keyword : undefined;
  return successResponse(res, 200, await quoteReadinessService.getQuoteReadiness(req.params.id, { keyword }));
});

/** POST /api/admin/businesses/:id/quote-flow/enable|disable (superadmin) - the same as the owner's buttons, for a chosen business. */
const adminEnableQuoteFlow = handler('adminEnableQuoteFlow', async (req, res) => {
  const parsed = parseEnableBody(req.body);
  if (parsed.error) return errorResponse(res, 400, parsed.error);
  return sendSwitchResult(res, await quoteFlowSwitchService.enableQuoteFlow(req.params.id, parsed.value));
});
const adminDisableQuoteFlow = handler('adminDisableQuoteFlow', async (req, res) => sendSwitchResult(res, await quoteFlowSwitchService.disableQuoteFlow(req.params.id)));

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

/** POST /api/travel/routes/:id/fill-distance - saves the Google driving distance as the route's one-way distance */
const fillRouteDistance = handler('fillRouteDistance', async (req, res) => {
  const result = await travelRouteService.fillDistance(req.user.businessId, req.params.id);
  return successResponse(res, 200, result, 'Distance saved');
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
  getQuoteReadiness, enableQuoteFlow, openRates, disableQuoteFlow, adminGetQuoteReadiness, adminEnableQuoteFlow, adminDisableQuoteFlow, getRoutes, createRoute, updateRoute, fillRouteDistance, deleteRoute,
  getSettings, updateSettings, getQuotes, cancelQuote, getQuoteReport
};
