const config = require('../config/env');
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const subscriptionService = require('./subscription.service');
const tenantService = require('./tenant.service');
const subscriptionNotifications = require('./subscriptionNotifications.service');
const customerPipelineService = require('./customerPipeline.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { toCamelCase } = require('../utils/caseConvert');
const { getSystemMessage } = require('../utils/systemMessages');
const logger = require('../utils/logger');

/**
 * Verify Razorpay webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - Razorpay signature header
 * @returns {boolean} True if signature is valid
 */
const verifyRazorpayWebhookSignature = (payload, signature) => {
  try {
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', config.RAZORPAY_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    return expectedSignature === signature;
  } catch (error) {
    logger.error('Error verifying webhook signature:', error);
    return false;
  }
};

/**
 * Handle Razorpay webhook events
 * @param {Object} event - Razorpay webhook event (parsed JSON body)
 * @param {string} [eventId] - Razorpay's x-razorpay-event-id header value,
 *   used for webhook_events idempotency on the subscription/autopay events.
 */
const handleRazorpayWebhook = async (event, eventId) => {
  try {
    const { event: eventType, payload } = event;

    // Razorpay is used only for ApnaBot's own subscriptions (and wallet top-ups, when WALLET_BILLING_ENABLED) now —
    // businesses' customers pay by QR (see setBookingPaymentStatus below), so
    // no payment_link.* events are expected.
    switch (eventType) {
      case 'subscription.activated':
        await handleSubscriptionActivated(payload, eventId);
        break;
      case 'subscription.charged':
        await handleSubscriptionCharged(payload, eventId);
        break;
      case 'subscription.completed':
        await handleSubscriptionCompleted(payload, eventId);
        break;
      case 'subscription.halted':
        await handleSubscriptionHalted(payload, eventId);
        break;
      case 'subscription.cancelled':
        await handleSubscriptionCancelled(payload, eventId);
        break;
      case 'payment.failed':
        await handlePaymentFailed(payload, eventId);
        break;
      default:
        logger.info('Unhandled Razorpay event:', eventType);
    }
  } catch (error) {
    logger.error('Error handling Razorpay webhook:', error);
    throw error;
  }
};

/**
 * Returns true if this event has already been processed and should be skipped.
 * Insert-if-absent pattern using the primary key uniqueness — one round-trip,
 * no race condition. If two webhook deliveries arrive concurrently, the
 * second gets a 23505 (unique_violation) and returns true.
 */
const markEventProcessedOrSkip = async (eventId, eventType) => {
  if (!eventId) {
    logger.warn(`Webhook event ${eventType} missing event id — cannot dedupe, processing anyway`);
    return false;
  }
  const { error } = await supabase
    .from('webhook_events')
    .insert({ event_id: eventId, event_type: eventType });
  if (error) {
    if (error.code === '23505') {   // unique_violation — already processed
      logger.info(`Webhook ${eventType} ${eventId} already processed, skipping`);
      return true;
    }
    throw error;
  }
  return false;
};

/**
 * subscription.activated — fires once, the first time the mandate is
 * successfully charged. Flips the DB row from its 'active'-placeholder /
 * 'pending_start' state to a real 'active' with the correct end_date.
 */
const handleSubscriptionActivated = async (payload, eventId) => {
  if (await markEventProcessedOrSkip(eventId, 'subscription.activated')) return;

  const rzpSub = payload.subscription.entity;
  const currentEnd = new Date(rzpSub.current_end * 1000);

  const { data: dbSub, error } = await supabase
    .from('subscriptions')
    .update({ status: 'active', end_date: currentEnd.toISOString() })
    .eq('razorpay_subscription_id', rzpSub.id)
    .select('business_id, id')
    .maybeSingle();
  if (error) throw error;
  if (!dbSub) {
    logger.warn(`subscription.activated for unknown razorpay sub ${rzpSub.id}`);
    return;
  }

  // Ensure business is active (activation of an upgrade from paused should re-enable)
  const { data: business, error: bizErr } = await supabase
    .from('businesses').update({ is_active: true })
    .eq('id', dbSub.business_id).select('phone_number_id').maybeSingle();
  if (bizErr) throw bizErr;

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);
  if (business?.phone_number_id) {
    try {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    } catch (cacheErr) {
      logger.error(`Error invalidating tenant cache for business ${dbSub.business_id}:`, cacheErr);
    }
  }

  logger.info(`Subscription activated: rzp=${rzpSub.id}, business=${dbSub.business_id}`);
};

