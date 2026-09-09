// src/routes/admin.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  getBusinesses,
  getBusinessById,
  toggleBusiness,
  deleteBusiness,
  changeBusinessPlan,
  extendSubscription,
  grantSubscription,
  getSubscriptionHistory,
  getBusinessFlowSnapshots,
  grantPreviewCredits,
  getPlatformStats,
  getRevenueReport,
  getPlans,
  createPlan,
  updatePlan,
  deletePlan
} = require('../controllers/admin.controller');

// All admin routes — superadmin only
router.use(protect, requireRole('superadmin'));

// Businesses
router.get('/businesses',                getBusinesses);
router.get('/businesses/:id',            getBusinessById);
router.put('/businesses/:id/toggle',     toggleBusiness);
router.delete('/businesses/:id',         deleteBusiness);
router.put('/businesses/:id/plan',       changeBusinessPlan);
router.put('/businesses/:id/extend',     extendSubscription);

// Manual subscription grants (superadmin override — bypasses payment)
router.post('/businesses/:id/grant-subscription',     grantSubscription);
router.get('/businesses/:id/subscription-history',    getSubscriptionHistory);
router.get('/businesses/:businessId/flow-snapshots',   getBusinessFlowSnapshots);

// Manual preview-credit grants (additive - tops up previewCreditsPurchased)
router.put('/businesses/:id/preview-credits',          grantPreviewCredits);

// Stats & Revenue
router.get('/stats',                getPlatformStats);
router.get('/revenue',              getRevenueReport);

// Plans
router.get('/plans',                getPlans);
router.post('/plans',               createPlan);
router.put('/plans/:id',            updatePlan);
router.delete('/plans/:id',         deletePlan);

module.exports = router;
