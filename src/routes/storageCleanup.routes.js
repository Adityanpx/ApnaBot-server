const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const c = require('../controllers/storageCleanup.controller');

// Mounted at /api/admin/storage-cleanup (app.js, above the /api/admin catch-all) - superadmin only.
router.use(protect, requireRole('superadmin'));

router.get('/summary',                 c.getSummary);
router.post('/preview',                c.preview);
router.post('/runs',                   c.createRun);
router.get('/runs',                    c.listRuns);
router.get('/runs/:id',                c.getRun);
router.post('/runs/:id/cancel',        c.cancelRun);
router.get('/runs/:id/export.csv',     c.exportRunCsv);
router.post('/orphan-scan',            c.startOrphanScan);
router.get('/orphan-scan',             c.getOrphanScan);
router.get('/settings',                c.getSettings);
router.put('/settings',                c.updateSettings);
router.put('/businesses/:id/retention', c.setBusinessRetention);

module.exports = router;
