const Razorpay = require('razorpay');
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
const logger = require('../utils/logger');

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: config.RAZORPAY_KEY_ID,
  key_secret: config.RAZORPAY_KEY_SECRET
});

/**
 * Create a Razorpay payment link for a booking
 * @param {string} bookingId - The booking ID
 * @param {number} amount - Amount in paise
 * @param {string} customerName - Customer name
 * @param {string} customerPhone - Customer phone number
 * @param {string} description - Payment description
 * @returns {Promise<Object>} Payment link details
 */
const createRazorpayPaymentLink = async (bookingId, amount, customerName, customerPhone, description) => {
  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(amount), // Amount in paise
      currency: 'INR',
      description: description || 'Payment for booking',
      customer: {
        name: customerName,
        contact: customerPhone
      },
      notify: {
        sms: true,
        email: true
      },
      callback_url: `${config.FRONTEND_URL}/payment/callback?bookingId=${bookingId}`,
      callback_method: 'get'
    });

    if (bookingId) {
      const { error } = await supabase.from('bookings').update({
        payment_link: paymentLink.short_url,
        payment_id: paymentLink.id,
        payment_status: 'pending'
      }).eq('id', bookingId);
      if (error) throw error;
    }

    logger.info('Payment link created:', paymentLink.id);
    return paymentLink;
  } catch (error) {
    logger.error('Error creating Razorpay payment link:', error);
    throw error;
  }
};

/**
 * Generate a UPI payment link
 * @param {string} bookingId - The booking ID
 * @param {number} amount - Amount in rupees
 * @param {string} vpa - Virtual Payment Address (UPI ID)
 * @param {string} payeeName - Payee name
 * @returns {Object} UPI payment link details
 */
const generateUPILink = async (bookingId, amount, vpa, payeeName) => {
  try {
    // Encode parameters for UPI deep link
    const upiParams = new URLSearchParams({
      pa: vpa,
      pn: payeeName,
      am: amount.toString(),
      tn: bookingId ? `Payment for booking ${bookingId}` : 'Payment'
    });

    // Generate UPI payment link
    const upiLink = `upi://pay?${upiParams.toString()}`;

    if (bookingId) {
      const { error } = await supabase.from('bookings').update({
        upi_link: upiLink,
        payment_status: 'pending'
      }).eq('id', bookingId);
      if (error) throw error;
    }

    logger.info('UPI link generated for booking:', bookingId);
    return {
      upiLink,
      vpa,
      amount,
      payeeName
    };
  } catch (error) {
    logger.error('Error generating UPI link:', error);
    throw error;
  }
};

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

    switch (eventType) {
      case 'payment_link.paid':
        await handlePaymentLinkPaid(payload);
        break;
      case 'payment_link.expired':
        await handlePaymentLinkExpired(payload);
        break;
      case 'payment_link.closed':
        await handlePaymentLinkClosed(payload);
        break;
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
 * payments for one-time orders/payment-links are handled client-side /
 * via their own payment_link.* events, not here.
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
 * Handle payment link paid event
 */
const handlePaymentLinkPaid = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const { data: booking, error } = await supabase
    .from('bookings').select('id, business_id, customer_id, customer_number, booking_code')
    .eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    // Auto-confirm on payment — a deliberate choice (not an oversight): an
    // advance-payment booking has no other "confirmed" trigger today, so
    // without this it would sit at status='pending' forever even once paid.
    // Revisit if a business ever wants a manual confirm-after-payment step.
    const { error: updateErr } = await supabase.from('bookings').update({
      status: 'confirmed',
      payment_status: 'paid',
      payment_details: {
        paymentId: paymentLinkId,
        amount: paymentLink.amount / 100, // Convert from paise
        paidAt: new Date(),
        status: 'completed'
      }
    }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    // Contacted->Converted trigger (see customerPipeline.service.js) — the
    // other place a booking can reach 'confirmed'/'completed', alongside
    // booking.controller.js#updateBookingStatus.
    await customerPipelineService.advancePipelineStage(booking.customer_id, 'converted');

    logger.info('Payment completed for booking:', booking.id);

    try {
      socketService.emitToBusiness(booking.business_id.toString(), 'booking_updated', {
        bookingId: booking.id,
        status: 'confirmed'
      });
    } catch (socketError) {
      logger.error('Error emitting booking_updated socket event:', socketError);
    }

    try {
      const business = await businessService.getBusinessById(booking.business_id);
      if (!business) {
        logger.error('Cannot send advance-paid confirmation: business not found', { businessId: booking.business_id, bookingId: booking.id });
        return;
      }

      const { data: customerRow, error: customerErr } = await supabase
        .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
      if (customerErr) throw customerErr;

      const confirmationText = `✅ Advance received! Your booking ${booking.booking_code} is confirmed. Our team will contact you shortly.`;

      const { data: messageRow, error: msgErr } = await supabase.from('messages').insert({
        business_id: booking.business_id,
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
        businessId: booking.business_id,
        phoneNumberId: business.phoneNumberId,
        encryptedAccessToken: business.accessToken,
        to: booking.customer_number,
        message: confirmationText,
        type: 'text',
        messageId: message.id
      });

      usageService.incrementUsage(booking.business_id, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );

      try {
        socketService.emitToBusiness(booking.business_id.toString(), 'new_message', {
          customer: toCamelCase(customerRow),
          message,
          customerNumber: booking.customer_number
        });
      } catch (socketError) {
        logger.error('Error emitting new_message socket event:', socketError);
      }
    } catch (sendError) {
      logger.error('Error sending advance-paid WhatsApp confirmation:', sendError);
    }
  }
};

/**
 * Handle payment link expired event
 *
 * bookings.payment_status only supports pending/paid/not_required (no
 * dedicated "expired" state), so this reverts to 'pending' — the business
 * can issue a new link.
 */
const handlePaymentLinkExpired = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const { data: booking, error } = await supabase
    .from('bookings').select('id').eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    const { error: updateErr } = await supabase.from('bookings')
      .update({ payment_status: 'pending' }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    logger.info('Payment expired for booking:', booking.id);
  }
};

/**
 * Handle payment link closed event
 *
 * Same payment_status limitation as handlePaymentLinkExpired — reverts to
 * 'pending' rather than a dedicated "cancelled" state.
 */
const handlePaymentLinkClosed = async (payload) => {
  const paymentLink = payload.payment_link;
  const paymentLinkId = paymentLink.id;

  const { data: booking, error } = await supabase
    .from('bookings').select('id').eq('payment_id', paymentLinkId).maybeSingle();
  if (error) throw error;

  if (booking) {
    const { error: updateErr } = await supabase.from('bookings')
      .update({ payment_status: 'pending' }).eq('id', booking.id);
    if (updateErr) throw updateErr;

    logger.info('Payment cancelled for booking:', booking.id);
  }
};

module.exports = {
  createRazorpayPaymentLink,
  generateUPILink,
  verifyRazorpayWebhookSignature,
  handleRazorpayWebhook
};
