const express = require('express');
const router = express.Router();
const botSettingsController = require('../controllers/botSettings.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireGraphEngine } = require('../middleware/flowGraph.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Available only while the business category's 'bot_builder' switch is on
// (Super Admin → Business Settings → Features); 404 otherwise.
// requireGraphEngine attaches req.graphBusiness (category gate for presets).
// Writes (save draft, publish) require requireRole('owner'); reading and
// compiling are read-only, so any business member may call them.
router.use(protect, requireBusiness, requireCategoryFeature('bot_builder'), requireGraphEngine);

// GET / - saved settings (or null) + field library for the settings screen
router.get('/', botSettingsController.getBotSettings);

// PUT / - save a draft; the live bot does not change
router.put('/', requireRole('owner'), botSettingsController.saveBotSettings);

// POST /compile - what Publish would produce (saved draft or given settings), no writes
router.post('/compile', botSettingsController.compileBotSettings);

// POST /publish - snapshot current flow, then replace it with the saved settings' flow
router.post('/publish', requireRole('owner'), botSettingsController.publishBotSettings);

module.exports = router;
