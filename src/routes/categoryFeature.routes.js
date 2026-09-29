const express = require('express');
const router = express.Router();
const categoryFeatureController = require('../controllers/categoryFeature.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// Super Admin feature switches per business category (category_features).
router.use(protect, requireRole('superadmin'));

// GET /:category - switchable features for this category + their state
router.get('/:category', categoryFeatureController.getCategoryFeatures);

// PUT /:category/:feature - { isEnabled } — applies immediately
router.put('/:category/:feature', categoryFeatureController.setCategoryFeature);

module.exports = router;
