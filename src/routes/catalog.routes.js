const express = require('express');
const router = express.Router();
const catalogController = require('../controllers/catalog.controller');
const translateController = require('../controllers/translate.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');
const { translateLimiter } = require('../middleware/rateLimiter.middleware');
const { uploadCatalogImages } = require('../middleware/upload.middleware');

// Mounted at /api/catalog (app.js). Available while the 'catalogue' feature is on for the business (it is ON
// by default; Super Admin can switch it off per business -> 404 FEATURE_DISABLED). Writes are owner-only;
// reading is open to any business member, like the flow graph.
router.use(protect, requireBusiness, requireCategoryFeature('catalogue'));
const owner = requireRole('owner');

router.get('/', catalogController.getCatalog);
router.put('/', owner, catalogController.updateCatalog);

router.get('/insights', catalogController.getInsights);
router.get('/share', catalogController.getShare);
router.post('/translate', owner, translateLimiter, translateController.translateCatalog);
router.post('/media', owner, uploadCatalogImages, catalogController.uploadMedia);

router.get('/collections', catalogController.listCollections);
router.post('/collections', owner, catalogController.createCollection);
router.put('/collections/reorder', owner, catalogController.reorderCollections);  // before /:id
router.get('/collections/:id', catalogController.getCollection);
router.put('/collections/:id', owner, catalogController.updateCollection);
router.delete('/collections/:id', owner, catalogController.deleteCollection);

router.get('/collections/:id/items', catalogController.listItems);
router.post('/collections/:id/items', owner, catalogController.createItems);
router.put('/collections/:id/items/reorder', owner, catalogController.reorderItems);  // before /items/:itemId
router.post('/collections/:id/items/bulk', owner, catalogController.bulkItems);

router.put('/items/:itemId', owner, catalogController.updateItem);
router.delete('/items/:itemId', owner, catalogController.deleteItem);

module.exports = router;
