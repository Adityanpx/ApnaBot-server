// src/routes/customer.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireBusiness } = require('../middleware/business.middleware');
const {
  getCustomers,
  getCustomerSummary,
  getCustomerById,
  updateCustomer,
  blockCustomer,
  unblockCustomer,
  toggleCustomerOptIn
} = require('../controllers/customer.controller');

router.use(protect, requireBusiness);

router.get('/',             requireRole('owner', 'staff', 'superadmin'), getCustomers);
router.get('/summary',      requireRole('owner', 'staff', 'superadmin'), getCustomerSummary);
router.get('/:id',          requireRole('owner', 'staff', 'superadmin'), getCustomerById);
router.put('/:id',          requireRole('owner', 'superadmin'),          updateCustomer);
router.post('/:id/block',   requireRole('owner', 'superadmin'),          blockCustomer);
router.post('/:id/unblock', requireRole('owner', 'superadmin'),          unblockCustomer);
router.patch('/:id/opt-in', requireRole('owner', 'superadmin'),          toggleCustomerOptIn);

module.exports = router;
