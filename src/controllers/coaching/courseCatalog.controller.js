const supabase = require('../../config/supabase');
const businessCategoryService = require('../../services/businessCategory.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { toCamelCase } = require('../../utils/caseConvert');
const { validateCourseFields, cleanText } = require('../../utils/courseValidation');
const logger = require('../../utils/logger');

// Super Admin course catalog — the coaching counterpart of
// travel/vehicleCatalog.controller.js. Entries are suggestions: businesses
// COPY them into business_courses (see coaching/course.controller.js), so
// editing or deleting an entry here never changes any business's courses.

const UNIQUE_VIOLATION = '23505';
const duplicateNameError = 'A course with this name already exists in this category.';

/**
 * GET /api/admin/course-catalog?category=coaching
 * All entries (active + inactive), optionally filtered by category.
 */
const getCourseCatalog = async (req, res, next) => {
  try {
    const { category } = req.query;
    let query = supabase.from('course_catalog').select('*');
    if (category) query = query.eq('category', category);
    const { data, error } = await query
      .order('category', { ascending: true })
      .order('order', { ascending: true })
      .order('name', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { catalog: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getCourseCatalog:', error);
    next(error);
  }
};

/**
 * POST /api/admin/course-catalog
 * Body: { category, name, description?, details?, order? }
 */
const createCourseCatalogEntry = async (req, res, next) => {
  try {
    const { category, name, description = null, details = null, order = 0 } = req.body || {};
    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    const fieldError = validateCourseFields({ name, description, details });
    if (fieldError) return errorResponse(res, 400, fieldError);
    if (typeof order !== 'number') return errorResponse(res, 400, 'order must be a number');

    const { data: entry, error } = await supabase.from('course_catalog').insert({
      category,
      name: name.trim(),
      description: cleanText(description),
      details: cleanText(details),
      order,
      is_active: true
    }).select().single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return errorResponse(res, 409, duplicateNameError);
      throw error;
    }

    logger.info(`Course catalog entry ${entry.id} created by superadmin`);
    return successResponse(res, 201, toCamelCase(entry), 'Course added to catalog');
  } catch (error) {
    logger.error('Error in createCourseCatalogEntry:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/course-catalog/:id
 * Body: any of { name, description, details, isActive, order }. category is
 * fixed once created (delete + re-add to move an entry).
 */
const updateCourseCatalogEntry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const { data: existing, error: findErr } = await supabase
      .from('course_catalog').select('id').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!existing) return errorResponse(res, 404, 'Course catalog entry not found');

    const fieldError = validateCourseFields(body, { partial: true });
    if (fieldError) return errorResponse(res, 400, fieldError);
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return errorResponse(res, 400, 'isActive must be true or false');
    if (body.order !== undefined && typeof body.order !== 'number') return errorResponse(res, 400, 'order must be a number');

    const updates = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = cleanText(body.description);
    if (body.details !== undefined) updates.details = cleanText(body.details);
    if (body.isActive !== undefined) updates.is_active = body.isActive;
    if (body.order !== undefined) updates.order = body.order;
    if (Object.keys(updates).length === 0) return errorResponse(res, 400, 'No recognized fields to update');

    const { data: entry, error } = await supabase
      .from('course_catalog').update(updates).eq('id', id).select().single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return errorResponse(res, 409, duplicateNameError);
      throw error;
    }

    logger.info(`Course catalog entry ${id} updated by superadmin`);
    return successResponse(res, 200, toCamelCase(entry), 'Course updated');
  } catch (error) {
    logger.error('Error in updateCourseCatalogEntry:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/course-catalog/:id
 * Businesses that already added this course keep their copy
 * (business_courses.catalog_id is set to null by the FK).
 */
const deleteCourseCatalogEntry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { data: entry, error: findErr } = await supabase
      .from('course_catalog').select('id').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!entry) return errorResponse(res, 404, 'Course catalog entry not found');

    const { error } = await supabase.from('course_catalog').delete().eq('id', id);
    if (error) throw error;

    logger.info(`Course catalog entry ${id} deleted by superadmin`);
    return successResponse(res, 200, null, 'Course removed from catalog');
  } catch (error) {
    logger.error('Error in deleteCourseCatalogEntry:', error);
    next(error);
  }
};

module.exports = {
  getCourseCatalog,
  createCourseCatalogEntry,
  updateCourseCatalogEntry,
  deleteCourseCatalogEntry
};
