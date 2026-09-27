const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const paymentService = require('../services/payment.service');

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
  getPaymentHistory,
  razorpayWebhook,
  getPaymentStatus
};