/**
 * subscription.charged — fires on every successful monthly debit after
 * activation. Extends end_date to the new cycle boundary and clears any
 * past_due grace state, since a successful charge means the customer is
 * caught up.
 */
const handleSubscriptionCharged = async (payload, eventId) => {
  if (await markEventProcessedOrSkip(eventId, 'subscription.charged')) return;

  const rzpSub = payload.subscription.entity;
  const currentEnd = new Date(rzpSub.current_end * 1000);

  const { data: dbSub, error } = await supabase
    .from('subscriptions').select('*')
    .eq('razorpay_subscription_id', rzpSub.id).maybeSingle();
  if (error) throw error;
  if (!dbSub) {
    logger.warn(`subscription.charged for unknown razorpay sub ${rzpSub.id}`);
    return;
  }

  const { error: subErr } = await supabase.from('subscriptions').update({
    status: 'active',
    end_date: currentEnd.toISOString(),
    grace_until: null
  }).eq('id', dbSub.id);
  if (subErr) throw subErr;

  // If business had been auto-deactivated (grace expired), re-activate.
  const { data: business, error: bizErr } = await supabase
    .from('businesses').update({ is_active: true }).eq('id', dbSub.business_id)
    .select('phone_number_id').maybeSingle();
  if (bizErr) throw bizErr;

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);
  if (business?.phone_number_id) {
    try {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    } catch (cacheErr) {
      logger.error(`Error invalidating tenant cache for business ${dbSub.business_id}:`, cacheErr);
    }
  }

  logger.info(`Subscription charged: rzp=${rzpSub.id}, business=${dbSub.business_id}, new end_date=${currentEnd.toISOString()}`);
};

/**
 * subscription.completed — fires when total_count cycles have elapsed
 * (~10 years out for our total_count=120), or when a cancel_at_cycle_end
 * cancellation's final cycle finishes. Does not re-enable the business.
 * If this sub had a scheduled upgrade pointing at a pending_start row,
 * flip that row to active as a safety net (its own subscription.activated
 * webhook should also do this — this just guards against ordering issues).
 */
const handleSubscriptionCompleted = async (payload, eventId) => {
  if (await markEventProcessedOrSkip(eventId, 'subscription.completed')) return;

  const rzpSub = payload.subscription.entity;

  const { data: dbSub, error } = await supabase
    .from('subscriptions').select('*')
    .eq('razorpay_subscription_id', rzpSub.id).maybeSingle();
  if (error) throw error;
  if (!dbSub) {
    logger.warn(`subscription.completed for unknown razorpay sub ${rzpSub.id}`);
    return;
  }

  const { error: subErr } = await supabase.from('subscriptions')
    .update({ status: 'expired' }).eq('id', dbSub.id);
  if (subErr) throw subErr;

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);

  if (dbSub.scheduled_change_to) {
    const { error: nextErr } = await supabase.from('subscriptions')
      .update({ status: 'active' })
      .eq('id', dbSub.scheduled_change_to)
      .eq('status', 'pending_start');
    if (nextErr) throw nextErr;
    logger.info(`Scheduled upgrade safety net: flipped ${dbSub.scheduled_change_to} to active after ${dbSub.id} completed`);
  }

  logger.info(`Subscription completed: rzp=${rzpSub.id}, business=${dbSub.business_id}`);
};

/**
 * subscription.halted — Razorpay gave up retrying after repeated charge
 * failures. Mirrors the grace-expired 'paused' state: bot disabled.
 */
const handleSubscriptionHalted = async (payload, eventId) => {
  if (await markEventProcessedOrSkip(eventId, 'subscription.halted')) return;

  const rzpSub = payload.subscription.entity;

  const { data: dbSub, error } = await supabase
    .from('subscriptions').select('*')
    .eq('razorpay_subscription_id', rzpSub.id).maybeSingle();
  if (error) throw error;
  if (!dbSub) {
    logger.warn(`subscription.halted for unknown razorpay sub ${rzpSub.id}`);
    return;
  }

  const { error: subErr } = await supabase.from('subscriptions')
    .update({ status: 'paused' }).eq('id', dbSub.id);
  if (subErr) throw subErr;

  const { data: business, error: bizErr } = await supabase
    .from('businesses').update({ is_active: false }).eq('id', dbSub.business_id)
    .select('phone_number_id').maybeSingle();
  if (bizErr) throw bizErr;

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);
  if (business?.phone_number_id) {
    try {
      await tenantService.invalidateTenantCache(business.phone_number_id);
    } catch (cacheErr) {
      logger.error(`Error invalidating tenant cache for business ${dbSub.business_id}:`, cacheErr);
    }
  }

  logger.info(`Subscription halted (Razorpay gave up retries): rzp=${rzpSub.id}, business=${dbSub.business_id}`);
  await subscriptionNotifications.sendSubscriptionPausedNotice(dbSub.business_id);
};

