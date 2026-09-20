const express = require('express');
const router = express.Router();
const businessController = require('../controllers/business.controller');
const businessMediaController = require('../controllers/businessMedia.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle, uploadMediaSingle } = require('../middleware/upload.middleware');

// GET    /                   → protect, requireBusiness, business.controller.getBusiness
// POST   /                   → protect, business.controller.createBusiness
// PUT    /                   → protect, requireBusiness, business.controller.updateBusiness
// GET    /served-cities       → protect, requireBusiness, business.controller.getServedCities
// PUT    /served-cities       → protect, requireBusiness, business.controller.updateServedCities
// GET    /served-cities/suggestions → protect, requireBusiness, business.controller.getServedCitySuggestions
// POST   /connect-whatsapp   → protect, requireBusiness, requireRole('owner'), business.controller.connectWhatsapp
// DELETE /disconnect-whatsapp → protect, requireBusiness, requireRole('owner'), business.controller.disconnectWhatsapp
// GET    /dashboard-stats     → protect, requireBusiness, business.controller.getDashboardStats
// GET    /flow-fields         → protect, requireBusiness, requireRole('owner'), business.controller.getFlowFields
// PUT    /flow-fields         → protect, requireBusiness, requireRole('owner'), business.controller.updateFlowFields
// POST   /flow-fields/load-starter-template → protect, requireBusiness, requireRole('owner'), business.controller.loadFlowFieldsStarterTemplate
// GET    /vehicle-options     → protect, requireBusiness, requireRole('owner'), business.controller.getVehicleOptions
// POST   /upload-image        → protect, requireBusiness, requireRole('owner'), upload, business.controller.uploadProfileImage
// POST   /media               → protect, requireBusiness, requireRole('owner'), businessMedia.controller.uploadMedia
// GET    /media                → protect, requireBusiness, businessMedia.controller.listMedia
// DELETE /media/:id            → protect, requireBusiness, requireRole('owner'), businessMedia.controller.deleteMedia
// GET    /storage-status       → protect, requireBusiness, businessMedia.controller.getStorageStatus

// GET / - Get business profile
router.get('/', protect, requireBusiness, businessController.getBusiness);

// POST / - Create business (user has no businessId yet)
router.post('/', protect, businessController.createBusiness);

// PUT / - Update business profile
router.put('/', protect, requireBusiness, businessController.updateBusiness);

// GET /served-cities - Get the business's servedCities list
router.get('/served-cities', protect, requireBusiness, businessController.getServedCities);

// PUT /served-cities - Replace the business's servedCities list
// Body: { cities: string[] }
router.put('/served-cities', protect, requireBusiness, businessController.updateServedCities);

// GET /served-cities/suggestions - Suggested prefill list from this business's
// active RouteFare routes (read-only, does not save)
router.get('/served-cities/suggestions', protect, requireBusiness, businessController.getServedCitySuggestions);

// POST /connect-whatsapp - Connect WhatsApp Business
// Body: { code, wabaId, phoneNumberId } - `code` is the OAuth authorization
// code returned by Meta's Embedded Signup flow. The server exchanges it for
// an access token; raw tokens are never accepted from the client.
router.post(
  '/connect-whatsapp',
  protect,
  requireBusiness,
  requireRole('owner'),
  businessController.connectWhatsapp
);

// DELETE /disconnect-whatsapp - Disconnect WhatsApp
router.delete(
  '/disconnect-whatsapp',
  protect,
  requireBusiness,
  requireRole('owner'),
  businessController.disconnectWhatsapp
);

// GET /dashboard-stats - Get dashboard statistics
router.get('/dashboard-stats', protect, requireBusiness, businessController.getDashboardStats);

// GET /flow-fields - Get the business's web-form booking link field config
router.get('/flow-fields', protect, requireBusiness, requireRole('owner'), businessController.getFlowFields);

// PUT /flow-fields - Replace the business's web-form booking link field config
// Body: { fields: [{ name, type, label, required, options?, visibleWhen? }] }
router.put('/flow-fields', protect, requireBusiness, requireRole('owner'), businessController.updateFlowFields);

// POST /flow-fields/load-starter-template - Body: { category }. Returns a
// hardcoded starter flow_fields array for the category (does NOT save it) so
// the owner can review/edit before confirming via PUT /flow-fields above.
router.post(
  '/flow-fields/load-starter-template',
  protect,
  requireBusiness,
  requireRole('owner'),
  businessController.loadFlowFieldsStarterTemplate
);

// GET /vehicle-options - This business's active vehicles, for the
// flow-fields builder to preview icon_select fields (owner-only, matching
// /flow-fields's access level)
router.get('/vehicle-options', protect, requireBusiness, requireRole('owner'), businessController.getVehicleOptions);

// POST /upload-image - Upload profile image
router.post(
  '/upload-image',
  protect,
  requireBusiness,
  requireRole('owner'),
  uploadSingle,
  businessController.uploadProfileImage
);

// POST /media - Upload a file (image/video/pdf) to this business's media
// library. multipart/form-data, field name 'file'.
router.post(
  '/media',
  protect,
  requireBusiness,
  requireRole('owner'),
  uploadMediaSingle,
  businessMediaController.uploadMedia
);

// GET /media - List this business's media library. Query: ?type=image|video|document
router.get('/media', protect, requireBusiness, businessMediaController.listMedia);

// DELETE /media/:id - Delete a media library asset (rejected if a live
// flow_nodes row still references it)
router.delete(
  '/media/:id',
  protect,
  requireBusiness,
  requireRole('owner'),
  businessMediaController.deleteMedia
);

// GET /storage-status - { usedBytes, limitBytes, usedMb, limitMb }
router.get('/storage-status', protect, requireBusiness, businessMediaController.getStorageStatus);

module.exports = router;
