const express = require('express');
const router = express.Router();
const translateController = require('../controllers/translate.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { translateLimiter } = require('../middleware/rateLimiter.middleware');

// Mounted at /api/translate (app.js). Owner only; 20 calls/minute per business on top of the
// monthly character cap (app_config translate_monthly_char_cap).
router.use(protect, requireBusiness, requireRole('owner'));

// GET /usage -> { used, cap, remaining, configured }
router.get('/usage', translateController.getUsage);

// POST / -> { translations, warnings, usage }
router.post('/', translateLimiter, translateController.translateTexts);

// POST /flow -> { language, translated, alreadyTranslated, skipped, warnings, usage }
router.post('/flow', translateLimiter, translateController.translateFlow);

module.exports = router;
