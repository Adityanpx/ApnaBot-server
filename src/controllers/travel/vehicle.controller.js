const supabase = require('../../config/supabase');
const { toCamelCase } = require('../../utils/caseConvert');
const r2 = require('../../services/r2.service');
const { successResponse, errorResponse } = require('../../utils/response');
const logger = require('../../utils/logger');
const { validateVehicleFareInput } = require('../../utils/travelQuote');

/**
 * GET /api/vehicles/catalog
 * List active vehicle type catalog entries for business owners to pick from
 */
const getVehicleCatalogForBusiness = async (req, res, next) => {
  try {
    const { data: catalog, error } = await supabase
      .from('vehicle_type_catalog')
      .select('*')
      .eq('is_active', true)
      .order('order', { ascending: true });
    if (error) throw error;

    const mappedCatalog = (catalog || []).map((row) => ({
      _id: row.id,
      name: row.name,
      type: row.type,
      photoUrl: row.photo_url,
      seats: row.seats
    }));

    return successResponse(res, 200, { catalog: mappedCatalog });
  } catch (error) {
    logger.error('Error in getVehicleCatalogForBusiness:', error);
    next(error);
  }
};

/**
 * GET /api/vehicles
 * List all vehicles for business
 */
const getVehicles = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('vehicles')
      .select('*, catalog:vehicle_type_catalog(id, name, type, photo_url, seats)')
      .eq('business_id', businessId)
      .order('order', { ascending: true });
    if (error) throw error;

    const vehicles = (data || []).map(({ catalog, ...vehicle }) => ({
      ...toCamelCase(vehicle),
      catalogId: catalog ? {
        _id: catalog.id,
        name: catalog.name,
        type: catalog.type,
        photoUrl: catalog.photo_url,
        seats: catalog.seats
      } : null
    }));

    return successResponse(res, 200, { vehicles });
  } catch (error) {
    logger.error('Error in getVehicles:', error);
    next(error);
  }
};

/**
 * POST /api/vehicles
 * Create a new vehicle
 */
const createVehicle = async (req, res, next) => {
  try {
    const { catalogId, customName = null, customPhotoUrl = null, perKmRate = null, order = 0 } = req.body;
    const businessId = req.user.businessId;

    if (!catalogId) {
      return errorResponse(res, 400, 'catalogId is required');
    }
    const fareInput = validateVehicleFareInput(req.body);
    if (fareInput.errors.length > 0) {
      return errorResponse(res, 400, fareInput.errors[0], fareInput.errors);
    }

    const { data: catalogEntry } = await supabase
      .from('vehicle_type_catalog').select('id').eq('id', catalogId).maybeSingle();
    if (!catalogEntry) {
      return errorResponse(res, 404, 'Vehicle catalog entry not found');
    }

    const { data: vehicle, error } = await supabase.from('vehicles').insert({
      business_id: businessId,
      catalog_id: catalogId,
      custom_name: customName,
      custom_photo_url: customPhotoUrl,
      per_km_rate: perKmRate,
      ...fareInput.value,
      order,
      is_active: true
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(vehicle), 'Vehicle created successfully');
  } catch (error) {
    logger.error('Error in createVehicle:', error);
    next(error);
  }
};

/**
 * PUT /api/vehicles/:id
 * Update a vehicle
 */
const updateVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('vehicles').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    if (req.body.catalogId !== undefined) {
      const { data: catalogEntry } = await supabase
        .from('vehicle_type_catalog').select('id').eq('id', req.body.catalogId).maybeSingle();
      if (!catalogEntry) {
        return errorResponse(res, 404, 'Vehicle catalog entry not found');
      }
    }

    const fareInput = validateVehicleFareInput(req.body);
    if (fareInput.errors.length > 0) {
      return errorResponse(res, 400, fareInput.errors[0], fareInput.errors);
    }

    const fieldMap = {
      catalogId: 'catalog_id', customName: 'custom_name', customPhotoUrl: 'custom_photo_url',
      perKmRate: 'per_km_rate', isActive: 'is_active', order: 'order'
    };
    const updates = { ...fareInput.value };
    for (const [field, column] of Object.entries(fieldMap)) {
      if (req.body[field] !== undefined) updates[column] = req.body[field];
    }

    const { data: vehicle, error } = await supabase
      .from('vehicles').update(updates).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(vehicle), 'Vehicle updated successfully');
  } catch (error) {
    logger.error('Error in updateVehicle:', error);
    next(error);
  }
};

/**
 * DELETE /api/vehicles/:id
 * Delete a vehicle
 */
const deleteVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('vehicles').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const { error } = await supabase.from('vehicles').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'Vehicle deleted successfully');
  } catch (error) {
    logger.error('Error in deleteVehicle:', error);
    next(error);
  }
};

/**
 * PUT /api/vehicles/:id/toggle
 * Toggle vehicle isActive
 */
const toggleVehicle = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: existing, error: findErr } = await supabase
      .from('vehicles').select('is_active').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) {
      return errorResponse(res, 404, 'Vehicle not found');
    }

    const { data: vehicle, error } = await supabase
      .from('vehicles').update({ is_active: !existing.is_active }).eq('id', id).select().single();
    if (error) throw error;

    return successResponse(res, 200, toCamelCase(vehicle));
  } catch (error) {
    logger.error('Error in toggleVehicle:', error);
    next(error);
  }
};

/**
 * POST /api/vehicles/upload-image
 * Upload a vehicle photo to R2
 */
const uploadVehicleImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }

    const businessId = req.user.businessId;
    if (!businessId) {
      return errorResponse(res, 404, 'No business found');
    }

    const result = await r2.uploadImage(
      req.file.buffer,
      'vehicle-photos',
      `vehicle-${businessId}-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { imageUrl: result.url });
  } catch (error) {
    logger.error('Error in uploadVehicleImage:', error);
    next(error);
  }
};

module.exports = {
  getVehicleCatalogForBusiness,
  getVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  toggleVehicle,
  uploadVehicleImage
};
