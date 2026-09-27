const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireBusiness } = require('../middleware/business.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes: protect, requireBusiness
// Owner and staff can access all booking routes
// Only owner can delete

// GET /api/bookings - List bookings with filters
router.get('/', protect, requireBusiness, bookingController.getBookings);

// GET /preview-vehicle-options - Read-only vehicle carousel preview (must be before /:id)
router.get('/preview-vehicle-options', protect, requireBusiness, bookingController.getVehicleCarouselPreview);

// PUT /:id/status - Update booking status (must be before /:id)
router.put('/:id/status', protect, requireBusiness, bookingController.updateBookingStatus);

// PUT /:id/payment - Record QR payment: { status: 'paid' | 'pending' } (must be before /:id)
router.put('/:id/payment', protect, requireBusiness, bookingController.updateBookingPayment);

// PUT /:id/notes - Add or update internal notes (must be before /:id)
router.put('/:id/notes', protect, requireBusiness, bookingController.addBookingNotes);

// GET /:id - Get single booking detail
router.get('/:id', protect, requireBusiness, bookingController.getBookingById);

// DELETE /:id - Delete booking (owner only)
router.delete('/:id', protect, requireBusiness, requireRole('owner'), bookingController.deleteBooking);

module.exports = router;
