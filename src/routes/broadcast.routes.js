const express = require('express');
const router = express.Router();
const broadcastController = require('../controllers/broadcast.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');

// All routes require: protect, requireBusiness

// GET / - List broadcasts
router.get('/', protect, requireBusiness, broadcastController.getBroadcasts);

// POST / - Create broadcast (draft)
router.post('/', protect, requireBusiness, broadcastController.createBroadcast);

// GET /:id/recipients-preview - Preview the opted-in audience before sending
router.get('/:id/recipients-preview', protect, requireBusiness, broadcastController.getBroadcastRecipientsPreview);

// POST /:id/send - Send a draft broadcast
router.post('/:id/send', protect, requireBusiness, broadcastController.sendBroadcast);

// GET /:id - Broadcast status + counts, for polling
router.get('/:id', protect, requireBusiness, broadcastController.getBroadcast);

module.exports = router;
