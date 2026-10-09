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

// POST /audience-summary - { audienceFilter?, audienceParams? } → { selected, willReceive, skipped, overCap, cap }
// POST /audience-skipped - { audienceFilter?, audienceParams?, reason?, page?, limit? } → { items, pagination }
// Owner / superadmin only: the skipped list names customers (numbers masked).
router.post('/audience-summary', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.getAudienceSummary);
router.post('/audience-skipped', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.getAudienceSkipped);

// GET /:id/recipients-preview - Preview the opted-in audience before sending
router.get('/:id/recipients-preview', protect, requireBusiness, broadcastController.getBroadcastRecipientsPreview);

// GET /:id/recipients?status=&page=&limit= - who got it, and who failed and why.
// Owner / superadmin only: it lists customers' names and numbers; staff still see the counts on GET /:id.
router.get('/:id/recipients', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.getBroadcastRecipients);

// POST /:id/send - Send a draft broadcast
router.post('/:id/send', protect, requireBusiness, requireRole('owner', 'superadmin'), broadcastController.sendBroadcast);

// GET /:id - Broadcast status + counts + delivery stats (queued / sent / delivered / read / failed), for polling
router.get('/:id', protect, requireBusiness, broadcastController.getBroadcast);

module.exports = router;
