const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const businessRequestController = require('../controllers/businessRequest.controller');

// Mounted at /api/admin/business-requests (app.js, above the /api/admin catch-all) - superadmin only.
router.use(protect, requireRole('superadmin'));

// GET /api/admin/business-requests?status=new|contacted|set_up&page=1&limit=20
router.get('/', businessRequestController.listRequests);

// PUT /api/admin/business-requests/:id   Body: { status?, notes? }
router.put('/:id', businessRequestController.updateRequest);

module.exports = router;
