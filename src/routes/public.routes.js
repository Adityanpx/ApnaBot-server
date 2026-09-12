const express = require('express');
const router = express.Router();
const config = require('../config/env');
const publicServiceFormController = require('../controllers/publicServiceForm.controller');

// GET /api/public/whatsapp-embedded-signup-config
// Returns non-secret Meta app config needed by the client-side Facebook JS SDK
// to launch WhatsApp Embedded Signup. appId/configId are not secrets - they are
// designed to be used in client-side JS SDK calls per Meta's docs.
router.get('/whatsapp-embedded-signup-config', (req, res) => {
  res.json({
    success: true,
    data: {
      appId: config.META_APP_ID,
      configId: config.META_CONFIG_ID
    }
  });
});

// GET /api/public/service-form/:token
// Web-form booking link (alternative to a Meta WhatsApp Flow) — token-gated,
// not auth-gated. Returns the business name + flow_fields needed to render
// the form.
router.get('/service-form/:token', publicServiceFormController.getServiceForm);

// POST /api/public/service-form/:token/submit
// Body: { values: { [fieldName]: string } }
router.post('/service-form/:token/submit', publicServiceFormController.submitServiceForm);

// GET /api/public/service-form/:token/vehicle-options
// Same shape as GET /api/business/vehicle-options, scoped by token — lets
// the public page render icon_select fields with real vehicle photos.
router.get('/service-form/:token/vehicle-options', publicServiceFormController.getVehicleOptions);

module.exports = router;
