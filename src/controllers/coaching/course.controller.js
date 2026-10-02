const supabase = require('../../config/supabase');
const { successResponse, errorResponse } = require('../../utils/response');
const { toCamelCase } = require('../../utils/caseConvert');
const { validateCourseFields, cleanText, structuredColumns } = require('../../utils/courseValidation');
const logger = require('../../utils/logger');

// A business's own courses (business_courses) — the coaching counterpart of
// travel/vehicle.controller.js. Unlike vehicles, a course picked from the
// Super Admin catalog is a COPY (own name/description/details), and owners
// can also add courses that aren't in the catalog. Used by the Bot Builder
// (botSettings.service.js) and the service form's "Course list" dropdown
// (publicServiceForm.controller.js, source 'business_courses').

const UNIQUE_VIOLATION = '23505';
const MAX_COURSES_PER_BUSINESS = 50;

const duplicateName = (name) => `You already have a course named "${name}".`;

// Courses are returned with their photo's URL (business_media, via
// image_media_id) for the dashboard previews.
const COURSE_SELECT = '*, image:business_media(url)';
const toCourse = ({ image, ...row }) => ({ ...toCamelCase(row), imageUrl: image?.url || null });

const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checks a course photo: null/'' clears it; otherwise it must be an image in
 * this business's media library. Returns { mediaId } or { error }.
 */
const checkCourseImage = async (businessId, imageMediaId) => {
  if (imageMediaId === null || imageMediaId === '') return { mediaId: null };
  if (typeof imageMediaId !== 'string' || !MEDIA_ID_PATTERN.test(imageMediaId)) return { error: 'imageMediaId must be a media id' };
  const { data, error } = await supabase
    .from('business_media').select('id').eq('id', imageMediaId).eq('business_id', businessId).eq('media_type', 'image').maybeSingle();
  if (error) throw error;
  return data ? { mediaId: data.id } : { error: 'That photo was not found in your media library (it must be an image).' };
};

const loadCourse = async (businessId, id) => {
  const { data, error } = await supabase
    .from('business_courses').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

const nextOrder = async (businessId) => {
  const { data, error } = await supabase
    .from('business_courses').select('order').eq('business_id', businessId)
    .order('order', { ascending: false }).limit(1);
  if (error) throw error;
  return data && data.length > 0 ? data[0].order + 1 : 0;
};

/**
 * GET /api/courses/catalog
 * Active Super Admin catalog entries for this business's category, each
 * flagged alreadyAdded when the business has a course copied from it.
 */
const getCourseCatalogForBusiness = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { data: business, error: bizErr } = await supabase
      .from('businesses').select('business_category').eq('id', businessId).maybeSingle();
    if (bizErr) throw bizErr;
    if (!business) return errorResponse(res, 404, 'Business not found');

    const [{ data: catalog, error }, { data: mine, error: mineErr }] = await Promise.all([
      supabase.from('course_catalog')
        .select('id, name, description, details, group_name, age_group, duration, fees, mode, more_details, batches, order')
        .eq('category', business.business_category).eq('is_active', true)
        .order('order', { ascending: true }).order('name', { ascending: true }),
      supabase.from('business_courses').select('catalog_id').eq('business_id', businessId)
    ]);
    if (error) throw error;
    if (mineErr) throw mineErr;
    const added = new Set((mine || []).map(c => c.catalog_id).filter(Boolean));

    return successResponse(res, 200, {
      catalog: (catalog || []).map(row => ({ ...toCamelCase(row), alreadyAdded: added.has(row.id) }))
    });
  } catch (error) {
    logger.error('Error in getCourseCatalogForBusiness:', error);
    next(error);
  }
};

/**
 * GET /api/courses
 * This business's courses, in display order.
 */
const getCourses = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('business_courses').select(COURSE_SELECT).eq('business_id', req.user.businessId)
      .order('order', { ascending: true }).order('created_at', { ascending: true });
    if (error) throw error;
    return successResponse(res, 200, { courses: (data || []).map(toCourse) });
  } catch (error) {
    logger.error('Error in getCourses:', error);
    next(error);
  }
};

/**
 * POST /api/courses
 * Body: { catalogId } — copy a catalog entry's text, group, structured
 * details and batches, or { name, description?, details?, groupName?,
 * ageGroup?, duration?, fees?, mode?, moreDetails?, batches? } — a course of
 * the owner's own. Either way
 * the new course is appended at the end and shown (is_active true).
 */
