const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

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

// Auto-translate (POST /api/translate*) - applied on those routes, on top of globalLimiter. Keyed by
// business (the monthly character cap is the real budget; this stops a runaway client first).
const translateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each business to 20 translate calls per windowMs
  keyGenerator: (req) => (req.user && req.user.businessId) || ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many translate requests, please try again in a minute', data: null, errors: null }
});

// Client connect log (POST /api/business/whatsapp-connect-log) - on that route, on top of
// globalLimiter. Keyed by business.
const connectLogLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // limit each business to 20 connect logs per windowMs
  keyGenerator: (req) => (req.user && req.user.businessId) || ipKeyGenerator(req.ip),
  message: { success: false, message: 'Too many connect logs, please try again later', data: null, errors: null }
});

module.exports = {
  connectLogLimiter,
  globalLimiter,
  webhookLimiter,
  helpFeedbackLimiter,
  translateLimiter
};
