const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const r2 = require('../services/r2.service');
const { decrypt } = require('../utils/crypto');
const templateSyncService = require('../services/templateSync.service');
const { submitTemplateToMeta, TemplateValidationError } = require('../services/templateSubmit.service');
const { computeSendSupport } = require('../utils/templateSendSupport');
const {
  HEADER_TYPES, HEADER_MEDIA_TYPE, checkBodyVariables, validateName, validateCategory, validateLanguage, validateComponents, validateHeaderMedia
} = require('../utils/templateValidation');
const { buildComponentsFromInput } = require('../utils/templateBuild');
const { buildButtonActions } = require('../utils/templateButtonTap');
const { checkActionNodes } = require('../services/templateButtonTap.service');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// WhatsApp template headers accept JPG and PNG only. The shared uploadSingle
// middleware also allows WebP (business / vehicle images), so the template
// endpoint narrows it here.
const HEADER_IMAGE_TYPES = ['image/jpeg', 'image/png'];

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

    const mediaError = validateHeaderMedia(media, format);
    if (mediaError) {
      return errorResponse(res, 400, mediaError);
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
 * PUT /api/message-templates/:id/button-actions  { actions: [{ index, action }] }
 * Set what ApnaBot does when a customer taps each QUICK_REPLY button of this
 * template (any status, synced templates included). Replaces the template's
 * whole button_actions list: a button left out, or sent with a null action,
 * has none (a tap then acts on the button's text). An action is
 * { type: 'keyword', keyword } | { type: 'node', nodeId } (a reply or question
 * node of this business's flow) | { type: 'menu' } | { type: 'optout' }.
 */
const setButtonActions = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }

    const { buttonActions, error: inputError } = buildButtonActions(templateRow, (req.body || {}).actions);
    if (inputError) {
      return errorResponse(res, 400, inputError);
    }
    const nodeError = await checkActionNodes(businessId, buttonActions);
    if (nodeError) {
      return errorResponse(res, 400, nodeError);
    }

    const { data: updated, error: updateErr } = await supabase.from('message_templates')
      .update({ button_actions: buttonActions.length > 0 ? buttonActions : null })
      .eq('id', id).eq('business_id', businessId).select().single();
    if (updateErr) throw updateErr;

    return successResponse(res, 200, { ...toCamelCase(updated), metaDeleted: !!updated.meta_deleted_at }, 'Button actions saved');
  } catch (error) {
    logger.error('Error in setButtonActions:', error);
    next(error);
  }
};

/**
 * POST /api/message-templates
 * Create a message template as draft.
 *   { name, category?, language? (en_US | hi | mr), bodyText, variableSamples?,
 *     header?: { type: NONE|TEXT|IMAGE|VIDEO|DOCUMENT, text?, textSample?, mediaId? },
 *     footerText?, buttons?: [{ type: 'URL', text, url, dynamic?, example? } | { type: 'PHONE_NUMBER', text, phone }
 *       | { type: 'QUICK_REPLY', text, action? }] }  (up to 3 buttons; quick replies grouped together)
 * The full components are stored in the same shape as synced templates; a media
 * header's file comes from the business media library (header.mediaId), so the
 * template is sendable as soon as Meta approves it.
 * Old clients' headerType / headerImageUrl / headerImageR2Key still work (IMAGE only).
 */
