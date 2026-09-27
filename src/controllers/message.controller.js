const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const { addToWhatsappQueue } = require('../queues/whatsapp.queue');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const { withWindowExpiresAt } = require('./customer.controller');
const { INDEFINITE_PAUSE_SENTINEL, isIndefinitePause } = require('../utils/botPause');
const customerPipelineService = require('../services/customerPipeline.service');
const paymentService = require('../services/payment.service');
const logger = require('../utils/logger');

/**
 * GET /api/messages
 * List conversations grouped by customer.
 * Returns latest message per customer + unread count.
 *
 * Every customer row is only ever created alongside a message (webhook
 * upsert, sendMessage upsert below), so "customers with a conversation" and
 * "all customers for this business" are the same set — paginating customers
 * by lastMessageAt stands in for the old Message-grouped aggregation, without
 * needing a Postgres view/RPC for it.
 */
const getConversations = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const { data: customers, error, count } = await supabase
      .from('customers').select('*', { count: 'exact' }).eq('business_id', businessId)
      .order('last_message_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const conversations = await Promise.all((customers || []).map(async (customerRow) => {
      const customer = toCamelCase(customerRow);

      const [{ data: lastMsg }, { count: unreadCount }] = await Promise.all([
        supabase.from('messages').select('content, direction, created_at')
          .eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('messages').select('*', { count: 'exact', head: true })
          .eq('customer_id', customer.id).eq('direction', 'inbound').eq('is_read', false)
      ]);

      return {
        _id: customer.id,
        customerNumber: customer.whatsappNumber,
        lastMessage: lastMsg?.content ?? null,
        lastMessageAt: lastMsg?.created_at ?? customer.lastMessageAt,
        lastDirection: lastMsg?.direction ?? null,
        unreadCount: unreadCount || 0,
        botPausedUntil: customer.botPausedUntil ?? null,
        customer
      };
    }));

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { conversations, pagination });
  } catch (error) {
    logger.error('Error in getConversations:', error);
    next(error);
  }
};

/**
 * GET /api/messages/:customerId
 * Full paginated chat history with a specific customer
 */
const getChatHistory = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    const { data: customerRow, error: custErr } = await supabase
      .from('customers').select('*').eq('id', customerId).eq('business_id', businessId).maybeSingle();
    if (custErr) throw custErr;
    if (!customerRow) return errorResponse(res, 404, 'Customer not found');

    const { data: messages, error, count } = await supabase
      .from('messages').select('*', { count: 'exact' })
      .eq('business_id', businessId).eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);
    return successResponse(res, 200, {
      customer: withWindowExpiresAt(toCamelCase(customerRow)),
      messages: (messages || []).map(toCamelCase).reverse(), // return in chronological order
      pagination
    });
  } catch (error) {
    logger.error('Error in getChatHistory:', error);
    next(error);
  }
};

/**
 * PUT /api/messages/:id/read
 * Mark an inbound message as read
 */
const markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: message, error } = await supabase
      .from('messages').update({ is_read: true })
      .eq('id', id).eq('business_id', businessId).eq('direction', 'inbound')
      .select().maybeSingle();
    if (error) throw error;

    if (!message) return errorResponse(res, 404, 'Message not found');
    return successResponse(res, 200, toCamelCase(message), 'Message marked as read');
  } catch (error) {
    logger.error('Error in markAsRead:', error);
    next(error);
  }
};

const FREE_FORM_WINDOW_MS = 24 * 60 * 60 * 1000; // WhatsApp's 24h customer service window
const BOT_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000; // How long a pause (manual or implied by a staff reply) lasts

/**
 * Shared gate for the manual (human) send paths — sendMessage and
 * sendPaymentQr. Returns { business, customer } or { status, error }.
 */
