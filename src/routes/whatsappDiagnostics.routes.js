const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const c = require('../controllers/whatsappDiagnostics.controller');

// Mounted at /api/super-admin (app.js) - superadmin only.
router.use(protect, requireRole('superadmin'));

// GET /whatsapp-diagnostics[?businessId=] - live Meta checks, nothing stored
router.get('/whatsapp-diagnostics', c.getDiagnostics);
// GET /whatsapp-connect-attempts?businessId= - the last connect attempts for a business
router.get('/whatsapp-connect-attempts', c.listConnectAttempts);

module.exports = router;