const createMessageTemplate = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { name, category, language, bodyText, variableSamples, footerText, buttons, headerType, headerImageUrl, headerImageR2Key } = req.body;
    let { header } = req.body;

    if (!name || !bodyText) {
      return errorResponse(res, 400, 'name and bodyText are required');
    }

    const templateCategory = category || 'MARKETING';
    const templateLanguage = language || 'en_US';
    const fieldError = validateName(name) || validateCategory(templateCategory) || validateLanguage(templateLanguage);
    if (fieldError) {
      return errorResponse(res, 400, fieldError);
    }

    // Deprecated header fields (old clients): an IMAGE already uploaded to R2.
    const legacyImage = header === undefined && headerType === 'IMAGE';
    if (header === undefined && headerType !== undefined) {
      if (headerType !== 'NONE' && headerType !== 'IMAGE') {
        return errorResponse(res, 400, "headerType must be 'NONE' or 'IMAGE'");
      }
      if (headerType === 'IMAGE' && !headerImageUrl) {
        return errorResponse(res, 400, 'headerImageUrl is required when headerType is IMAGE');
      }
      header = { type: headerType };
    }
    if (header !== undefined && header !== null && (typeof header !== 'object' || !HEADER_TYPES.includes(header.type))) {
      return errorResponse(res, 400, `header.type must be one of: ${HEADER_TYPES.join(', ')}`);
    }

    // A media header takes its file from the business media library.
    let media = null;
    if (header && HEADER_MEDIA_TYPE[header.type] && !legacyImage) {
      if (!header.mediaId || typeof header.mediaId !== 'string') {
        return errorResponse(res, 400, `header.mediaId is required for a ${header.type} header`);
      }
      // Scoped to this business, so another business's media reads as not found.
      const { data, error: mediaErr } = await supabase
        .from('business_media').select('*').eq('id', header.mediaId).eq('business_id', businessId).maybeSingle();
      if (mediaErr) throw mediaErr;
      if (!data) {
        return errorResponse(res, 404, 'Media not found');
      }
      const mediaError = validateHeaderMedia(data, header.type);
      if (mediaError) {
        return errorResponse(res, 400, mediaError);
      }
      media = data;
    }

    const { components, errors: shapeErrors, buttonActions } = buildComponentsFromInput({ header, bodyText, variableSamples, footerText, buttons });
    const errors = [...shapeErrors, ...validateComponents(components)];
    if (errors.length > 0) {
      return errorResponse(res, 400, errors[0], errors);
    }
    const nodeError = await checkActionNodes(businessId, buttonActions);
    if (nodeError) {
      return errorResponse(res, 400, nodeError);
    }

    const row = {
      business_id: businessId,
      name,
      category: templateCategory,
      language: templateLanguage,
      body_text: bodyText,
      variable_count: checkBodyVariables(bodyText).count,
      variable_samples: variableSamples !== undefined ? variableSamples : null,
      header_type: header && header.type ? header.type : 'NONE',
      header_image_url: legacyImage ? headerImageUrl : null,
      header_image_r2_key: legacyImage ? headerImageR2Key : null,
      header_media_url: media ? media.url : null,
      header_media_id: media ? media.id : null,
      header_media_filename: media && header.type === 'DOCUMENT' ? (media.original_filename || null) : null,
      meta_components: components,
      ...(buttonActions.length > 0 ? { button_actions: buttonActions } : {})
    };
    row.send_support = computeSendSupport(row);

    const { data: template, error } = await supabase.from('message_templates').insert(row).select().single();
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
 * DEPRECATED - kept for old clients; new ones pick a file from the media
 * library and pass header.mediaId to POST /api/message-templates.
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

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.wabaId || !business.accessToken) {
      return errorResponse(res, 400, 'Business is not connected to WhatsApp. Please connect WhatsApp first.');
    }

    let metaResponse;
    try {
      metaResponse = await submitTemplateToMeta(business, decrypt(business.accessToken), templateRow);
    } catch (error) {
      if (error instanceof TemplateValidationError) {
        return errorResponse(res, 400, error.errors[0], error.errors);
      }
      if (error.templateStage) {
        const uploading = error.templateStage === 'upload';
        logger.error(uploading ? 'Error uploading header media to Meta:' : 'Error submitting message template to Meta:', {
          businessId,
          templateId: id,
          error: error.response?.data || error.message
        });
        return errorResponse(res, 400,
          uploading ? 'Failed to upload header media to Meta' : 'Failed to submit template to Meta',
          error.response?.data || error.message);
      }
      throw error;
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
  setButtonActions,
  createMessageTemplate,
  uploadHeaderImage,
  submitMessageTemplate,
  deleteMessageTemplate
};
