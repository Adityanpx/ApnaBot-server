const reportsService = require('../services/reports.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

const VALID_PERIODS = ['week', 'month'];

/**
 * GET /api/reports/summary?period=week|month
 */
const getSummary = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { period } = req.query;
    if (!VALID_PERIODS.includes(period)) {
      return errorResponse(res, 400, `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}`);
    }

    const summary = await reportsService.getReportsSummary(businessId, period);

    return successResponse(res, 200, summary);
  } catch (error) {
    logger.error('Error in getSummary:', error);
    next(error);
  }
};

/**
 * GET /api/reports/revenue-by-tag
 */
const getRevenueByTag = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const revenueByTag = await reportsService.getRevenueByTag(businessId);

    return successResponse(res, 200, revenueByTag);
  } catch (error) {
    logger.error('Error in getRevenueByTag:', error);
    next(error);
  }
};

/**
 * GET /api/reports/response-time?period=week|month
 */
const getResponseTime = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const { period } = req.query;
    if (!VALID_PERIODS.includes(period)) {
      return errorResponse(res, 400, `Invalid period. Must be one of: ${VALID_PERIODS.join(', ')}`);
    }

    const responseTime = await reportsService.getResponseTimeStats(businessId, period);

    return successResponse(res, 200, responseTime);
  } catch (error) {
    logger.error('Error in getResponseTime:', error);
    next(error);
  }
};

/**
 * GET /api/reports/funnel
 */
const getFunnel = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const funnel = await reportsService.getPipelineFunnel(businessId);

    return successResponse(res, 200, funnel);
  } catch (error) {
    logger.error('Error in getFunnel:', error);
    next(error);
  }
};

module.exports = {
  getSummary,
  getRevenueByTag,
  getResponseTime,
  getFunnel
};
