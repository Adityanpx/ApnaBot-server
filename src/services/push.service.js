// Mobile push (FCM) transport. Knows nothing about ApnaBot's notification types -
// notification.service.js decides who gets what; this only delivers.
//
// Credentials: FIREBASE_SERVICE_ACCOUNT_BASE64 = base64 of the service-account
// JSON. Initialised lazily on the first send. Missing or invalid -> one warning,
// then every send is a no-op. Nothing here throws into a caller, and the
// credential is never logged.
const supabase = require('../config/supabase');
const config = require('../config/env');
const logger = require('../utils/logger');

const BATCH_SIZE = 500; // sendEachForMulticast accepts at most 500 tokens per call
const APP_NAME = 'apnabot-push';
// Token errors that mean the token will never work again: the app was
// uninstalled / reinstalled, or the token string is malformed.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument'
]);

let messaging = null;
let initTried = false;

/** @returns {object|null} the FCM messaging client, or null when push is unavailable */
const getMessagingClient = () => {
  if (initTried) return messaging;
  initTried = true;
  try {
    const encoded = config.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!encoded) {
      logger.warn('Push notifications are off: FIREBASE_SERVICE_ACCOUNT_BASE64 is not set');
      return null;
    }
    const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = initializeApp({ credential: cert(serviceAccount) }, APP_NAME);
    messaging = getMessaging(app);
  } catch (err) {
    // err.message can echo parts of the credential JSON on a parse failure: log only that it failed.
    logger.warn(`Push notifications are off: FIREBASE_SERVICE_ACCOUNT_BASE64 is not a valid service account (${err.name})`);
    messaging = null;
  }
  return messaging;
};

/** Removes tokens FCM said are dead. Failure is logged, never thrown. */
const deleteDeadTokens = async (tokens) => {
  if (tokens.length === 0) return;
  try {
    const { error } = await supabase.from('device_tokens').delete().in('token', tokens);
    if (error) throw error;
    logger.info(`Push: removed ${tokens.length} dead device token(s)`);
  } catch (err) {
    logger.error('Push: could not remove dead device tokens:', err);
  }
};

/**
 * Sends one message to many devices (batches of 500).
 * @param {string[]} tokens FCM registration tokens
 * @param {object} message FCM message without `token`: { notification, android, data, ... }
 * @returns {Promise<{successCount: number, failureCount: number, removedCount: number}>}
 */
const sendToDevices = async (tokens, message) => {
  const result = { successCount: 0, failureCount: 0, removedCount: 0 };
  try {
    const unique = [...new Set((tokens || []).filter(Boolean))];
    if (unique.length === 0) return result;
    const client = getMessagingClient();
    if (!client) return result;

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      try {
        const response = await client.sendEachForMulticast({ ...message, tokens: batch });
        result.successCount += response.successCount;
        result.failureCount += response.failureCount;
        const dead = [];
        response.responses.forEach((r, idx) => {
          if (!r.success && r.error && DEAD_TOKEN_CODES.has(r.error.code)) dead.push(batch[idx]);
        });
        await deleteDeadTokens(dead);
        result.removedCount += dead.length;
      } catch (err) {
        result.failureCount += batch.length;
        logger.error(`Push: sending a batch of ${batch.length} failed:`, err);
      }
    }
  } catch (err) {
    logger.error('Push: sendToDevices failed:', err);
  }
  return result;
};

/** True when push can actually be delivered (callers skip their own lookups when not). */
const isPushEnabled = () => getMessagingClient() !== null;

/** Test hook: forget the cached client so the next send re-reads the environment. */
const resetForTests = () => {
  messaging = null;
  initTried = false;
};

module.exports = { sendToDevices, isPushEnabled, resetForTests };
