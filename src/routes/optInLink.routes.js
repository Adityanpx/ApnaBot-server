const express = require('express');
const router = express.Router();
const optInLinkController = require('../controllers/optInLink.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Available only while 'opt_in_links' is on for the business (its category
// switch, or its own override — Super Admin → Features); 404 otherwise.
// Writes require requireRole('owner'); reading is open to any business member.
// No DELETE — a link is switched off (isActive: false), never removed, so
// its stats and "Opted in via …" on customers stay intact.
router.use(protect, requireBusiness, requireCategoryFeature('opt_in_links'));

// GET / - every link with stats and wa.me URL
router.get('/', optInLinkController.listOptInLinks);

// GET /:id - one link
router.get('/:id', optInLinkController.getOptInLink);

// POST / - create (gets a fresh code)
router.post('/', requireRole('owner'), optInLinkController.createOptInLink);

// PUT /:id - edit name / greeting / isActive
router.put('/:id', requireRole('owner'), optInLinkController.updateOptInLink);

module.exports = router;
