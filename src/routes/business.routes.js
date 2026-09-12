const express = require('express');
const router = express.Router();
const businessController = require('../controllers/business.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');

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
// GET    /vehicle-options     → protect, requireBusiness, requireRole('owner'), business.controller.getVehicleOptions
// POST   /upload-image        → protect, requireBusiness, requireRole('owner'), upload, business.controller.uploadProfileImage

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

module.exports = router;
