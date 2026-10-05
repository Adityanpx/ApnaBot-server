// The business's Free demo reminder template (utils/demoReminder.js
// REMINDER_TEMPLATE) — looked up by demoReminder.service.js when sending,
// created + submitted to Meta by botSettings.service.js on Publish. Kept
// apart from demoReminder.service.js so Bot Builder code doesn't load the
// reminder queue (Redis).
const supabase = require('../config/supabase');
const businessService = require('./business.service');
const { submitTemplateToMeta } = require('./templateSubmit.service');
const { REMINDER_TEMPLATE } = require('../utils/demoReminder');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const getReminderTemplate = async (businessId) => {
  const { data, error } = await supabase
    .from('message_templates').select('*')
    .eq('business_id', businessId).eq('name', REMINDER_TEMPLATE.name).maybeSingle();
  if (error) throw error;
  return data;
};

/**
 * Creates the reminder template for this business and submits it to Meta,
 * unless it was already submitted (a rejected one is left for the owner —
 * Meta keeps a rejected name, so fixing it is a Templates-page job).
 * Goes through the same submit as messageTemplate.controller.js
 * (templateSubmit.service.js), body-only. @returns {Promise<Object>} the template row
 */
const ensureReminderTemplate = async (businessId) => {
  const existing = await getReminderTemplate(businessId);
  if (existing && existing.status !== 'draft') return existing;

  const business = await businessService.getBusinessById(businessId);
  if (!business || !business.wabaId || !business.accessToken) {
    throw new Error('WhatsApp is not connected');
  }

  let row = existing;
  if (!row) {
    const { data, error } = await supabase.from('message_templates').insert({
      business_id: businessId,
      name: REMINDER_TEMPLATE.name,
      category: REMINDER_TEMPLATE.category,
      language: REMINDER_TEMPLATE.language,
      body_text: REMINDER_TEMPLATE.bodyText,
      variable_count: REMINDER_TEMPLATE.variableSamples.length,
      variable_samples: REMINDER_TEMPLATE.variableSamples,
      header_type: 'NONE'
    }).select().single();
    if (error) throw error;
    row = data;
  }

  const response = await submitTemplateToMeta(business, decrypt(business.accessToken), row);

  const { data: updated, error: updateErr } = await supabase.from('message_templates').update({
    meta_template_id: response.id,
    status: 'pending',
    submitted_at: new Date().toISOString()
  }).eq('id', row.id).select().single();
  if (updateErr) throw updateErr;
  logger.info('Demo reminder template submitted to Meta', { businessId, templateId: row.id });
  return updated;
};

module.exports = { getReminderTemplate, ensureReminderTemplate };
