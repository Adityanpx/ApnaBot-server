const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const paymentService = require('../services/payment.service');
const socketService = require('../services/socket.service');

/**
 * Create Razorpay payment link for a booking
 * POST /api/payments/create-razorpay-link
 */
const createRazorpayLink = async (req, res, next) => {
  try {
    const { bookingId, amount, description } = req.body;
    const businessId = req.user.businessId;

    if (!amount) {
      return errorResponse(res, 400, 'Amount is required');
    }

    let customer = null;
    if (bookingId && bookingId.trim() !== '') {
      const { data: booking, error: bookingErr } = await supabase
        .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
      if (bookingErr) throw bookingErr;
      if (!booking) {
        return errorResponse(res, 404, 'Booking not found');
      }

      const { data: customerRow, error: custErr } = await supabase
        .from('customers').select('*').eq('id', booking.customer_id).maybeSingle();
      if (custErr) throw custErr;
      if (!customerRow) {
        return errorResponse(res, 404, 'Customer not found');
      }
      customer = toCamelCase(customerRow);
    }

    const paymentLink = await paymentService.createRazorpayPaymentLink(
      bookingId || null,
      amount * 100, // Convert to paise
      customer?.name || 'Customer',
      customer?.whatsappNumber || '',
      description || 'Payment for booking'
    );

    socketService.emitToBusiness(businessId, 'payment_link_created', {
      bookingId,
      paymentLink: paymentLink.short_url
    });

    logger.info('Payment link created for booking:', bookingId);

    return successResponse(res, 200, {
      paymentLink: paymentLink.short_url,
      paymentId: paymentLink.id,
      bookingId
    }, 'Payment link created successfully');
  } catch (error) {
    logger.error('Error creating Razorpay payment link:', error);
    next(error);
  }
};

/**
 * Create UPI payment link for a booking
 * POST /api/payments/create-upi-link
 */
const createUPILink = async (req, res, next) => {
  try {
    const { bookingId, amount, vpa, payeeName } = req.body;
    const businessId = req.user.businessId;

    if (!amount || !vpa || !payeeName) {
      return errorResponse(res, 400, 'Amount, VPA, and payee name are required');
    }

    if (bookingId && bookingId.trim() !== '') {
      const { data: booking, error: bookingErr } = await supabase
        .from('bookings').select('id').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
      if (bookingErr) throw bookingErr;
      if (!booking) {
        return errorResponse(res, 404, 'Booking not found');
      }
    }

    const upiDetails = await paymentService.generateUPILink(bookingId, amount, vpa, payeeName);

    socketService.emitToBusiness(businessId, 'upi_link_created', {
      bookingId,
      upiLink: upiDetails.upiLink
    });

    logger.info('UPI link generated for booking:', bookingId);

    return successResponse(res, 200, {
      upiLink: upiDetails.upiLink,
      vpa: upiDetails.vpa,
      amount: upiDetails.amount,
      payeeName: upiDetails.payeeName,
      bookingId
    }, 'UPI link generated successfully');
  } catch (error) {
    logger.error('Error generating UPI link:', error);
    next(error);
  }
};

/**
 * Send payment link to customer via WhatsApp
 * POST /api/payments/send-to-customer
 */
