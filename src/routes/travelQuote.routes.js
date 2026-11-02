const express = require('express');
const router = express.Router();
const travelQuoteController = require('../controllers/travel/travelQuote.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireCategoryFeature } = require('../middleware/categoryFeature.middleware');

// Available only while 'travel_quotes' is on for the business (its category switch or its own
// override - Super Admin -> Features); 404 FEATURE_DISABLED otherwise. Reading is open to any
// business member; writes need requireRole('owner') like /api/route-fares.
router.use(protect, requireBusiness);

// The readiness checklist is the one route that works while the switch is OFF: "is the switch on?" is one of its items.
// It is read-only and open to any business member.
router.get('/quote-readiness', travelQuoteController.getQuoteReadiness);

router.use(requireCategoryFeature('travel_quotes'));

// Route rate card: a route with its per-vehicle prices (route_fares rows)
router.get('/routes', travelQuoteController.getRoutes);
router.post('/routes', requireRole('owner'), travelQuoteController.createRoute);
router.put('/routes/:id', requireRole('owner'), travelQuoteController.updateRoute);
router.post('/routes/:id/fill-distance', requireRole('owner'), travelQuoteController.fillRouteDistance);
router.delete('/routes/:id', requireRole('owner'), travelQuoteController.deleteRoute);

// Extras + quote timing (+ the business-wide advance, read-only)
router.get('/quote-settings', travelQuoteController.getSettings);
router.put('/quote-settings', requireRole('owner'), travelQuoteController.updateSettings);

// Quotes sent to customers
router.get('/quotes', travelQuoteController.getQuotes);
router.put('/quotes/:id/cancel', requireRole('owner'), travelQuoteController.cancelQuote);

module.exports = router;
