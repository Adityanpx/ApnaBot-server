const { errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// razorpay-node rejects with { statusCode, error: { code, description, ... } }
// and no .message. The raw description goes to logs only; clients get a
// generic message so provider/internal details don't leak.
const isRazorpayError = (err) =>
  err && typeof err.error === 'object' && err.error !== null && typeof err.error.description === 'string';

const errorHandler = (err, req, res, next) => {
  logger.error('Error:', err);

  if (isRazorpayError(err)) {
    logger.error(`Razorpay error: status=${err.statusCode}, code=${err.error.code}, field=${err.error.field}, description=${err.error.description}`);
    if (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) {
      return errorResponse(res, 400, 'The payment provider rejected this request. Please try again later or contact support.');
    }
    return errorResponse(res, 502, 'The payment service is temporarily unavailable. Please try again later.');
  }

  if (err.name === 'ValidationError') {
    return errorResponse(res, 400, err.message, Object.values(err.errors).map(e => e.message));
  }

  if (err.code === 11000) {
    return errorResponse(res, 409, 'Duplicate key error', Object.keys(err.keyValue));
  }

  if (err.name === 'JsonWebTokenError') {
    return errorResponse(res, 401, 'Invalid token');
  }

  if (err.name === 'TokenExpiredError') {
    return errorResponse(res, 401, 'Token expired');
  }

  return errorResponse(res, err.statusCode || 500, err.message || 'Internal Server Error');
};

module.exports = errorHandler;
