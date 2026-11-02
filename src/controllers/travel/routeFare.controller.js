const supabase = require('../../config/supabase');
const { toCamelCase } = require('../../utils/caseConvert');
const { successResponse, errorResponse } = require('../../utils/response');
const logger = require('../../utils/logger');
const { validateRouteFareInput, fareSwitchColumns } = require('../../utils/travelQuote');

/**
 * GET /api/route-fares
 * List all route fares for business
 */
const getRouteFares = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('route_fares')
      .select('*, vehicle:vehicles(id, custom_name, catalog:vehicle_type_catalog(id, name))')
      .eq('business_id', businessId)
      .order('from_city', { ascending: true })
      .order('to_city', { ascending: true });
    if (error) throw error;

    const routeFares = (data || []).map(({ vehicle, ...routeFare }) => ({
      ...toCamelCase(routeFare),
      vehicleId: vehicle ? {
        _id: vehicle.id,
        customName: vehicle.custom_name,
        catalogId: vehicle.catalog ? { _id: vehicle.catalog.id, name: vehicle.catalog.name } : null
      } : null
    }));

    return successResponse(res, 200, { routeFares });
  } catch (error) {
    logger.error('Error in getRouteFares:', error);
    next(error);
  }
};

/**
 * POST /api/route-fares
 * Create (or update, if the route+vehicle+tripType combo already exists) a route fare. The same rules as
 * a fare in Rates -> Routes (validateRouteFareInput); saving here switches the fare on and clears a manual
 * switch-off marker (off_reason), so the row never reads "active but switched off by hand".
 */
const createRouteFare = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { errors, value } = validateRouteFareInput(req.body);
    if (errors.length > 0) {
      return errorResponse(res, 400, errors[0], errors);
    }
    const { fromCity, toCity, tripType, vehicleId, fare } = value;

    const { data: vehicle } = await supabase
      .from('vehicles').select('id').eq('id', vehicleId).eq('business_id', businessId).maybeSingle();
    if (!vehicle) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const { data: routeFare, error } = await supabase
      .from('route_fares')
      .upsert({
        business_id: businessId,
        from_city: fromCity,
        to_city: toCity,
        trip_type: tripType,
        vehicle_id: vehicleId,
        fare,
        ...fareSwitchColumns(true)
      }, { onConflict: 'business_id,from_city,to_city,trip_type,vehicle_id' })
      .select()
      .single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(routeFare), 'Route fare saved successfully');
  } catch (error) {
    logger.error('Error in createRouteFare:', error);
    next(error);
  }
};

/**
 * PUT /api/route-fares/:id
 * Update a route fare. A switch-off sets off_reason 'manual' and a switch-on clears it (the same columns
 * as Rates -> Routes), so a route switched off and on again does not bring a fare back that was switched
 * off by hand. Saving a price alone never changes whether the fare is on.
 */
const updateRouteFare = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('route_fares').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Route fare not found');
    }

    const { errors, value } = validateRouteFareInput(req.body, { isEdit: true });
    if (errors.length > 0) {
      return errorResponse(res, 400, errors[0], errors);
    }
    const { fromCity, toCity, tripType, vehicleId, fare, isActive } = value;
    const updates = {};

    if (vehicleId !== undefined) {
      const { data: vehicle } = await supabase
        .from('vehicles').select('id').eq('id', vehicleId).eq('business_id', businessId).maybeSingle();
      if (!vehicle) {
        return errorResponse(res, 404, 'Vehicle not found');
      }
      updates.vehicle_id = vehicleId;
    }

    if (fromCity !== undefined) updates.from_city = fromCity;
    if (toCity !== undefined) updates.to_city = toCity;
    if (tripType !== undefined) updates.trip_type = tripType;
    if (fare !== undefined) updates.fare = fare;
    Object.assign(updates, fareSwitchColumns(isActive));

    const { data: routeFare, error } = await supabase
      .from('route_fares').update(updates).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(routeFare), 'Route fare updated successfully');
  } catch (error) {
    logger.error('Error in updateRouteFare:', error);
    next(error);
  }
};

/**
 * DELETE /api/route-fares/:id
 * Delete a route fare
 */
const deleteRouteFare = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('route_fares').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Route fare not found');
    }

    const { error } = await supabase.from('route_fares').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Route fare deleted successfully');
  } catch (error) {
    logger.error('Error in deleteRouteFare:', error);
    next(error);
  }
};

module.exports = {
  getRouteFares,
  createRouteFare,
  updateRouteFare,
  deleteRouteFare
};
