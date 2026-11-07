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

// ── Auth limiters (POST /api/auth/login, /admin-login, /forgot-password) ──
// Applied on those routes on top of globalLimiter. In-process memory store like the others
// (single server instance). 429 uses the standard error body; errors.code lets clients translate.
const authLimitBody = (message) => ({ success: false, message, data: null, errors: { code: 'RATE_LIMITED' } });
const emailKey = (req) => {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `${ipKeyGenerator(req.ip)}|${email}`;
};

// Per IP + email: stops guessing one account's password. Only failed attempts count, so a
// successful login never eats the budget.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: emailKey,
  skipSuccessfulRequests: true,
  message: authLimitBody('Too many login attempts, please try again in 15 minutes')
});

// Per IP only, deliberately generous: many real users share one mobile-data (CGNAT) IP, so this
// only stops one address sweeping many emails/passwords.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  skipSuccessfulRequests: true,
  message: authLimitBody('Too many login attempts from this network, please try again in 15 minutes')
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: emailKey,
  message: authLimitBody('Too many reset requests, please try again in an hour')
});

module.exports = {
  loginLimiter,
  loginIpLimiter,
  forgotPasswordLimiter,
  connectLogLimiter,
  globalLimiter,
  webhookLimiter,
  helpFeedbackLimiter,
  translateLimiter
};
