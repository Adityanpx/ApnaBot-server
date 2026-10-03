const express = require('express');
const router = express.Router();
const followupController = require('../controllers/followup.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Available only while 'followups' is on for the business (its category
// switch, or its own override — Super Admin → Features); 404 otherwise.
// Writes require requireRole('owner'); reading is open to any business member.
router.use(protect, requireBusiness, requireCategoryFeature('followups'));

// GET / - every automation with send stats
router.get('/', followupController.listFollowups);

// GET /presets - preset limits, defaults and default texts
router.get('/presets', followupController.getPresets);

// GET /templates - approved, body-only templates a follow-up can use
router.get('/templates', followupController.listFollowupTemplates);

// POST /preview-audience - how many customers a setup would reach right now, no writes
router.post('/preview-audience', followupController.previewAudience);

// GET /:id - one automation
router.get('/:id', followupController.getFollowup);

// GET /:id/sends?page= - send log, newest first
router.get('/:id/sends', followupController.listFollowupSends);

// POST / - create (switched off)
router.post('/', requireRole('owner'), followupController.createFollowup);

// PUT /:id - edit
router.put('/:id', requireRole('owner'), followupController.updateFollowup);

// PATCH /:id/active - { isActive }; switching on re-checks the template
router.patch('/:id/active', requireRole('owner'), followupController.setFollowupActive);

// DELETE /:id - delete (and its send log)
router.delete('/:id', requireRole('owner'), followupController.deleteFollowup);

module.exports = router;
