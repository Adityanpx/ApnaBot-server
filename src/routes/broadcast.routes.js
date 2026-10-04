const express = require('express');
const router = express.Router();
const broadcastController = require('../controllers/broadcast.controller');
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

// All routes require: protect, requireBusiness. Creating and sending (which
// debits the wallet) are owner / superadmin only; staff can still read.

// GET / - List broadcasts
router.get('/', protect, requireBusiness, broadcastController.getBroadcasts);

// POST / - Create broadcast (draft)
router.post('/', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.createBroadcast);

// POST /audience-count - { audienceFilter?, audienceParams? } → { count }, before a draft exists
router.post('/audience-count', protect, requireBusiness, broadcastController.getAudienceCount);

// GET /:id/recipients-preview - Preview the opted-in audience before sending
router.get('/:id/recipients-preview', protect, requireBusiness, broadcastController.getBroadcastRecipientsPreview);

// POST /:id/send - Send a draft broadcast
router.post('/:id/send', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.sendBroadcast);

// GET /:id - Broadcast status + counts, for polling
router.get('/:id', protect, requireBusiness, broadcastController.getBroadcast);

module.exports = router;
