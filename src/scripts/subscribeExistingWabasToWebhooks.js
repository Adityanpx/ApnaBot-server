// src/scripts/subscribeExistingWabasToWebhooks.js
//
// Backfill script: subscribes the app to webhook events for every business's
// WABA via POST /{waba-id}/subscribed_apps. This call is required per-WABA,
// separate from the app-level webhook config in the Meta App Dashboard, and
// connectWhatsapp did not make it before this fix - so any business that
// connected earlier shows "Connected" in the app but never receives inbound
// webhook events from Meta. Run once to fix existing connections; new
// connections are subscribed automatically going forward.
//
// Usage:
//   node src/scripts/subscribeExistingWabasToWebhooks.js
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY (see src/config/env.js).

require('dotenv').config();
const axios = require('axios');
const supabase = require('../config/supabase');
const { decrypt } = require('../utils/crypto');
const { META_API_BASE } = require('../services/whatsapp.service');

async function main() {
  const { data: businesses, error } = await supabase
    .from('businesses')
    .select('id, name, waba_id, access_token')
    .not('waba_id', 'is', null)
    .not('access_token', 'is', null);

  if (error) throw error;

  if (!businesses || businesses.length === 0) {
    console.log('No businesses with a connected WABA found.');
    process.exit(0);
  }

  console.log(`Found ${businesses.length} business(es) with a connected WABA.\n`);

  let succeeded = 0;
  let failed = 0;

  for (const business of businesses) {
    try {
      const accessToken = decrypt(business.access_token);

      await axios.post(`${META_API_BASE}/${business.waba_id}/subscribed_apps`, null, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      console.log(`OK   business=${business.id} (${business.name}) wabaId=${business.waba_id}`);
      succeeded++;
    } catch (err) {
      console.error(`FAIL business=${business.id} (${business.name}) wabaId=${business.waba_id}:`, err.response?.data || err.message);
      failed++;
    }
  }

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed out of ${businesses.length} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
