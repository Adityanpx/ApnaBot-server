const express = require('express');
const router = express.Router();
const courseCatalogController = require('../controllers/coaching/courseCatalog.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// Super Admin course catalog (coaching). Same auth as vehicleCatalog.routes.js:
// superadmin only. Not behind ENABLE_BOT_SETTINGS — Super Admin can curate
// the catalog before the owner-facing feature is switched on.
router.use(protect, requireRole('superadmin'));

// GET /?category=coaching - all entries (active + inactive)
router.get('/', courseCatalogController.getCourseCatalog);

// POST / - add an entry
router.post('/', courseCatalogController.createCourseCatalogEntry);

// PUT /:id - edit name/description/details/isActive/order
router.put('/:id', courseCatalogController.updateCourseCatalogEntry);

// DELETE /:id - remove (businesses keep their copies)
router.delete('/:id', courseCatalogController.deleteCourseCatalogEntry);

module.exports = router;
