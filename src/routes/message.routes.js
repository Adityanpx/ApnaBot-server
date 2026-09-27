// src/routes/message.routes.js — REPLACE ENTIRE FILE

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const { requireBusiness } = require('../middleware/business.middleware');
const {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage,
  sendPaymentQr,
  setBotPause
} = require('../controllers/message.controller');

router.use(protect, requireBusiness);

// IMPORTANT: /send and /customer/:customerId/pause must be declared BEFORE
// /:customerId otherwise Express treats 'send'/'customer' as a customerId param
router.post('/send',           requireRole('owner', 'superadmin'),          sendMessage);
// Body: { customerNumber, amount?, bookingId? } — sends businesses.payment_qr_url as an image
router.post('/send-payment-qr', requireRole('owner', 'superadmin'),         sendPaymentQr);
router.patch('/customer/:customerId/pause', requireRole('owner', 'superadmin'), setBotPause);

router.get('/',                requireRole('owner', 'staff', 'superadmin'), getConversations);
router.get('/:customerId',     requireRole('owner', 'staff', 'superadmin'), getChatHistory);
router.put('/:id/read',        requireRole('owner', 'staff', 'superadmin'), markAsRead);

module.exports = router;