const loadManualSendTarget = async (businessId, customerNumber) => {
  // Verify business has WhatsApp connected
  const business = await businessService.getBusinessById(businessId);
  if (!business) return { status: 404, error: 'Business not found' };
  if (!business.isWhatsappConnected || !business.phoneNumberId) {
    return { status: 400, error: 'WhatsApp is not connected to this business' };
  }

  const { data: existingCustomer, error: findErr } = await supabase
    .from('customers').select('*').eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
  if (findErr) throw findErr;

  // 24h free-form window is opened/extended only by inbound messages
  // (see upsertCustomerForInboundMessage in webhook.controller.js) — a
  // customer who has never messaged in, or hasn't in 24h, has no open
  // window. These send paths are free-form only (no template branch exists
  // in this controller), so the gate applies unconditionally here.
  const windowExpiresAt = existingCustomer?.last_message_at
    ? new Date(existingCustomer.last_message_at).getTime() + FREE_FORM_WINDOW_MS
    : null;
  if (!windowExpiresAt || Date.now() >= windowExpiresAt) {
    return { status: 400, error: 'The 24-hour free messaging window for this customer has closed. Use a message template to reach them, or wait for them to message you again.' };
  }

  // existingCustomer is guaranteed non-null here — the window check
  // above already rejects any customer with no last_message_at.
  return { business, customer: toCamelCase(existingCustomer) };
};

/**
 * Side effects of a genuine staff send, shared by sendMessage and
 * sendPaymentQr. Returns the customer's (possibly updated) botPausedUntil.
 */
const afterManualSend = async (customer) => {
  // A genuine staff reply is the New->Contacted trigger (see
  // customerPipeline.service.js) — a no-op if the customer is already past
  // 'new' or has been manually marked 'lost'.
  await customerPipelineService.advancePipelineStage(customer.id, 'contacted');

  // A staff reply implies the bot should stay quiet for this customer for
  // a while — pause it the same way the explicit pause endpoint does.
  // An indefinite pause (set via the pause endpoint) must not be
  // shortened to 24h by a manual send, so leave it untouched.
  let botPausedUntil = customer.botPausedUntil;
  if (!isIndefinitePause(botPausedUntil)) {
    botPausedUntil = new Date(Date.now() + BOT_PAUSE_DURATION_MS).toISOString();
    const { error: pauseErr } = await supabase
      .from('customers').update({ bot_paused_until: botPausedUntil }).eq('id', customer.id);
    if (pauseErr) {
      logger.error('Error pausing bot after manual send:', pauseErr);
    }
  }
  return botPausedUntil;
};

/**
 * POST /api/messages/send
 * Manually send a WhatsApp message to a customer.
 * ALWAYS goes through BullMQ — never calls Meta API directly.
 */
const sendMessage = async (req, res, next) => {
  try {
    const { customerNumber, message } = req.body;
    const businessId = req.user.businessId;

    if (!customerNumber || !message) {
      return errorResponse(res, 400, 'customerNumber and message are required');
    }
    if (message.trim().length === 0) {
      return errorResponse(res, 400, 'Message cannot be empty');
    }

    const target = await loadManualSendTarget(businessId, customerNumber);
    if (target.error) return errorResponse(res, target.status, target.error);
    const { business, customer } = target;

    // Save outbound message to DB
    const { data: outboundMsgRow, error: msgErr } = await supabase.from('messages').insert({
      business_id: businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'outbound',
      type: 'text',
      content: message.trim(),
      status: 'sent',
      sender_type: 'human',
      is_read: true
    }).select().single();
    if (msgErr) throw msgErr;
    const outboundMsg = toCamelCase(outboundMsgRow);

    // Queue via BullMQ — NEVER call Meta API directly from controller
    await addToWhatsappQueue({
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: customerNumber,
      message: message.trim(),
      type: 'text',
      messageId: outboundMsg.id
    });

    logger.info(`Manual message queued to ${customerNumber} for business ${businessId}`);

    const botPausedUntil = await afterManualSend(customer);

    return successResponse(res, 201, { ...outboundMsg, botPausedUntil }, 'Message queued for delivery');
  } catch (error) {
    logger.error('Error in sendMessage:', error);
    next(error);
  }
};

/**
 * POST /api/messages/send-payment-qr
 * Body: { customerNumber, amount?, bookingId? }
 * Sends the business's payment QR (businesses.payment_qr_url) as a WhatsApp
 * image with a pay-by-QR caption. With bookingId, that booking (must belong
 * to this customer) is set to payment_status 'pending' with the amount, so it
 * shows on the Payments screen until the owner marks it paid
 * (PUT /api/bookings/:id/payment).
 */