const createCourse = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const body = req.body || {};

    const { count, error: countErr } = await supabase
      .from('business_courses').select('id', { count: 'exact', head: true }).eq('business_id', businessId);
    if (countErr) throw countErr;
    if (count >= MAX_COURSES_PER_BUSINESS) {
      return errorResponse(res, 400, `You can have at most ${MAX_COURSES_PER_BUSINESS} courses.`);
    }

    let row;
    if (body.catalogId !== undefined) {
      const { data: entry, error } = await supabase
        .from('course_catalog').select('*').eq('id', body.catalogId).eq('is_active', true).maybeSingle();
      if (error) throw error;
      if (!entry) return errorResponse(res, 404, 'Catalog course not found');
      row = {
        catalog_id: entry.id, name: entry.name, description: entry.description, details: entry.details, group_name: entry.group_name,
        age_group: entry.age_group, duration: entry.duration, fees: entry.fees, mode: entry.mode, more_details: entry.more_details,
        batches: entry.batches || []
      };
    } else {
      const fieldError = validateCourseFields(body);
      if (fieldError) return errorResponse(res, 400, fieldError);
      row = {
        catalog_id: null, name: body.name.trim(), description: cleanText(body.description), details: cleanText(body.details),
        group_name: cleanText(body.groupName),
        ...structuredColumns(body)
      };
      if (body.imageMediaId !== undefined) {
        const image = await checkCourseImage(businessId, body.imageMediaId);
        if (image.error) return errorResponse(res, 400, image.error);
        row.image_media_id = image.mediaId;
      }
    }

    const { data: course, error } = await supabase.from('business_courses').insert({
      ...row,
      business_id: businessId,
      order: await nextOrder(businessId),
      is_active: true
    }).select(COURSE_SELECT).single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return errorResponse(res, 409, duplicateName(row.name));
      throw error;
    }
    return successResponse(res, 201, toCourse(course), 'Course added');
  } catch (error) {
    logger.error('Error in createCourse:', error);
    next(error);
  }
};

/**
 * PUT /api/courses/:id
 * Body: any of { name, description, details, groupName, ageGroup, duration,
 * fees, mode, moreDetails, batches, imageMediaId, showDemoButton,
 * showAdmissionButton, isActive }. batches replaces the whole list;
 * imageMediaId: an image in this business's media library, or null (no photo).
 * '' / null clears a text field (groupName: no group; mode: not shown). Changes the business's own copy only —
 * the WhatsApp bot shows them after the next Bot Builder Publish; the
 * service form's course dropdown shows them immediately.
 */
const updateCourse = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { id } = req.params;
    const body = req.body || {};
    if (!(await loadCourse(businessId, id))) return errorResponse(res, 404, 'Course not found');

    const fieldError = validateCourseFields(body, { partial: true });
    if (fieldError) return errorResponse(res, 400, fieldError);
    for (const key of ['showDemoButton', 'showAdmissionButton', 'isActive']) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') return errorResponse(res, 400, `${key} must be true or false`);
    }

    const updates = {};
    if (body.name !== undefined) updates.name = body.name.trim();
    if (body.description !== undefined) updates.description = cleanText(body.description);
    if (body.details !== undefined) updates.details = cleanText(body.details);
    if (body.groupName !== undefined) updates.group_name = cleanText(body.groupName);
    Object.assign(updates, structuredColumns(body));
    if (body.imageMediaId !== undefined) {
      const image = await checkCourseImage(businessId, body.imageMediaId);
      if (image.error) return errorResponse(res, 400, image.error);
      updates.image_media_id = image.mediaId;
    }
    if (body.showDemoButton !== undefined) updates.show_demo_button = body.showDemoButton;
    if (body.showAdmissionButton !== undefined) updates.show_admission_button = body.showAdmissionButton;
    if (body.isActive !== undefined) updates.is_active = body.isActive;
    if (Object.keys(updates).length === 0) return errorResponse(res, 400, 'No recognized fields to update');

    const { data: course, error } = await supabase
      .from('business_courses').update(updates).eq('id', id).eq('business_id', businessId).select(COURSE_SELECT).single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) return errorResponse(res, 409, duplicateName(updates.name));
      throw error;
    }
    return successResponse(res, 200, toCourse(course), 'Course updated');
  } catch (error) {
    logger.error('Error in updateCourse:', error);
    next(error);
  }
};

/**
 * DELETE /api/courses/:id
 */
const deleteCourse = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { id } = req.params;
    if (!(await loadCourse(businessId, id))) return errorResponse(res, 404, 'Course not found');
    const { error } = await supabase.from('business_courses').delete().eq('id', id).eq('business_id', businessId);
    if (error) throw error;
    return successResponse(res, 200, null, 'Course deleted');
  } catch (error) {
    logger.error('Error in deleteCourse:', error);
    next(error);
  }
};

/**
 * PUT /api/courses/reorder
 * Body: { orderedIds } — exactly this business's course ids, no more, no
 * fewer, no duplicates (same contract as flowGraph.controller.js#reorderEdges).
 */
const reorderCourses = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { orderedIds } = req.body || {};
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return errorResponse(res, 400, 'orderedIds must be a non-empty array');
    }
    const { data: existing, error: fetchErr } = await supabase
      .from('business_courses').select('id').eq('business_id', businessId);
    if (fetchErr) throw fetchErr;
    const existingIds = new Set((existing || []).map(c => c.id));
    if (existingIds.size !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length ||
        !orderedIds.every(id => existingIds.has(id))) {
      return errorResponse(res, 400, 'orderedIds must contain exactly your current courses, no more, no fewer, no duplicates');
    }
    for (let i = 0; i < orderedIds.length; i++) {
      const { error } = await supabase.from('business_courses').update({ order: i }).eq('id', orderedIds[i]).eq('business_id', businessId);
      if (error) throw error;
    }
    return getCourses(req, res, next);
  } catch (error) {
    logger.error('Error in reorderCourses:', error);
    next(error);
  }
};

module.exports = {
  getCourseCatalogForBusiness,
  getCourses,
  createCourse,
  updateCourse,
  deleteCourse,
  reorderCourses
};
