const express = require('express');
const router = express.Router();
const contactGroupController = require('../controllers/contactGroup.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Customer groups. Available only while 'contact_import' is on for the
// business (the same switch as importing); 404 otherwise. Reading is open to
// any business member; writes need owner / superadmin, like the customer
// writes in customer.routes.js.
router.use(protect, requireBusiness, requireCategoryFeature('contact_import'));

const write = requireRole('owner', 'superadmin');

// GET / - every group with member counts
router.get('/', contactGroupController.listGroups);

// POST / - { name }
router.post('/', write, contactGroupController.createGroup);

// PUT /:id - { name }
router.put('/:id', write, contactGroupController.renameGroup);

// DELETE /:id - the group and its memberships (customers stay)
router.delete('/:id', write, contactGroupController.deleteGroup);

// POST /:id/members - { customerIds }
router.post('/:id/members', write, contactGroupController.addGroupMembers);

// POST /:id/members/remove - { customerIds }
router.post('/:id/members/remove', write, contactGroupController.removeGroupMembers);

module.exports = router;
