const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { requireBusiness } = require('../middleware/business.middleware');

// ─── PUBLIC ROUTE — No auth (Razorpay calls this directly) ───────────────────
// MUST be declared BEFORE the protect middleware is applied
router.post('/webhook', paymentController.razorpayWebhook);

// ─── PROTECTED ROUTES — require auth + business ──────────────────────────────────
router.use(protect, requireBusiness);

// Businesses' customers pay by QR image now (POST /api/messages/send-payment-qr,
// PUT /api/bookings/:id/payment) — the Razorpay/UPI payment-link endpoints
// were removed.

// Get payment history — FIX: was pointing to getPaymentStatus before
router.get('/history', paymentController.getPaymentHistory);

// Get payment status for a specific booking
router.get('/status/:bookingId', paymentController.getPaymentStatus);

module.exports = router;
