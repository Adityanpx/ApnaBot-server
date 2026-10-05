const express = require('express');
const router = express.Router();
const messageTemplateController = require('../controllers/messageTemplate.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes require: protect, requireBusiness. Sync / create / submit / delete are
// owner / superadmin only; staff can still list templates.

// GET / - List message templates
router.get('/', protect, requireBusiness, messageTemplateController.getMessageTemplates);

// POST /sync - Pull this business's templates from WhatsApp (1/min per business)
router.post('/sync', protect, requireBusiness, requireRole('owner', 'superadmin'), messageTemplateController.syncMessageTemplates);

// POST / - Create message template (draft)
router.post('/', protect, requireBusiness, requireRole('owner', 'superadmin'), messageTemplateController.createMessageTemplate);

// POST /upload-header-image - Upload a template header image to R2
router.post(
  '/upload-header-image',
  protect,
  requireBusiness,
  requireRole('owner', 'superadmin'),
  uploadSingle,
  messageTemplateController.uploadHeaderImage
);

// PUT /:id/header-media - Attach a media-library file as the template's media header
router.put('/:id/header-media', protect, requireBusiness, requireRole('owner', 'superadmin'), messageTemplateController.setHeaderMedia);

// POST /:id/submit - Submit template to Meta for review
router.post('/:id/submit', protect, requireBusiness, requireRole('owner', 'superadmin'), messageTemplateController.submitMessageTemplate);

// DELETE /:id - Delete a draft/rejected template
router.delete('/:id', protect, requireBusiness, requireRole('owner', 'superadmin'), messageTemplateController.deleteMessageTemplate);

module.exports = router;
