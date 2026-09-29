const express = require('express');
const router = express.Router();
const courseController = require('../controllers/coaching/course.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// A business's own courses (business_courses) — part of the coaching Bot
// Builder feature: available only while the category's 'bot_builder' switch
// is on (Super Admin → Business Settings → Features); 404 otherwise.
// Reads open to any business member; writes owner-only, same split as
// vehicle.routes.js.
router.use(protect, requireBusiness, requireCategoryFeature('bot_builder'));

// GET /catalog - Super Admin catalog for this business's category (+ alreadyAdded)
router.get('/catalog', courseController.getCourseCatalogForBusiness);

// GET / - this business's courses in display order
router.get('/', courseController.getCourses);

// POST / - { catalogId } (copy from catalog) or { name, description?, details? } (own course)
router.post('/', requireRole('owner'), courseController.createCourse);

// PUT /reorder - registered before /:id so "reorder" isn't read as an id
router.put('/reorder', requireRole('owner'), courseController.reorderCourses);

// PUT /:id - edit name/description/details/buttons/isActive
router.put('/:id', requireRole('owner'), courseController.updateCourse);

// DELETE /:id
router.delete('/:id', requireRole('owner'), courseController.deleteCourse);

module.exports = router;
