const axios = require('axios');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const r2 = require('../services/r2.service');
const { decrypt } = require('../utils/crypto');
const { META_API_BASE } = require('../services/whatsapp.service');
const templateSyncService = require('../services/templateSync.service');
const { computeSendSupport, extensionOf, EXTENSIONS_BY_FORMAT } = require('../utils/templateSendSupport');
const config = require('../config/env');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Meta requires template names to be lowercase, alphanumeric + underscores only
const TEMPLATE_NAME_REGEX = /^[a-z0-9_]+$/;

// WhatsApp template headers accept JPG and PNG only. The shared uploadSingle
// middleware also allows WebP (business / vehicle images), so the template
// endpoint narrows it here.
const HEADER_IMAGE_TYPES = ['image/jpeg', 'image/png'];

// business_media.media_type each template header format takes, and the size cap
// WhatsApp (and our plan) puts on it.
const HEADER_MEDIA_TYPE = { IMAGE: 'image', VIDEO: 'video', DOCUMENT: 'document' };
const HEADER_MEDIA_MAX_BYTES = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024, DOCUMENT: 10 * 1024 * 1024 };
const HEADER_MEDIA_LABEL = { IMAGE: 'a JPG or PNG image', VIDEO: 'an MP4 video', DOCUMENT: 'a PDF' };

const countTemplateVariables = (bodyText) => {
  const matches = (bodyText || '').match(/\{\{\s*\d+\s*\}\}/g) || [];
  const numbers = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return numbers.size;
};

/**
 * GET /api/message-templates
 * List business's message templates
 */
