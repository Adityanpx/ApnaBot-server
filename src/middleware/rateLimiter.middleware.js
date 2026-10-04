const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again after a minute'
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // limit each IP to 1000 requests per windowMs (Meta sends fast)
  message: 'Too many requests from this IP, please try again after a minute'
});

// Public, unauthenticated Help Center votes (POST /api/public/help-feedback)
// — applied on that route, on top of globalLimiter.
const helpFeedbackLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 votes per windowMs
  message: 'Too many requests from this IP, please try again after a minute'
});

module.exports = {
  globalLimiter,
  webhookLimiter,
  helpFeedbackLimiter
};
