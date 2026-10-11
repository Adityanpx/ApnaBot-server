// src/routes/staff.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireBusiness } = require('../middleware/business.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');
const {
  getStaff,
  inviteStaff,
  updatePermissions,
  removeStaff,
  toggleStaff
} = require('../controllers/staff.controller');

// All staff management routes — owner only, and only while the 'staff' switch
// is on (on by default; Super Admin → Features, category or per-business) —
// 404 while it's off. Off hides the management routes only: existing staff
// accounts still log in and work (the auth routes and protect don't check it).
router.use(protect, requireBusiness, requireCategoryFeature('staff'), requireRole('owner', 'superadmin'));

router.get('/',                  getStaff);
router.post('/invite',           inviteStaff);
router.put('/:id/permissions',   updatePermissions);
router.delete('/:id',            removeStaff);
router.post('/:id/toggle',       toggleStaff);

module.exports = router;
