const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { getPagination } = require('../utils/pagination');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');
const socketService = require('../services/socket.service');
const bookingService = require('../services/booking.service');
const customerPipelineService = require('../services/customerPipeline.service');

// Statuses that count as the Contacted->Converted trigger (see
// customerPipeline.service.js) — mirrors reports.service.js's
// CONFIRMED_STATUSES, kept local since the two files don't otherwise share
// constants.
const CONVERTING_STATUSES = ['confirmed', 'completed'];

/**
 * GET /api/bookings
 * List bookings for business with filters
 */
const getBookings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, date, customerNumber, customerId } = req.query;
    const businessId = req.user.businessId;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);

    let query = supabase
      .from('bookings')
      .select('*, customer:customers(name, whatsapp_number)', { count: 'exact' })
      .eq('business_id', businessId);

    if (status) {
      query = query.eq('status', status);
    }

    if (date) {
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      query = query.gte('created_at', startOfDay.toISOString()).lte('created_at', endOfDay.toISOString());
    }

    if (customerNumber) {
      query = query.ilike('customer_number', `%${customerNumber}%`);
    }

    if (customerId) {
      query = query.eq('customer_id', customerId);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
    if (error) throw error;

    const pagination = getPagination(count, pageNum, limitNum);

    return successResponse(res, 200, { bookings: (data || []).map(toCamelCase), pagination });
  } catch (error) {
    logger.error('Error fetching bookings:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/:id
 * Get single booking detail
 */
const getBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*, customer:customers(*)')
      .eq('id', id).eq('business_id', businessId).maybeSingle();
    if (error) throw error;

    if (!booking) {
      return errorResponse(res, 404, 'Booking not found');
    }

    return successResponse(res, 200, toCamelCase(booking));
  } catch (error) {
    logger.error('Error fetching booking:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/status
 * Update booking status
 */
const updateBookingStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const businessId = req.user.businessId;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!status || !validStatuses.includes(status)) {
      return errorResponse(res, 400, 'Invalid status. Must be one of: pending, confirmed, completed, cancelled');
    }

    const { data: existing, error: findErr } = await supabase
      .from('bookings').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Booking not found');
    }

    const { data: booking, error } = await supabase
      .from('bookings').update({ status }).eq('id', id).select().single();
    if (error) throw error;

    if (CONVERTING_STATUSES.includes(status)) {
      await customerPipelineService.advancePipelineStage(booking.customer_id, 'converted');
    }

    try {
      socketService.emitToBusiness(businessId, 'booking_updated', {
        bookingId: id,
        status
      });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }

    return successResponse(res, 200, toCamelCase(booking), 'Booking status updated');
  } catch (error) {
    logger.error('Error updating booking status:', error);
    next(error);
  }
};

/**
 * PUT /api/bookings/:id/notes
 * Add or update internal notes on booking
 */
const addBookingNotes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const businessId = req.user.businessId;

    if (!notes || typeof notes !== 'string') {
      return errorResponse(res, 400, 'Notes is required');
    }

    const { data: existing, error: findErr } = await supabase
      .from('bookings').select('fields').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Booking not found');
    }

    const updatedFields = { ...(existing.fields || {}), internalNotes: notes };

    const { data: booking, error } = await supabase
      .from('bookings').update({ fields: updatedFields }).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(booking), 'Notes added successfully');
  } catch (error) {
    logger.error('Error adding booking notes:', error);
    next(error);
  }
};

/**
 * DELETE /api/bookings/:id
 * Delete booking
 */
const deleteBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('bookings').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Booking not found');
    }

    const { error } = await supabase.from('bookings').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Booking deleted successfully');
  } catch (error) {
    logger.error('Error deleting booking:', error);
    next(error);
  }
};

/**
 * GET /api/bookings/preview-vehicle-options
 * Read-only preview of the vehicle carousel for a given pickup/drop/tripType,
 * for the dashboard's Conversation Preview. No session is created.
 */
const getVehicleCarouselPreview = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { pickupLocation, dropLocation, tripType, source } = req.query;

    let previewCreditsRemaining;
    if (source === 'manual_preview') {
      const credit = await bookingService.checkAndConsumeManualPreviewCredit(businessId);
      if (!credit.allowed) {
        return errorResponse(res, 402, "You've used all your free previews this month.", { previewCreditsRemaining: 0 });
      }
      previewCreditsRemaining = credit.remaining;
    }

    const options = await bookingService.getVehicleCarouselPreview(businessId, pickupLocation, dropLocation, tripType);

    const data = { options };
    if (previewCreditsRemaining !== undefined) {
      data.previewCreditsRemaining = previewCreditsRemaining;
    }

    return successResponse(res, 200, data);
  } catch (error) {
    logger.error('Error fetching vehicle carousel preview:', error);
    next(error);
  }
};

module.exports = {
  getBookings,
  getBookingById,
  updateBookingStatus,
  addBookingNotes,
  deleteBooking,
  getVehicleCarouselPreview
};