const sendPaymentQr = async (req, res, next) => {
  try {
    const { customerNumber, bookingId } = req.body;
    const businessId = req.user.businessId;

    if (!customerNumber) {
      return errorResponse(res, 400, 'customerNumber is required');
    }
    const amount = req.body.amount === undefined || req.body.amount === null || req.body.amount === ''
      ? null
      : Number(req.body.amount);
    if (amount !== null && !(amount > 0)) {
      return errorResponse(res, 400, 'amount must be a positive number');
    }

    const target = await loadManualSendTarget(businessId, customerNumber);
    if (target.error) return errorResponse(res, target.status, target.error);
    const { business, customer } = target;

    if (!business.paymentQrUrl) {
      return errorResponse(res, 400, 'Upload your payment QR code in Settings first.');
    }

    let booking = null;
    if (bookingId) {
      const { data: bookingRow, error: bookingErr } = await supabase
        .from('bookings').select('*').eq('id', bookingId).eq('business_id', businessId).maybeSingle();
      if (bookingErr) throw bookingErr;
      if (!bookingRow || bookingRow.customer_id !== customer.id) {
        return errorResponse(res, 404, 'Booking not found for this customer');
      }
      booking = bookingRow;
    }

    const caption = paymentService.buildPaymentQrCaption({
      amount,
      bookingCode: booking?.booking_code,
      upiId: business.upiId
    });

    const { data: outboundMsgRow, error: msgErr } = await supabase.from('messages').insert({
      business_id: businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'outbound',
      type: 'image',
      content: caption,
      media_url: business.paymentQrUrl,
      status: 'sent',
      sender_type: 'human',
      is_read: true
    }).select().single();
    if (msgErr) throw msgErr;
    const outboundMsg = toCamelCase(outboundMsgRow);

    // Queue via BullMQ — the worker sends imageUrl + message as an image
    // with caption (whatsapp.worker.js).
    await addToWhatsappQueue({
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      to: customerNumber,
      message: caption,
      imageUrl: business.paymentQrUrl,
      messageId: outboundMsg.id
    });

    if (booking) {
      const bookingUpdate = { payment_status: 'pending' };
      if (amount !== null) bookingUpdate.payment_amount = amount;
      const { error: updateErr } = await supabase.from('bookings').update(bookingUpdate).eq('id', booking.id);
      if (updateErr) throw updateErr;
    }

    logger.info(`Payment QR queued to ${customerNumber} for business ${businessId}`);

    const botPausedUntil = await afterManualSend(customer);

    return successResponse(res, 201, { ...outboundMsg, botPausedUntil }, 'Payment QR queued for delivery');
  } catch (error) {
    logger.error('Error in sendPaymentQr:', error);
    next(error);
  }
};

/**
 * PATCH /api/messages/customer/:customerId/pause
 * Manually pause or resume the bot for one customer.
 */
const setBotPause = async (req, res, next) => {
  try {
    const { customerId } = req.params;
    const { paused, duration } = req.body;
    const businessId = req.user.businessId;

    if (typeof paused !== 'boolean') {
      return errorResponse(res, 400, 'paused (boolean) is required');
    }
    if (paused && duration !== undefined && duration !== '24h' && duration !== 'forever') {
      return errorResponse(res, 400, 'duration must be "24h" or "forever"');
    }

    const botPausedUntil = paused
      ? (duration === 'forever' ? INDEFINITE_PAUSE_SENTINEL : new Date(Date.now() + BOT_PAUSE_DURATION_MS).toISOString())
      : null;

    const { data: updatedCustomer, error } = await supabase
      .from('customers')
      .update({ bot_paused_until: botPausedUntil })
      .eq('id', customerId).eq('business_id', businessId)
      .select().maybeSingle();
    if (error) throw error;
    if (!updatedCustomer) return errorResponse(res, 404, 'Customer not found');

    return successResponse(res, 200, toCamelCase(updatedCustomer), paused ? 'Bot paused for customer' : 'Bot resumed for customer');
  } catch (error) {
    logger.error('Error in setBotPause:', error);
    next(error);
  }
};

module.exports = {
  getConversations,
  getChatHistory,
  markAsRead,
  sendMessage,
  sendPaymentQr,
  setBotPause
};
