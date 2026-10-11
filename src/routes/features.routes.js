const express = require('express');
const router = express.Router();
const categoryFeatureController = require('../controllers/categoryFeature.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// GET / - { features: { [feature]: boolean } } for the caller's own business.
// Any role (staff included): the apps read it to show or hide screens.
router.get('/', protect, requireBusiness, categoryFeatureController.getMyFeatures);

module.exports = router;
