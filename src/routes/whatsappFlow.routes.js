const express = require('express');
const router = express.Router();
const flowDefinitionController = require('../controllers/flowDefinition.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// SuperAdmin only - same protect + requireRole('superadmin') pattern as categoryTemplate.routes.js
router.use(protect, requireRole('superadmin'));

router.get('/', flowDefinitionController.getWhatsappFlows);
router.post('/', flowDefinitionController.createWhatsappFlow);
router.put('/:id', flowDefinitionController.updateWhatsappFlow);
router.delete('/:id', flowDefinitionController.deleteWhatsappFlow);
router.post('/:id/publish-to-business', flowDefinitionController.publishFlowToBusiness);

module.exports = router;
