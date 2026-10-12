const express = require('express');
const router = express.Router();
const appConfigController = require('../controllers/appConfig.controller');

// Mounted at /api/app (app.js). Public - no auth.
//
// NOTE: any future maintenance-mode gate (middleware that answers 503 while
// app_config 'maintenance_mode' is true) MUST exempt GET /api/app/version.
// The app learns about maintenance from this very endpoint; blocking it would
// leave every client unable to ever find out the maintenance has ended.

// GET /api/app/version
// -> data: { minimumVersion, latestVersion, forceUpdate, maintenanceMode, storeUrl }
// Cache-Control: public, max-age=60. Defaults (1.0.0 / false) when a key is missing.
router.get('/version', appConfigController.getVersion);

module.exports = router;
