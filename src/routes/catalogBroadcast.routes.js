const express = require('express');
const router = express.Router();
const catalogBroadcastController = require('../controllers/catalogBroadcast.controller');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Mounted at /api/catalog/broadcast by catalog.routes.js, so protect, requireBusiness and the 'catalogue' switch have
// already run. This also needs the 'broadcasts' switch (OFF by default per business): while it is off every route
// answers 404 with errors.code 'BROADCASTS_DISABLED', so the apps can say "Broadcasts are not enabled for your
// account" instead of treating it as a missing page. Owner only: sending spends the wallet and messages customers.
router.use(requireCategoryFeature('broadcasts', {
  code: 'BROADCASTS_DISABLED',
  message: 'Broadcasts are not enabled for your account. Contact support.'
}));
const owner = requireRole('owner');

router.post('/preview', owner, catalogBroadcastController.preview);
router.post('/', owner, catalogBroadcastController.send);

module.exports = router;