/**
 * subscription.cancelled — auto_renew was turned off (or Razorpay-side
 * cancel). Does not touch end_date; the existing daily cron moves the row
 * to 'expired' and deactivates the business once end_date passes.
 */
const handleSubscriptionCancelled = async (payload, eventId) => {
  if (await markEventProcessedOrSkip(eventId, 'subscription.cancelled')) return;

  const rzpSub = payload.subscription.entity;

  const { data: dbSub, error } = await supabase
    .from('subscriptions').select('id, business_id')
    .eq('razorpay_subscription_id', rzpSub.id).maybeSingle();
  if (error) throw error;
  if (!dbSub) {
    logger.warn(`subscription.cancelled for unknown razorpay sub ${rzpSub.id}`);
    return;
  }

  const { error: subErr } = await supabase.from('subscriptions')
    .update({ status: 'cancelled' }).eq('id', dbSub.id);
  if (subErr) throw subErr;

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);

  logger.info(`Subscription cancelled: rzp=${rzpSub.id}, business=${dbSub.business_id}`);
};

/**
 * payment.failed — only act if this failed payment is against a
 * subscription (payload.payment.entity.subscription_id present). Failed
 * one-time payments (e.g. wallet top-up orders) are handled client-side,
 * not here.
 */
const handlePaymentFailed = async (payload, eventId) => {
  const payment = payload.payment.entity;
  const rzpSubId = payment.subscription_id;
  if (!rzpSubId) return; // one-time payment failure, not our concern here

  if (await markEventProcessedOrSkip(eventId, 'payment.failed')) return;

  const { data: dbSub, error } = await supabase
    .from('subscriptions').select('*')
    .eq('razorpay_subscription_id', rzpSubId).maybeSingle();
  if (error) throw error;
  if (!dbSub) return;
  if (dbSub.status !== 'active') return;  // already past_due / paused / cancelled — no-op

  const graceUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  const { error: subErr } = await supabase.from('subscriptions').update({
    status: 'past_due',
    grace_until: graceUntil.toISOString()
  }).eq('id', dbSub.id);
  if (subErr) throw subErr;

  // Bot stays on during grace — do NOT flip business.is_active.

  await subscriptionService.invalidateSubscriptionCache(dbSub.business_id);

  logger.info(`Payment failed for subscription ${rzpSubId}, business ${dbSub.business_id} — past_due until ${graceUntil.toISOString()}`);
  await subscriptionNotifications.sendPaymentFailedNudge(dbSub.business_id, graceUntil);
};

/**
 * WhatsApp caption sent with the business's payment QR image — shared by the
 * manual chat send (message.controller.js sendPaymentQr) and the
 * advance-payment booking flow (booking.service.js createBookingAndConfirmation).
 * A customer receiving the QR on the phone they pay from can't scan their own
 * screen, hence the "upload from gallery" hint and the UPI ID fallback.
 * @param {Object} opts
 * @param {number|null} [opts.amount] - rupees; omitted from the text when absent
 * @param {string|null} [opts.bookingCode]
 * @param {string|null} [opts.upiId] - business.upiId, optional
 * @param {string|null} [opts.intro] - replaces the default first line
 * @param {string|null} [opts.languageCode] - the customer's preferred_language (systemMessages.js)
 * @returns {string}
 */
const buildPaymentQrCaption = ({ amount, bookingCode, upiId, intro, languageCode = null } = {}) => {
  const vars = { amount: amount ? Number(amount).toLocaleString('en-IN') : '', code: bookingCode || '' };
  const payKey = amount ? (bookingCode ? 'qrPayAmountCode' : 'qrPayAmount') : (bookingCode ? 'qrPayCode' : 'qrPay');
  const lines = [
    intro || getSystemMessage(payKey, languageCode, vars),
    '',
    getSystemMessage('qrHowTo', languageCode)
  ];
  if (upiId) lines.push('', getSystemMessage('qrUpiId', languageCode, { upiId }));
  lines.push('', getSystemMessage('qrScreenshot', languageCode));
  return lines.join('\n');
};

