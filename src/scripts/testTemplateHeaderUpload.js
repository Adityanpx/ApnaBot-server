// src/scripts/testTemplateHeaderUpload.js
//
// Proves the media-header path against real Meta, once: the resumable upload
// (/{app_id}/uploads -> upload -> header_handle, authorised with the BUSINESS's
// access token) and a template create that uses the handle. It runs the same
// code as a real submit (services/templateSubmit.service.js) on a throwaway
// template, "apnabot_header_test" (UTILITY, en_US, image header, body
// "Your booking {{1}} is confirmed.", sample "SG1042").
//
// Default is a DRY RUN: reads the business and the media row, prints what it
// would send, calls Meta for nothing. --confirm uploads the image and creates
// the template on the business's WABA, then prints Meta's response. Nothing is
// written to our database; the next template sync will list the test template
// (it stays on the WABA, pending / approved, until deleted in WhatsApp Manager).
//
// Usage:
//   node src/scripts/testTemplateHeaderUpload.js --business <businessId> --media <business_media id>
//   node src/scripts/testTemplateHeaderUpload.js --business <businessId> --media <business_media id> --confirm
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_ID (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const config = require('../config/env');
const businessService = require('../services/business.service');
const { META_API_BASE } = require('../services/whatsapp.service');
const { decrypt } = require('../utils/crypto');
const { uploadHeaderHandle } = require('../services/templateSubmit.service');
const { validateHeaderMedia } = require('../utils/templateValidation');
const { buildMetaCreatePayload } = require('../utils/templateBuild');
const axios = require('axios');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};

const TEST_TEMPLATE = {
  name: 'apnabot_header_test',
  category: 'UTILITY',
  language: 'en_US',
  meta_components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Your booking {{1}} is confirmed.', example: { body_text: [['SG1042']] } }
  ]
};

async function main() {
  const businessId = argValue('--business');
  const mediaId = argValue('--media');
  const confirm = process.argv.includes('--confirm');
  if (!businessId || !mediaId) {
    console.error('Usage: node src/scripts/testTemplateHeaderUpload.js --business <businessId> --media <business_media id> [--confirm]');
    process.exit(1);
  }

  const business = await businessService.getBusinessById(businessId);
  if (!business) {
    console.error(`No business with id ${businessId}`);
    process.exit(1);
  }
  console.log(`Business: ${business.name} (${business.id}) category=${business.businessCategory} wabaId=${business.wabaId}`);
  if (!business.wabaId || !business.accessToken) {
    console.error('This business is not connected to WhatsApp (no wabaId / access token).');
    process.exit(1);
  }

  const { data: media, error } = await supabase
    .from('business_media').select('*').eq('id', mediaId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!media) {
    console.error(`No business_media ${mediaId} for this business`);
    process.exit(1);
  }
  const mediaError = validateHeaderMedia(media, 'IMAGE');
  console.log(`Media: ${media.url} type=${media.media_type} size=${media.file_size_bytes} bytes`);
  if (mediaError) {
    console.error(`Not usable as an image header: ${mediaError}`);
    process.exit(1);
  }

  console.log(confirm ? 'Mode: --confirm (CALLING META)\n' : 'Mode: dry run (nothing is sent to Meta; pass --confirm to run it)\n');
  console.log('Would do, in order:');
  console.log(`  1. GET ${media.url} (download the image)`);
  console.log(`  2. POST ${META_API_BASE}/${config.META_APP_ID}/uploads?file_length=<bytes>&file_type=<mime>   [business access token]`);
  console.log('  3. POST <upload session id>   (file bytes, Authorization: OAuth <business access token>, file_offset: 0) -> header_handle');
  console.log(`  4. POST ${META_API_BASE}/${business.wabaId}/message_templates   [business access token] with:`);
  console.log(JSON.stringify(buildMetaCreatePayload(TEST_TEMPLATE, { headerHandle: '<header_handle from step 3>' }), null, 2));
  if (!confirm) process.exit(0);

  const accessToken = decrypt(business.accessToken);
  const handle = await uploadHeaderHandle({ url: media.url, accessToken });
  console.log(`\nUpload OK. header_handle: ${handle.slice(0, 40)}... (${handle.length} chars)`);

  const response = await axios.post(
    `${META_API_BASE}/${business.wabaId}/message_templates`,
    buildMetaCreatePayload(TEST_TEMPLATE, { headerHandle: handle }),
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  console.log('\nMeta create response:', JSON.stringify(response.data, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err.response ? { status: err.response.status, data: err.response.data } : err.isAxiosError ? err.message : err); // never dump an axios error: its config holds the access token
  process.exit(1);
});