const sendToCustomer = async (req, res, next) => {
  try {
    const { bookingId, paymentLink } = req.body;
    const businessId = req.user.businessId;

    if (!paymentLink) {
      return errorResponse(res, 400, 'Payment link is required');
    }
    if (!bookingId && !req.body.customerPhone) {
      return errorResponse(res, 400, 'Either Booking ID or customer phone number is required');
    }

    let customerPhone = req.body.customerPhone;
    if (bookingId && bookingId.trim() !== '') {
      const { data: booking, error: bookingErr } = await supabase
        .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
      if (bookingErr) throw bookingErr;
      if (!booking) {
        return errorResponse(res, 404, 'Booking not found');
      }
      const { data: customer, error: custErr } = await supabase
        .from('customers').select('whatsapp_number').eq('id', booking.customer_id).maybeSingle();
      if (custErr) throw custErr;
      if (!customer) {
        return errorResponse(res, 404, 'Customer not found');
      }
      customerPhone = customer.whatsapp_number;
    }
    if (!customerPhone) {
      return errorResponse(res, 400, 'Could not determine customer phone number');
    }

    // Load business to get WhatsApp credentials — REQUIRED for queue
    const businessService = require('../services/business.service');
    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.isWhatsappConnected || !business.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this business');
    }

    const { addToWhatsappQueue } = require('../queues/whatsapp.queue');

    // WhatsApp doesn't make upi:// tappable — send the https landing page
    // (public.routes.js /upi-pay) carrying the same params instead.
    const sendLink = paymentLink.startsWith('upi://pay?')
      ? `${req.protocol}://${req.get('host')}/api/public/upi-pay?${paymentLink.slice('upi://pay?'.length)}`
      : paymentLink;

    const message = `Your payment link: ${sendLink}\n\nPlease complete your payment to confirm your booking.`;

    // Queue with all required fields including business WhatsApp credentials
    await addToWhatsappQueue({
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: customerPhone,
      message,
      type: 'text'
    });

    logger.info('Payment link queued to customer:', customerPhone);

    return successResponse(res, 200, null, 'Payment link sent to customer successfully');
  } catch (error) {
    logger.error('Error sending payment link to customer:', error);
    next(error);
  }
};

/**
 * Get payment history for a business
 * GET /api/payments/history
 */
const getPaymentHistory = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { page = 1, limit = 20, status, startDate, endDate } = req.query;

    let query = supabase.from('bookings').select('*, customer:customers(name, whatsapp_number)', { count: 'exact' })
      .eq('business_id', businessId);

    query = status ? query.eq('payment_status', status) : query.neq('payment_status', 'not_required');

    if (startDate) query = query.gte('created_at', new Date(startDate).toISOString());
    if (endDate) query = query.lte('created_at', new Date(endDate).toISOString());

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    const { data, error, count } = await query.order('created_at', { ascending: false }).range(from, to);
    if (error) throw error;

    const bookings = (data || []).map(toCamelCase);

    return successResponse(res, 200, {
      bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        pages: Math.ceil((count || 0) / limitNum)
      }
    }, 'Payment history retrieved successfully');
  } catch (error) {
    logger.error('Error getting payment history:', error);
    next(error);
  }
};

/**
 * Handle Razorpay webhook
 * POST /api/payments/webhook
 */
const razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const payload = JSON.stringify(req.body);

    const isValid = paymentService.verifyRazorpayWebhookSignature(payload, signature);

    if (!isValid) {
      logger.warn('Invalid Razorpay webhook signature');
      return errorResponse(res, 400, 'Invalid signature');
    }

    // Razorpay's unique-per-delivery id is sent as a header, NOT a body
    // field (the JSON payload has no top-level "id") — used downstream for
    // webhook_events idempotency on the subscription/autopay event types.
    const eventId = req.headers['x-razorpay-event-id'];

    await paymentService.handleRazorpayWebhook(req.body, eventId);

    return successResponse(res, 200, 'Webhook processed successfully');
  } catch (error) {
    logger.error('Error processing Razorpay webhook:', error);
    next(error);
  }
};

/**
 * Get payment status for a booking
 * GET /api/payments/status/:bookingId
 */
const getPaymentStatus = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const businessId = req.user.businessId;

    const { data: booking, error } = await supabase
      .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    const paymentStatus = {
      bookingId: booking.id,
      paymentStatus: booking.payment_status,
      paymentAmount: booking.payment_amount,
      paymentLink: booking.payment_link,
      upiLink: booking.upi_link,
      paymentId: booking.payment_id,
      paymentDetails: booking.payment_details
    };

    return successResponse(res, 200, paymentStatus, 'Payment status retrieved successfully');
  } catch (error) {
    logger.error('Error getting payment status:', error);
    next(error);
  }
};

module.exports = {
  createRazorpayLink,
  createUPILink,
  sendToCustomer,
  getPaymentHistory,
  razorpayWebhook,
  getPaymentStatus
};
