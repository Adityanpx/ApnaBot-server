require('dotenv').config();

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
  // MONGODB_URI is no longer read anywhere (MongoDB fully replaced by Supabase).
  // Still needs to be removed from Render's env vars.
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
  // Comma-separated list, e.g. "http://localhost:3000,https://app.apnabot.in"
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
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  // Wallet billing is off while Averix is a Meta Tech Provider - clients pay
  // Meta directly for message costs, so debiting an internal wallet nobody
  // can see or top up just breaks broadcasts once balance hits zero. Flip
  // WALLET_BILLING_ENABLED=true once we're a Solution Partner and start
  // invoicing clients directly.
  WALLET_BILLING_ENABLED: process.env.WALLET_BILLING_ENABLED === 'true',
  // Optional: configurable ceiling on recipients per broadcast send. See the
  // comment above MAX_BROADCAST_RECIPIENTS' usage in broadcast.controller.js
  // for why this isn't tied to any real Meta/infra limit.
  MAX_BROADCAST_RECIPIENTS: parseInt(process.env.MAX_BROADCAST_RECIPIENTS || '2000', 10)
};

