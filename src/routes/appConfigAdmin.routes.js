const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const appConfigController = require('../controllers/appConfig.controller');

// Mounted at /api/admin/app-config (app.js, above the /api/admin catch-all) - superadmin only.
router.use(protect, requireRole('superadmin'));

// GET /api/admin/app-config
router.get('/', appConfigController.getAdminConfig);

// PUT /api/admin/app-config
// Body (partial): { androidMinVersion, androidLatestVersion, forceUpdate, maintenanceMode, playStoreUrl,
//  supportWhatsappNumber, supportMessage, translate caps, unicodeMatchingDefault }
router.put('/', appConfigController.updateAdminConfig);

module.exports = router;
