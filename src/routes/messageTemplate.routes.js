const express = require('express');
const router = express.Router();
const messageTemplateController = require('../controllers/messageTemplate.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

// All routes require: protect, requireBusiness

// GET / - List message templates
router.get('/', protect, requireBusiness, messageTemplateController.getMessageTemplates);

// POST / - Create message template (draft)
router.post('/', protect, requireBusiness, messageTemplateController.createMessageTemplate);

// POST /upload-header-image - Upload a template header image to R2
router.post(
  '/upload-header-image',
  protect,
  requireBusiness,
  requireRole('owner'),
  uploadSingle,
  messageTemplateController.uploadHeaderImage
);

// POST /:id/submit - Submit template to Meta for review
router.post('/:id/submit', protect, requireBusiness, messageTemplateController.submitMessageTemplate);

// DELETE /:id - Delete a draft/rejected template
router.delete('/:id', protect, requireBusiness, messageTemplateController.deleteMessageTemplate);

module.exports = router;
