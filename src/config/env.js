require('dotenv').config();
const { resolveGraphApiVersion } = require('./graphApiVersion');

const requiredEnvVars = [
  'PORT',
  'NODE_ENV',
  'REDIS_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_EXPIRY',
  'JWT_REFRESH_EXPIRY',
  'ENCRYPTION_KEY',
  'META_APP_SECRET',
  'META_APP_ID',
  'META_CONFIG_ID',
  'WEBHOOK_VERIFY_TOKEN',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_ENDPOINT',
  'R2_PUBLIC_URL',
  'FRONTEND_URL',
  'ADMIN_URL'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

module.exports = {
  PORT: process.env.PORT,
  NODE_ENV: process.env.NODE_ENV,
  REDIS_URL: process.env.REDIS_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_EXPIRY: process.env.JWT_EXPIRY,
  JWT_REFRESH_EXPIRY: process.env.JWT_REFRESH_EXPIRY,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_APP_ID: process.env.META_APP_ID,
  META_CONFIG_ID: process.env.META_CONFIG_ID,
  // Meta Graph API version for every server call (default + rollback notes
  // in graphApiVersion.js). Throws at boot if malformed.
  GRAPH_API_VERSION: resolveGraphApiVersion(process.env.GRAPH_API_VERSION),
  WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  FRONTEND_URL: process.env.FRONTEND_URL,
  ADMIN_URL: process.env.ADMIN_URL,
  // Optional: where the Help Center lives, returned by GET /api/public/app-config.
  // Defaults to `${FRONTEND_URL}/help` (see help.controller.js).
  HELP_BASE_URL: process.env.HELP_BASE_URL,
  // Comma-separated list, e.g. "http://localhost:3000,https://apnabot.averixsolutions.co.in"
  WEB_APP_URLS: (process.env.WEB_APP_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Optional: only needed by shops with enableDistanceFares on; read directly
  // from process.env in distanceMatrix.service.js, exported here for consistency.
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  // Optional: a WhatsApp Business number ApnaBot itself owns, used only for
  // system-to-owner notifications (autopay grace/paused nudges) — distinct
  // from any business's own connected WABA number. Not required at boot:
  // until this is set up in Meta, subscriptionNotifications.service.js logs
  // and skips sending rather than blocking server startup.
  PLATFORM_WHATSAPP_PHONE_NUMBER_ID: process.env.PLATFORM_WHATSAPP_PHONE_NUMBER_ID,
  PLATFORM_WHATSAPP_ACCESS_TOKEN: process.env.PLATFORM_WHATSAPP_ACCESS_TOKEN,
  // BullMQ key prefix for the whatsapp-outbound/broadcast-outbound queues.
  // Defaults to NODE_ENV so a local dev run can never join the same queue as
  // production even if REDIS_URL is accidentally pointed at the same Redis
  // instance. Override with QUEUE_NAMESPACE if two non-prod environments
  // (e.g. two developers, or staging + prod both set to NODE_ENV=production)
  // need to be kept apart too.
  QUEUE_NAMESPACE: process.env.QUEUE_NAMESPACE || process.env.NODE_ENV,
  // Wallet billing is off while Averix is a Meta Tech Provider - clients pay
  // Meta directly for message costs, so debiting an internal wallet nobody
  // can see or top up just breaks broadcasts once balance hits zero. Flip
  // WALLET_BILLING_ENABLED=true once we're a Solution Partner and start
  // invoicing clients directly.
  WALLET_BILLING_ENABLED: process.env.WALLET_BILLING_ENABLED === 'true',
  // Coexistence onboarding data syncs (smb_app_data contacts + history). Meta
  // allows each ONCE per number, within 24h of onboarding, and the data comes
  // back by webhook - so leave this off until the smb_app_state_sync / history
  // webhook handlers are deployed, or the one-time sync is spent and lost.
  COEXISTENCE_SYNC_ENABLED: process.env.COEXISTENCE_SYNC_ENABLED === 'true',
  // Pause the bot for a customer when the owner replies from the WhatsApp
  // Business app (an smb_message_echoes webhook), the way a dashboard reply
  // does. Off by default: needs the echoes webhook field subscribed, and the
  // first real echoes checked in the logs (see coexistence.service.js).
  ECHO_AUTO_PAUSE: process.env.ECHO_AUTO_PAUSE === 'true',
  // AI flow generation, Phase 1 (questionnaire/FlowSpec -> graph, no LLM).
  // Off by default: /api/flow-graph/ai is only mounted when this is 'true'
  // (see app.js), so the whole feature switches off in one place without
  // touching any existing route.
  ENABLE_AI_FLOW_GEN: process.env.ENABLE_AI_FLOW_GEN === 'true',
  // Follow-up automations sweeper (sends due follow-ups). Off by default and
  // must stay off everywhere except the one production server: unlike the
  // BullMQ queues (kept apart by QUEUE_NAMESPACE), the sweeper reads the
  // database directly, so a local run pointed at the production Supabase
  // would message real customers. Read by server.js (the 15-min sweep);
  // scripts/runFollowupSweep.js is a manual run and doesn't need it.
  ENABLE_FOLLOWUP_SWEEPER: process.env.ENABLE_FOLLOWUP_SWEEPER === 'true',
  // Storage cleanup sweeper (purges marked R2 files after their 24h pending
  // window, and creates the daily automatic chat-media retention run). Off by
  // default and must stay off everywhere except the one production server:
  // like the follow-up sweeper it reads the production database directly, and it
  // DELETES files. Read by server.js; scripts/storageCleanup.js is a manual run.
  ENABLE_STORAGE_SWEEPER: process.env.ENABLE_STORAGE_SWEEPER === 'true',
  // (Bot Builder + Courses are switched per category from Super Admin —
  // category_features — not by an environment variable.)
  // Optional: configurable ceiling on recipients per broadcast send. See the
  // comment above MAX_BROADCAST_RECIPIENTS' usage in broadcast.controller.js
  // for why this isn't tied to any real Meta/infra limit.
  MAX_BROADCAST_RECIPIENTS: parseInt(process.env.MAX_BROADCAST_RECIPIENTS || '2000', 10)
};

