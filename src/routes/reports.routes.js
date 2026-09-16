const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reports.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// GET /summary - Reports: leads, bookings, revenue, conversion rate with period-over-period growth
router.get('/summary', protect, requireBusiness, reportsController.getSummary);

// GET /revenue-by-tag - Revenue + customer count grouped by customer tag
router.get('/revenue-by-tag', protect, requireBusiness, reportsController.getRevenueByTag);

// GET /response-time - Average/median minutes to a human (non-bot) reply, with sample size
router.get('/response-time', protect, requireBusiness, reportsController.getResponseTime);

// GET /funnel - Current snapshot count of customers per pipeline stage
router.get('/funnel', protect, requireBusiness, reportsController.getFunnel);

module.exports = router;
