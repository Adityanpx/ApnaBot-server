const express = require('express');
const router = express.Router();
const { protect, requireBusiness } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const {
  registerDevice,
  unregisterDevice,
  getPreferences,
  updatePreferences,
  sendTestNotification
} = require('../controllers/notification.controller');

// Mobile push (FCM). Every route is for the signed-in user's own devices and
// settings - owner and staff alike. protect + requireBusiness (the strict one)
// because a device and its settings belong to one business.
router.use(protect, requireBusiness, requireRole('owner', 'staff'));

router.post('/devices',     registerDevice);    // { token, platform, language, appVersion }
router.delete('/devices',   unregisterDevice);  // { token }
router.get('/preferences',  getPreferences);
router.put('/preferences',  updatePreferences);
router.post('/test',        sendTestNotification); // { type? }

module.exports = router;
