const express = require('express');
const router = express.Router();
const businessCategoryTemplateController = require('../controllers/businessCategoryTemplate.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// SuperAdmin only - same protect + requireRole('superadmin') pattern as categoryTemplate.routes.js
router.use(protect, requireRole('superadmin'));

router.get('/', businessCategoryTemplateController.getBusinessCategoryTemplates);
router.post('/:category/apply/:businessId', businessCategoryTemplateController.applyBusinessCategoryTemplate);

module.exports = router;