/**
 * Owner records a booking's payment (PUT /api/bookings/:id/payment) — a QR
 * payment to a personal UPI account can't be detected automatically.
 * Marking an advance-payment booking paid also confirms it and tells the
 * customer, as the removed Razorpay payment_link.paid webhook did; other bookings
 * only change payment_status.
 * @param {string} businessId
 * @param {string} bookingId
 * @param {'paid'|'pending'} status
 * @returns {Promise<Object|null>} the updated camelCase booking, or null if not found
 */
const setBookingPaymentStatus = async (businessId, bookingId, status) => {
  const { data: booking, error } = await supabase
    .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!booking) return null;

  const isAdvance = booking.payment_details?.requestedVia === 'advance';
  const confirmOnPaid = status === 'paid' && isAdvance && booking.status === 'pending';
  // A paid admission fee (Bot Builder Admission form) admits the student:
  // 'completed' = "Admitted" in the coaching request labels.
  const isAdmissionFee = booking.payment_details?.purpose === 'admission';

  const update = {
    payment_status: status,
    payment_details: status === 'paid'
      ? { ...(booking.payment_details || {}), method: 'qr', paidAt: new Date().toISOString() }
      : { ...(booking.payment_details || {}), paidAt: null }
  };
  if (confirmOnPaid) update.status = isAdmissionFee ? 'completed' : 'confirmed';

  const { data: updatedRow, error: updateErr } = await supabase
    .from('bookings').update(update).eq('id', booking.id).select().single();
  if (updateErr) throw updateErr;
  const updated = toCamelCase(updatedRow);

  try {
    socketService.emitToBusiness(businessId.toString(), 'booking_updated', {
      bookingId: booking.id,
      status: updated.status
    });
  } catch (socketError) {
    logger.error('Error emitting booking_updated socket event:', socketError);
  }

  if (!confirmOnPaid) return updated;

  // Contacted->Converted trigger (see customerPipeline.service.js) — the
  // other place a booking can reach 'confirmed'/'completed', alongside
  // booking.controller.js#updateBookingStatus.
  await customerPipelineService.advancePipelineStage(booking.customer_id, 'converted');

  try {
    const business = await businessService.getBusinessById(businessId);
    if (!business?.isWhatsappConnected || !business.phoneNumberId) {
      logger.error('Cannot send advance-paid confirmation: WhatsApp not connected', { businessId, bookingId: booking.id });
      return updated;
    }

    const { data: customerRow, error: customerErr } = await supabase
      .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
    if (customerErr) throw customerErr;

    const confirmationText = getSystemMessage(isAdmissionFee ? 'admissionFeePaid' : 'advancePaid', customerRow?.preferred_language, {
      code: booking.booking_code, business: business.displayName || business.name
    });

    const { data: messageRow, error: msgErr } = await supabase.from('messages').insert({
      business_id: businessId,
      customer_id: booking.customer_id,
      customer_number: booking.customer_number,
      direction: 'outbound',
      type: 'text',
      content: confirmationText,
      status: 'sent',
      sender_type: 'bot',
      is_read: true
    }).select().single();
    if (msgErr) throw msgErr;
    const message = toCamelCase(messageRow);

    await addToWhatsappQueue({
      businessId,
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: booking.customer_number,
      message: confirmationText,
      type: 'text',
      messageId: message.id
    });

    usageService.incrementUsage(businessId, 'outbound').catch(err =>
      logger.error('Error incrementing outbound usage:', err)
    );

    try {
      socketService.emitToBusiness(businessId.toString(), 'new_message', {
        customer: toCamelCase(customerRow),
        message,
        customerNumber: booking.customer_number
      });
    } catch (socketError) {
      logger.error('Error emitting new_message socket event:', socketError);
    }
  } catch (sendError) {
    // Booking is already marked paid + confirmed — a failed WhatsApp send is
    // logged, not surfaced as a failure of the mark-paid request.
    logger.error('Error sending advance-paid WhatsApp confirmation:', sendError);
  }

  return updated;
};

module.exports = {
  verifyRazorpayWebhookSignature,
  handleRazorpayWebhook,
  buildPaymentQrCaption,
  setBookingPaymentStatus
};
