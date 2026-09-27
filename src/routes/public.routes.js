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

// POST /api/public/service-form/:token/places-autocomplete
// Body: { input: string }. Proxies Google Places Autocomplete — never
// exposes GOOGLE_MAPS_API_KEY to the browser.
router.post('/service-form/:token/places-autocomplete', publicServiceFormController.placesAutocomplete);

// POST /api/public/service-form/:token/place-details
// Body: { placeId: string }. Proxies Google Place Details, reshaped to
// { lat, lng, city, state, formattedAddress }.
router.post('/service-form/:token/place-details', publicServiceFormController.placeDetails);

// POST /api/public/service-form/:token/vehicle-quote
// Body: { pickupLat, pickupLng, dropLat, dropLng }. Distinct from
// vehicle-options above (no distance context) — powers the public page's
// carousel-with-rate once an address_autocomplete pickup/drop is picked.
router.post('/service-form/:token/vehicle-quote', publicServiceFormController.getVehicleQuote);

// GET /api/public/upi-pay?pa=&pn=&am=&cu=&tn=
// Tappable https landing page for a UPI payment. WhatsApp doesn't linkify
// upi:// URLs, so payment.controller.js#sendToCustomer sends this page's URL
// instead; its button opens the customer's UPI app with the same params.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

router.get('/upi-pay', (req, res) => {
  const { pa, pn, am, cu = 'INR', tn = 'Payment' } = req.query;
  if (typeof pa !== 'string' || !/^[\w.\-]{2,256}@[a-zA-Z][\w.\-]{1,64}$/.test(pa) ||
      typeof pn !== 'string' || !pn.trim() ||
      !(Number(am) > 0) || cu !== 'INR') {
    return res.status(400).send('Invalid payment link');
  }
  const amount = Number(am).toFixed(2);
  const upiLink = `upi://pay?${new URLSearchParams({ pa, pn, am: amount, cu, tn: String(tn) })}`;

  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay ${escapeHtml(pn)}</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#f4f4f5;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:16px;padding:28px 24px;margin:16px;max-width:360px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .amt{font-size:36px;font-weight:700;margin:8px 0 4px}
  .to{color:#52525b;margin-bottom:4px}.vpa{color:#71717a;font-size:14px;margin-bottom:24px;word-break:break-all}
  a.btn{display:block;background:#e9b64b;color:#18181b;text-decoration:none;font-weight:600;padding:14px;border-radius:12px;font-size:17px}
  .hint{color:#71717a;font-size:13px;margin-top:16px}
</style></head><body><div class="card">
  <div class="to">Pay to ${escapeHtml(pn)}</div>
  <div class="amt">&#8377;${escapeHtml(amount)}</div>
  <div class="vpa">UPI ID: ${escapeHtml(pa)}</div>
  <a class="btn" href="${escapeHtml(upiLink)}">Pay with UPI app</a>
  <div class="hint">Opens GPay, PhonePe, Paytm or any UPI app on this phone.
  If it doesn't open, pay manually to the UPI ID above.</div>
</div></body></html>`);
});

module.exports = router;