const getMessageTemplates = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('message_templates').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
    if (error) throw error;

    // source / qualityScore / sendSupport / lastSyncedAt come straight from the
    // columns; metaDeleted says WhatsApp no longer lists the template.
    const templates = (data || []).map((row) => ({ ...toCamelCase(row), metaDeleted: !!row.meta_deleted_at }));
    return successResponse(res, 200, { templates });
  } catch (error) {
    logger.error('Error in getMessageTemplates:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates/sync
 * Pull the business's templates from WhatsApp (services/templateSync.service.js).
 * One sync per business per minute.
 */
const syncMessageTemplates = async (req, res, next) => {
  try {
    const { summary } = await templateSyncService.runSync(req.user.businessId);
    return successResponse(res, 200, summary, 'Templates synced from WhatsApp');
  } catch (error) {
    if (error.name === 'SyncThrottledError') {
      res.set('Retry-After', String(error.retryAfterSeconds));
      return errorResponse(res, 429, error.message);
    }
    if (error.status === 400) {
      return errorResponse(res, 400, error.message);
    }
    if (error.response) {
      logger.error('Error syncing templates from Meta:', { businessId: req.user.businessId, error: error.response.data || error.message });
      return errorResponse(res, 502, 'Could not fetch templates from WhatsApp. Please try again in a few minutes.', error.response.data || error.message);
    }
    logger.error('Error in syncMessageTemplates:', error);
    next(error);
  }
};

/**
 * PUT /api/message-templates/:id/header-media  { mediaId }
 * Attach a media-library file (business_media) as the template's IMAGE / VIDEO /
 * DOCUMENT header, and recompute send_support. This is how a synced template
 * with a media header becomes sendable.
 */
const setHeaderMedia = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;
    const { mediaId } = req.body || {};
    if (!mediaId || typeof mediaId !== 'string') {
      return errorResponse(res, 400, 'mediaId is required');
    }

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }
    const format = HEADER_MEDIA_TYPE[templateRow.header_type] ? templateRow.header_type : null;
    if (!format) {
      return errorResponse(res, 400, 'This template does not have an image, video or document header');
    }

    // Scoped to this business, so another business's media reads as not found.
    const { data: media, error: mediaErr } = await supabase
      .from('business_media').select('*').eq('id', mediaId).eq('business_id', businessId).maybeSingle();
    if (mediaErr) throw mediaErr;
    if (!media) {
      return errorResponse(res, 404, 'Media not found');
    }

    // business_media keeps no mimetype; r2.uploadImage names the object by it.
    const ext = extensionOf(media.r2_key);
    if (media.media_type !== HEADER_MEDIA_TYPE[format] || (ext && !EXTENSIONS_BY_FORMAT[format].includes(ext))) {
      return errorResponse(res, 400, `This template's header needs ${HEADER_MEDIA_LABEL[format]}; the file you picked is a different type.`);
    }
    if (Number(media.file_size_bytes) > HEADER_MEDIA_MAX_BYTES[format]) {
      return errorResponse(res, 400, `A ${format.toLowerCase()} header can be at most ${HEADER_MEDIA_MAX_BYTES[format] / (1024 * 1024)} MB.`);
    }

    const update = {
      header_media_url: media.url,
      header_media_id: media.id,
      header_media_filename: format === 'DOCUMENT' ? (media.original_filename || null) : null
    };
    const { data: updated, error: updateErr } = await supabase.from('message_templates')
      .update({ ...update, send_support: computeSendSupport({ ...templateRow, ...update }) })
      .eq('id', id).eq('business_id', businessId).select().single();
    if (updateErr) throw updateErr;

    return successResponse(res, 200, { ...toCamelCase(updated), metaDeleted: !!updated.meta_deleted_at }, 'Header media attached');
  } catch (error) {
    logger.error('Error in setHeaderMedia:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates
 * Create a message template as draft
 */
const createMessageTemplate = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { name, category, language, bodyText, variableSamples, headerType, headerImageUrl, headerImageR2Key } = req.body;

    if (!name || !bodyText) {
      return errorResponse(res, 400, 'name and bodyText are required');
    }

    if (!TEMPLATE_NAME_REGEX.test(name)) {
      return errorResponse(res, 400, 'name must be lowercase_snake_case, alphanumeric characters and underscores only');
    }

    if (headerType !== undefined && headerType !== 'NONE' && headerType !== 'IMAGE') {
      return errorResponse(res, 400, "headerType must be 'NONE' or 'IMAGE'");
    }

    if (headerType === 'IMAGE' && !headerImageUrl) {
      return errorResponse(res, 400, 'headerImageUrl is required when headerType is IMAGE');
    }

    const variableCount = countTemplateVariables(bodyText);

    if (variableSamples !== undefined && variableCount > 0) {
      if (!Array.isArray(variableSamples) || variableSamples.length !== variableCount) {
        const placeholders = Array.from({ length: variableCount }, (_, i) => `{{${i + 1}}}`).join(', ');
        return errorResponse(res, 400, `This template has ${variableCount} variables (${placeholders}) - provide exactly ${variableCount} sample values.`);
      }
    }

    const { data: template, error } = await supabase.from('message_templates').insert({
      business_id: businessId,
      name,
      category: category || 'MARKETING',
      language: language || 'en_US',
      body_text: bodyText,
      variable_count: variableCount,
      variable_samples: variableSamples !== undefined ? variableSamples : null,
      header_type: headerType || 'NONE',
      header_image_url: headerType === 'IMAGE' ? headerImageUrl : null,
      header_image_r2_key: headerType === 'IMAGE' ? headerImageR2Key : null
    }).select().single();
    if (error) {
      // uq_msg_templates_business_name_lang_unregistered: one not-yet-submitted
      // template per name + language (the sync adopts by that pair).
      if (error.code === '23505') {
        return errorResponse(res, 400, 'You already have a template with this name and language that has not been submitted yet. Submit or delete it first.');
      }
      throw error;
    }

    return successResponse(res, 201, toCamelCase(template), 'Message template created successfully');
  } catch (error) {
    logger.error('Error in createMessageTemplate:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates/upload-header-image
 * Upload a template header image to R2. Does not touch a template row -
 * the returned { url, key } are passed into createMessageTemplate.
 */
const uploadHeaderImage = async (req, res, next) => {
  try {
    if (!req.file) {
      return errorResponse(res, 400, 'No image provided');
    }
    if (!HEADER_IMAGE_TYPES.includes(req.file.mimetype)) {
      return errorResponse(res, 400, 'Header image must be a JPG or PNG.');
    }

    const result = await r2.uploadImage(
      req.file.buffer,
      'template-headers',
      `header-${Date.now()}`,
      req.file.mimetype
    );

    return successResponse(res, 200, { url: result.url, key: result.key });
  } catch (error) {
    logger.error('Error in uploadHeaderImage:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates/:id/submit
 * Submit a draft template to Meta's Template Management API for review
 */
const submitMessageTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: templateRow, error: fetchErr } = await supabase
      .from('message_templates').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }
    const template = toCamelCase(templateRow);

    if (template.status !== 'draft' && template.status !== 'rejected') {
      return errorResponse(res, 400, 'Only draft or rejected templates can be submitted');
    }

    if (template.variableCount > 0 && (!Array.isArray(template.variableSamples) || template.variableSamples.length === 0)) {
      return errorResponse(res, 400, "Add sample values for this template's variables before submitting");
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.wabaId || !business.accessToken) {
      return errorResponse(res, 400, 'Business is not connected to WhatsApp. Please connect WhatsApp first.');
    }

    const accessToken = decrypt(business.accessToken);

    const bodyComponent = { type: 'BODY', text: template.bodyText };
    if (template.variableCount > 0) {
      bodyComponent.example = { body_text: [template.variableSamples] };
    }

    const components = [bodyComponent];

    if (template.headerType === 'IMAGE') {
      try {
        const appAccessToken = `${config.META_APP_ID}|${config.META_APP_SECRET}`;

        const imageResponse = await axios.get(template.headerImageUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(imageResponse.data);
        const fileType = imageResponse.headers['content-type'];

        const sessionResponse = await axios.post(
          `${META_API_BASE}/${config.META_APP_ID}/uploads`,
          null,
          { params: { file_length: fileBuffer.length, file_type: fileType, access_token: appAccessToken } }
        );
        const uploadSessionId = sessionResponse.data.id;

        const handleResponse = await axios.post(
          `${META_API_BASE}/${uploadSessionId}`,
          fileBuffer,
          {
            headers: {
              Authorization: `OAuth ${appAccessToken}`,
              file_offset: '0'
            }
          }
        );
        const headerHandle = handleResponse.data.h;

        components.unshift({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [headerHandle] } });
      } catch (error) {
        logger.error('Error uploading header image to Meta:', {
          businessId,
          templateId: id,
          error: error.response?.data || error.message
        });
        return errorResponse(res, 400, 'Failed to upload header image to Meta', error.response?.data || error.message);
      }
    }

    let metaResponse;
    try {
      const response = await axios.post(
        `${META_API_BASE}/${business.wabaId}/message_templates`,
        {
          name: template.name,
          category: template.category,
          language: template.language,
          components
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      metaResponse = response.data;
    } catch (error) {
      logger.error('Error submitting message template to Meta:', {
        businessId,
        templateId: id,
        error: error.response?.data || error.message
      });
      return errorResponse(res, 400, 'Failed to submit template to Meta', error.response?.data || error.message);
    }

    const { data: updatedTemplate, error: updateErr } = await supabase.from('message_templates').update({
      meta_template_id: metaResponse.id,
      status: 'pending',
      submitted_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (updateErr) throw updateErr;

    logger.info('Message template submitted to Meta successfully', {
      businessId,
      templateId: id,
      metaTemplateId: metaResponse.id
    });

    return successResponse(res, 200, toCamelCase(updatedTemplate), 'Template submitted to Meta for review');
  } catch (error) {
    logger.error('Error in submitMessageTemplate:', error);
    next(error);
  }
};

/**
 * DELETE /api/message-templates/:id
 * Delete a template. Only allowed while draft or rejected (not yet registered
 * with Meta, or Meta already rejected it) - pending/approved/paused/disabled
 * templates are registered with Meta and require contacting support to remove.
 */
const deleteMessageTemplate = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: template, error: fetchErr } = await supabase
      .from('message_templates').select('status, header_image_r2_key').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!template) {
      return errorResponse(res, 404, 'Message template not found');
    }

    if (['pending', 'approved', 'paused', 'disabled'].includes(template.status)) {
      return errorResponse(res, 400, 'This template is registered with Meta. Please contact support to remove it.');
    }

    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    if (error) throw error;

    if (template.header_image_r2_key) {
      try {
        await r2.deleteImage(template.header_image_r2_key);
      } catch (r2Err) {
        logger.error('Failed to delete header image from R2 after template delete:', {
          templateId: id,
          key: template.header_image_r2_key,
          error: r2Err.message
        });
      }
    }

    return successResponse(res, 200, null, 'Message template deleted successfully');
  } catch (error) {
    logger.error('Error in deleteMessageTemplate:', error);
    next(error);
  }
};

module.exports = {
  getMessageTemplates,
  syncMessageTemplates,
  setHeaderMedia,
  createMessageTemplate,
  uploadHeaderImage,
  submitMessageTemplate,
  deleteMessageTemplate
};
