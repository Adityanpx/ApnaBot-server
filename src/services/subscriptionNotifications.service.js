// src/services/subscriptionNotifications.service.js
const supabase = require('../config/supabase');
const config = require('../config/env');
const { encrypt } = require('../utils/crypto');
const whatsappService = require('./whatsapp.service');
const logger = require('../utils/logger');
const notificationService = require('./notification.service');

/**
 * Sends from ApnaBot's own platform WhatsApp number (PLATFORM_WHATSAPP_*)
 * to the business's own registered whatsapp_number — there is no separate
 * "owner phone" field in the schema, so whatsapp_number is the closest
 * available proxy for "the shop owner's registered number". sendTextMessage
 * expects an ENCRYPTED token (it decrypts internally, same as every other
 * caller uses a business's own encrypted access_token column), so the raw
 * platform token from env is encrypted here before each send.
 *
 * Swallows all errors (logs only, never throws) — a failed nudge must
 * never break the webhook handler or the expiry cron that call this.
 */
const sendToOwner = async (businessId, message) => {
  try {
    if (!config.PLATFORM_WHATSAPP_PHONE_NUMBER_ID || !config.PLATFORM_WHATSAPP_ACCESS_TOKEN) {
      logger.warn(`Skipping owner WhatsApp notification for business ${businessId} — PLATFORM_WHATSAPP_* env vars not configured yet`);
      return;
    }

    const { data: business, error } = await supabase
      .from('businesses').select('whatsapp_number').eq('id', businessId).maybeSingle();
    if (error) throw error;
    if (!business?.whatsapp_number) {
      logger.warn(`Skipping owner WhatsApp notification for business ${businessId} — no whatsapp_number on file`);
      return;
    }

    const encryptedPlatformToken = encrypt(config.PLATFORM_WHATSAPP_ACCESS_TOKEN);
    await whatsappService.sendTextMessage(
      config.PLATFORM_WHATSAPP_PHONE_NUMBER_ID,
      encryptedPlatformToken,
      business.whatsapp_number,
      message
    );
  } catch (error) {
    logger.error(`Error sending owner WhatsApp notification for business ${businessId}:`, error);
  }
};

const sendPaymentFailedNudge = async (businessId, graceUntil) => {
  const formattedDate = new Date(graceUntil).toDateString();
  const message = `ApnaBot: your monthly renewal payment failed.\n\n` +
    `Your bot is still working, but it will pause on ${formattedDate} ` +
    `if the payment isn't collected by then. Razorpay will retry automatically. ` +
    `No action needed if you have enough balance now.\n\n` +
    `To pay manually or check status: ${config.FRONTEND_URL}`;
  await sendToOwner(businessId, message);
};

const sendSubscriptionPausedNotice = async (businessId) => {
  const message = `ApnaBot: your subscription is paused because payment couldn't be collected.\n\n` +
    `Your bot has stopped responding to customer messages. To resume, ` +
    `pay this month manually and re-authorize autopay:\n${config.FRONTEND_URL}`;
  await sendToOwner(businessId, message);
};

// ── Mobile push (critical, owner only; notification.service.js) ─────────────
const PLAN_EXPIRING_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pushes "your plan ends in N days" once per subscription. Run by the daily
 * expiry cron. Skips autopay subscriptions (they renew themselves) and
 * businesses that have another active/trial subscription ending later.
 * Swallows all errors (logs only, never throws).
 */
const sendPlanExpiringNotices = async () => {
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + PLAN_EXPIRING_DAYS * DAY_MS);
    const { data: ending, error } = await supabase
      .from('subscriptions').select('id, business_id, end_date')
      .in('status', ['active', 'trial']).eq('is_autopay', false)
      .gt('end_date', now.toISOString()).lte('end_date', horizon.toISOString());
    if (error) throw error;
    if (!ending || ending.length === 0) return;

    const { data: later, error: laterErr } = await supabase
      .from('subscriptions').select('business_id')
      .in('status', ['active', 'trial']).in('business_id', ending.map((s) => s.business_id))
      .gt('end_date', horizon.toISOString());
    if (laterErr) throw laterErr;
    const covered = new Set((later || []).map((s) => s.business_id));

    for (const sub of ending) {
      if (covered.has(sub.business_id)) continue;
      const days = Math.max(1, Math.ceil((new Date(sub.end_date).getTime() - now.getTime()) / DAY_MS));
      await notificationService.notifyOnce(sub.business_id, 'plan_expiring', { days }, sub.id, (PLAN_EXPIRING_DAYS + 1) * 86400);
    }
  } catch (error) {
    logger.error('Error sending plan-expiring push notifications:', error);
  }
};

/** Pushes "your plan expired" once per subscription (fire and forget). */
const sendPlanExpiredNotice = (businessId, subscriptionId) =>
  notificationService.notifyOnce(businessId, 'plan_expired', {}, subscriptionId, 7 * 86400);

module.exports = {
  sendPaymentFailedNudge,
  sendSubscriptionPausedNotice,
  sendPlanExpiringNotices,
  sendPlanExpiredNotice
};
