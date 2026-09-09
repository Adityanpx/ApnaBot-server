const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const walletService = require('../services/wallet.service');
const rateCardService = require('../services/rateCard.service');
const { addToBroadcastQueue } = require('../queues/broadcast.queue');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

// One BullMQ job per this many recipients (whatsapp.queue.js has no
// existing batching precedent to follow, so this is a new, conservative
// default for broadcast fan-out).
const BATCH_SIZE = 50;

// Temporary safety cap: ApnaBot is flat-fee with no per-message billing yet,
// so an uncapped broadcast could run up uncapped Meta marketing-rate spend.
// Adjust or remove once usage-based billing/wallet limits are in place.
const MAX_BROADCAST_RECIPIENTS = 100;

const chunk = (arr, size) => {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

const countTemplateVariables = (bodyText) => {
  const matches = (bodyText || '').match(/\{\{\s*\d+\s*\}\}/g) || [];
  const numbers = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return numbers.size;
};

/**
 * GET /api/broadcasts
 * List business's broadcasts
 */
const getBroadcasts = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data, error } = await supabase
      .from('broadcasts').select('*').eq('business_id', businessId).order('created_at', { ascending: false });
    if (error) throw error;

    return successResponse(res, 200, { broadcasts: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getBroadcasts:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts
 * Create a broadcast as draft
 */
const createBroadcast = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { name, templateId, templateVariables, variableMapping } = req.body;

    if (!name || !templateId) {
      return errorResponse(res, 400, 'name and templateId are required');
    }

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', templateId).eq('business_id', businessId).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow) {
      return errorResponse(res, 404, 'Message template not found');
    }
    if (templateRow.status !== 'approved') {
      return errorResponse(res, 400, 'Only approved templates can be used for a broadcast');
    }

    const requiredVariableCount = countTemplateVariables(templateRow.body_text);
    if (requiredVariableCount > 0) {
      const providedCount = (templateVariables || []).length;
      const mappingCount = (variableMapping || []).length;
      if (providedCount !== requiredVariableCount && mappingCount !== requiredVariableCount) {
        return errorResponse(res, 400, `This template requires ${requiredVariableCount} variable(s); provide templateVariables or variableMapping with exactly ${requiredVariableCount} entr${requiredVariableCount === 1 ? 'y' : 'ies'}`);
      }
    }

    const { data: broadcast, error } = await supabase.from('broadcasts').insert({
      business_id: businessId,
      template_id: templateId,
      name,
      template_variables: templateVariables || [],
      variable_mapping: variableMapping || null
    }).select().single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(broadcast), 'Broadcast created successfully');
  } catch (error) {
    logger.error('Error in createBroadcast:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts/:id/send
 * Send a draft broadcast: snapshot the opted-in audience, mark the broadcast
 * as sending, and fan the recipient list out across BullMQ jobs. NEVER calls
 * Meta API directly from the controller - broadcast.worker.js does the send.
 */
const sendBroadcast = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: broadcastRow, error: fetchErr } = await supabase
      .from('broadcasts').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!broadcastRow) {
      return errorResponse(res, 404, 'Broadcast not found');
    }
    if (broadcastRow.status !== 'draft') {
      return errorResponse(res, 400, 'Only draft broadcasts can be sent');
    }

    const { data: templateRow, error: templateErr } = await supabase
      .from('message_templates').select('*').eq('id', broadcastRow.template_id).maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow || templateRow.status !== 'approved') {
      return errorResponse(res, 400, 'This broadcast\'s template is no longer approved');
    }

    const requiredVariableCount = countTemplateVariables(templateRow.body_text);
    if (requiredVariableCount > 0) {
      const providedCount = (broadcastRow.template_variables || []).length;
      const mappingCount = (broadcastRow.variable_mapping || []).length;
      if (providedCount !== requiredVariableCount && mappingCount !== requiredVariableCount) {
        return errorResponse(res, 400, `This template requires ${requiredVariableCount} variable(s), but this broadcast has ${providedCount || mappingCount} set. Recreate the broadcast with the correct variables.`);
      }
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.isWhatsappConnected || !business.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this business');
    }

    const { data: customers, error: customersErr } = await supabase
      .from('customers').select('id, whatsapp_number, name')
      .eq('business_id', businessId).eq('opted_in', true).eq('is_blocked', false);
    if (customersErr) throw customersErr;

    if (!customers || customers.length === 0) {
      return errorResponse(res, 400, 'No opted-in customers to send this broadcast to');
    }

    const usesCustomerNameMapping = (broadcastRow.variable_mapping || []).some((entry) => entry.source === 'customer.name');
    if (usesCustomerNameMapping) {
      const missingNameCount = customers.filter((c) => !c.name || !c.name.trim()).length;
      if (missingNameCount > 0) {
        return errorResponse(res, 400, `${missingNameCount} of ${customers.length} eligible recipients have no name on file, which this broadcast's template variable mapping requires. Update their customer records or change the variable mapping before sending.`);
      }
    }

    if (customers.length > MAX_BROADCAST_RECIPIENTS) {
      return errorResponse(res, 400, `This broadcast has ${customers.length} eligible recipients, which exceeds the current limit of ${MAX_BROADCAST_RECIPIENTS}. Contact support to send larger broadcasts.`);
    }

    // India-only for now — the rate_cards table only has IN rows today;
    // this hardcode goes away once other countries are seeded.
    const countryCode = 'IN';
    const category = templateRow.category.toLowerCase();
    const ratePerMessage = await rateCardService.getRateForMessage(countryCode, category);
    const estimatedCostPaise = ratePerMessage * customers.length;

    if (estimatedCostPaise > 0) {
      try {
        await walletService.debitWallet(
          businessId,
          estimatedCostPaise,
          id,
          `Broadcast ${id}: ${customers.length} × ${category} message(s) @ ₹${(ratePerMessage / 100).toFixed(2)}`
        );
      } catch (debitErr) {
        if (debitErr.message && debitErr.message.includes('Insufficient wallet balance')) {
          const wallet = await walletService.getOrCreateWallet(businessId);
          return errorResponse(res, 400, `Insufficient wallet balance: need ₹${(estimatedCostPaise / 100).toFixed(2)}, have ₹${(wallet.balance_paise / 100).toFixed(2)}`);
        }
        throw debitErr;
      }
    }

    const { data: updatedBroadcast, error: updateErr } = await supabase.from('broadcasts').update({
      total_recipients: customers.length,
      status: 'sending',
      started_at: new Date().toISOString()
    }).eq('id', id).select().single();
    if (updateErr) throw updateErr;

    const templateVariables = broadcastRow.template_variables || [];
    const components = templateVariables.length > 0
      ? [{ type: 'body', parameters: templateVariables.map((v) => ({ type: 'text', text: String(v) })) }]
      : [];

    if (templateRow.header_type === 'IMAGE') {
      components.unshift({ type: 'header', parameters: [{ type: 'image', image: { link: templateRow.header_image_url } }] });
    }

    const batches = chunk(customers, BATCH_SIZE);
    await Promise.all(batches.map((batch) => addToBroadcastQueue({
      broadcastId: id,
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      templateName: templateRow.name,
      language: templateRow.language,
      components,
      variableMapping: broadcastRow.variable_mapping || null,
      ratePerMessage,
      recipients: batch.map((c) => ({ customerId: c.id, whatsappNumber: c.whatsapp_number, customer: { name: c.name } }))
    })));

    logger.info(`Broadcast ${id} queued: ${customers.length} recipients across ${batches.length} batches`);
    return successResponse(res, 200, toCamelCase(updatedBroadcast), 'Broadcast is sending');
  } catch (error) {
    logger.error('Error in sendBroadcast:', error);
    next(error);
  }
};

/**
 * GET /api/broadcasts/:id
 * Status + sent_count/failed_count for polling
 */
const getBroadcast = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;

    const { data: broadcast, error } = await supabase
      .from('broadcasts').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    if (!broadcast) {
      return errorResponse(res, 404, 'Broadcast not found');
    }

    return successResponse(res, 200, toCamelCase(broadcast));
  } catch (error) {
    logger.error('Error in getBroadcast:', error);
    next(error);
  }
};

module.exports = {
  getBroadcasts,
  createBroadcast,
  sendBroadcast,
  getBroadcast
};
