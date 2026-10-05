// The one place a message_templates row is submitted to Meta
// (POST /{waba}/message_templates): validate, upload the media header through
// Meta's resumable-upload API when there is one, build the payload, post it.
// Used by messageTemplate.controller.js#submitMessageTemplate,
// demoReminderTemplate.service.js and scripts/testTemplateHeaderUpload.js.
//
// Failures are tagged so callers can word them: TemplateValidationError
// (`errors`: owner-readable messages) and Meta/network errors with
// `templateStage` = 'upload' | 'create' (the Meta response is on error.response).
const axios = require('axios');
const config = require('../config/env');
const { META_API_BASE } = require('./whatsapp.service');
const { extensionOf, headerMediaLinkOf } = require('../utils/templateSendSupport');
const { validateName, validateCategory, validateLanguage, validateComponents } = require('../utils/templateValidation');
const { componentsForSubmit, mediaHeaderFormatOf, buildMetaCreatePayload } = require('../utils/templateBuild');

class TemplateValidationError extends Error {
  constructor(errors) {
    super(errors[0]);
    this.name = 'TemplateValidationError';
    this.errors = errors;
  }
}

const MIME_BY_EXTENSION = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', pdf: 'application/pdf' };

/** Everything wrong with `row` for a submit, or []. */
const validateForSubmit = (row) => {
  const errors = [validateName(row.name), validateCategory(row.category), validateLanguage(row.language)].filter(Boolean);
  errors.push(...validateComponents(componentsForSubmit(row), { requireExamples: true }));
  return errors;
};

/**
 * Resumable upload of `url`'s file to Meta, returning the header_handle a
 * template create takes. Authorised with the BUSINESS's token (Meta's docs:
 * the user access token), not the app token.
 * Two steps: POST /{app_id}/uploads starts a session, POST /{session} sends the bytes.
 * @param {{ url: string, accessToken: string, contentType?: string }} args
 * @returns {Promise<string>} the handle
 */
const uploadHeaderHandle = async ({ url, accessToken, contentType }) => {
  const file = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(file.data);
  const fileType = MIME_BY_EXTENSION[extensionOf(url)] || contentType || file.headers['content-type'];

  const session = await axios.post(`${META_API_BASE}/${config.META_APP_ID}/uploads`, null, {
    params: { file_length: buffer.length, file_type: fileType, access_token: accessToken }
  });
  const uploaded = await axios.post(`${META_API_BASE}/${session.data.id}`, buffer, {
    headers: { Authorization: `OAuth ${accessToken}`, file_offset: '0' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  if (!uploaded.data || !uploaded.data.h) throw new Error('Meta did not return a header handle');
  return uploaded.data.h;
};

const tagged = (error, stage) => {
  error.templateStage = stage;
  return error;
};

/**
 * @param {{ wabaId: string }} business
 * @param {string} accessToken  the business's decrypted token
 * @param {Object} row  message_templates row (snake_case)
 * @returns {Promise<Object>} Meta's response ({ id, status, category })
 */
const submitTemplateToMeta = async (business, accessToken, row) => {
  const errors = validateForSubmit(row);
  if (errors.length > 0) throw new TemplateValidationError(errors);

  let headerHandle;
  if (mediaHeaderFormatOf(componentsForSubmit(row))) {
    const url = headerMediaLinkOf(row);
    if (!url) throw new TemplateValidationError(['Attach a header image, video or document before submitting.']);
    try {
      headerHandle = await uploadHeaderHandle({ url, accessToken });
    } catch (error) {
      throw tagged(error, 'upload');
    }
  }

  try {
    const response = await axios.post(
      `${META_API_BASE}/${business.wabaId}/message_templates`,
      buildMetaCreatePayload(row, { headerHandle }),
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    throw tagged(error, 'create');
  }
};

module.exports = { TemplateValidationError, validateForSubmit, uploadHeaderHandle, submitTemplateToMeta };
