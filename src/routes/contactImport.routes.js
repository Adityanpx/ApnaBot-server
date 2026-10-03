const express = require('express');
const router = express.Router();
const contactImportController = require('../controllers/contactImport.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');
const { uploadImportSingle, handleUploadError } = require('../middleware/upload.middleware');

// Available only while 'contact_import' is on for the business (its category
// switch, or its own override — Super Admin → Features); 404 otherwise.
// Owner / superadmin only, like the customer writes in customer.routes.js.
// Attesting opt-in on commit is owner-only (checked in the service).
router.use(protect, requireBusiness, requireCategoryFeature('contact_import'), requireRole('owner', 'superadmin'));

// GET / - the latest imports (with canUndo / undoDeadline)
router.get('/', contactImportController.listImports);

// POST /preview - multipart `file` (.csv / .xlsx) or JSON { sheetUrl }; nothing saved yet.
// handleUploadError turns multer's errors (too large, wrong type) into a 400.
router.post('/preview', uploadImportSingle, handleUploadError, contactImportController.previewImport);

// POST /preview/:token/recount - { mapping }: counts for another column choice
router.post('/preview/:token/recount', contactImportController.recountImport);

// POST /commit - { previewToken, mapping?, groupId? | newGroupName?, optInAttested?, attestationConfirmed? }
router.post('/commit', contactImportController.commitImport);

// DELETE /:batchId - undo, within 7 days
router.delete('/:batchId', contactImportController.undoImport);

module.exports = router;
