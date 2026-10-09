const supabase = require('../config/supabase');
const config = require('../config/env');
const { toCamelCase } = require('../utils/caseConvert');
const businessService = require('../services/business.service');
const walletService = require('../services/wallet.service');
const rateCardService = require('../services/rateCard.service');
const { addToBroadcastQueue } = require('../queues/broadcast.queue');
const {
  normalizeAudience, resolveAudience, businessGroupIds, businessCustomerIds, audienceSummary, audienceSkipped, SKIP_REASONS,
  requiresMarketingOptIn, templateCategory
} = require('../services/broadcastAudience.service');
const { getPagination } = require('../utils/pagination');
const { isTemplateUsable, sendSupportBlockReason } = require('../utils/templateStatus');
const { buildTemplateComponents, buildQuickReplyComponents } = require('../utils/templateComponents');
const { requiredParams, splitMapping, checkParamCounts, targetOf } = require('../utils/templateMapping');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');
const { getBroadcastStats } = require('../services/broadcastProgress.service');
const { withRecipientFailure } = require('../utils/whatsappErrors');

// One BullMQ job per this many recipients (whatsapp.queue.js has no
// existing batching precedent to follow, so this is a new, conservative
// default for broadcast fan-out).
const BATCH_SIZE = 50;

const chunk = (arr, size) => {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

// broadcast_recipients rows: one 'queued' row per recipient, made BEFORE the jobs are
// queued so the worker always finds its row. Delivery tracking is secondary to the
// send itself, so a failure here is logged and the send carries on; the worker then
// just skips the per-recipient write for the missing rows. Never throws.
const RECIPIENT_ROW_CHUNK = 500;

const createRecipientRows = async (broadcastId, businessId, customers) => {
  for (const part of chunk(customers, RECIPIENT_ROW_CHUNK)) {
    try {
      const { error } = await supabase.from('broadcast_recipients').upsert(
        part.map((c) => ({ broadcast_id: broadcastId, business_id: businessId, customer_id: c.id, whatsapp_number: c.whatsapp_number })),
        { onConflict: 'broadcast_id,whatsapp_number', ignoreDuplicates: true }
      );
      if (error) logger.error(`Broadcast ${broadcastId}: could not create recipient rows`, error);
    } catch (err) {
      logger.error(`Broadcast ${broadcastId}: could not create recipient rows`, err);
    }
  }
};

// Remove rows of recipients that will never be sent (all of them when the claim is
// released back to a draft, so a re-send doesn't meet stale 'queued' rows).
const removeRecipientRows = async (broadcastId, numbers = null) => {
  try {
    let q = supabase.from('broadcast_recipients').delete().eq('broadcast_id', broadcastId);
    if (numbers) q = q.in('whatsapp_number', numbers);
    const { error } = await q;
    if (error) logger.error(`Broadcast ${broadcastId}: could not remove recipient rows`, error);
  } catch (err) {
    logger.error(`Broadcast ${broadcastId}: could not remove recipient rows`, err);
  }
};

const countTemplateVariables = (bodyText) => {
  const matches = (bodyText || '').match(/\{\{\s*\d+\s*\}\}/g) || [];
  const numbers = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return numbers.size;
};

// Sources a broadcast can fill: a recipient's name or a fixed value. Button
// suffixes are fixed values only (booking.code exists for booking follow-ups).
const HEADER_SOURCES = ['customer.name', 'static'];
const BROADCAST_BUTTON_SOURCES = ['static'];

/**
 * Header / button parameter check for a broadcast's variable_mapping. Null =
 * fine, including every template with only body variables and a mapping with
 * only body entries (their count is checked by the older rule in the callers).
 * A template with a TEXT-header variable or a dynamic URL button needs a
 * mapping that fills them — the shared templateVariables list can't.
 */
const headerButtonMappingError = (templateRow, variableMapping) => {
  const need = requiredParams(templateRow);
  const needsExtras = need.header > 0 || need.buttons.length > 0;
  const parts = splitMapping(variableMapping);
  if (!needsExtras && parts.header.length === 0 && parts.button.length === 0 && parts.unknown.length === 0) return null;
  if (needsExtras && !Array.isArray(variableMapping)) {
    return 'This template has a header variable or a button link variable, so variableMapping is required';
  }
  const countError = checkParamCounts(variableMapping, templateRow);
  if (countError) return countError;
  for (const entry of [...parts.header, ...parts.button]) {
    const allowed = targetOf(entry) === 'header' ? HEADER_SOURCES : BROADCAST_BUTTON_SOURCES;
    if (!allowed.includes(entry.source)) return `A ${targetOf(entry)} variable's source must be one of: ${allowed.join(', ')}`;
    if (entry.source === 'static' && (typeof entry.value !== 'string' || !entry.value.trim())) {
      return `A ${targetOf(entry)} variable with a fixed value needs that value`;
    }
  }
  return null;
};

// Why a send has nobody to go to. A UTILITY template doesn't need marketing
// opt-in (broadcastAudience.service.js), so its messages don't say "opted-in".
const noRecipientsMessage = (audienceFilter, category) => {
  const optedIn = requiresMarketingOptIn(category);
  const messages = {
    coaching_requests: optedIn ? 'No opted-in parents match this audience' : 'No parents who can receive this message match this audience',
    groups: optedIn
      ? 'No opted-in customers in the chosen groups (or the groups were deleted)'
      : 'No customers who can receive this message in the chosen groups (or the groups were deleted)',
    customers: optedIn
      ? 'None of the chosen customers can receive this broadcast (not opted in, opted out, blocked, or no valid WhatsApp number)'
      : 'None of the chosen customers can receive this broadcast (opted out, blocked, or no valid WhatsApp number)',
    segment: optedIn ? 'No opted-in customers match these filters' : 'No customers who can receive this message match these filters'
  };
  return messages[audienceFilter] || (optedIn ? 'No opted-in customers to send this broadcast to' : 'No customers who can receive this message to send this broadcast to');
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
    const { name, templateId, templateVariables, variableMapping, audienceFilter, audienceParams } = req.body;

    if (!name || !templateId) {
      return errorResponse(res, 400, 'name and templateId are required');
    }
    const audience = normalizeAudience(audienceFilter, audienceParams);
    if (audience.error) return errorResponse(res, 400, audience.error);
    if (audience.filter === 'groups') {
      const found = await businessGroupIds(businessId, audience.params.groupIds);
      if (found.length !== audience.params.groupIds.length) {
        return errorResponse(res, 404, 'One or more of the chosen groups were not found');
      }
    }
    if (audience.filter === 'customers') {
      const found = await businessCustomerIds(businessId, audience.params.customerIds);
      if (found.length !== audience.params.customerIds.length) {
        return errorResponse(res, 404, 'One or more of the chosen customers were not found');
      }
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
    if (!isTemplateUsable(templateRow)) {
      return errorResponse(res, 400, `This template can't be used for a broadcast yet: ${sendSupportBlockReason(templateRow)}`);
    }

    const requiredVariableCount = countTemplateVariables(templateRow.body_text);
    if (requiredVariableCount > 0) {
      const providedCount = (templateVariables || []).length;
      const mappingCount = splitMapping(variableMapping).body.length;
      if (providedCount !== requiredVariableCount && mappingCount !== requiredVariableCount) {
        return errorResponse(res, 400, `This template requires ${requiredVariableCount} variable(s); provide templateVariables or variableMapping with exactly ${requiredVariableCount} entr${requiredVariableCount === 1 ? 'y' : 'ies'}`);
      }
    }
    const paramError = headerButtonMappingError(templateRow, variableMapping);
    if (paramError) return errorResponse(res, 400, paramError);

    const { data: broadcast, error } = await supabase.from('broadcasts').insert({
      business_id: businessId,
      template_id: templateId,
      name,
      template_variables: templateVariables || [],
      variable_mapping: variableMapping || null,
      // Only a non-default audience writes these (default = all opted-in customers).
      ...(audience.filter !== 'all_customers' ? { audience_filter: audience.filter, audience_params: audience.params } : {})
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
    if (!isTemplateUsable(templateRow)) {
      return errorResponse(res, 400, `This broadcast's template can't be sent yet: ${sendSupportBlockReason(templateRow)}`);
    }

    const requiredVariableCount = countTemplateVariables(templateRow.body_text);
    if (requiredVariableCount > 0) {
      const providedCount = (broadcastRow.template_variables || []).length;
      const mappingCount = splitMapping(broadcastRow.variable_mapping).body.length;
      if (providedCount !== requiredVariableCount && mappingCount !== requiredVariableCount) {
        return errorResponse(res, 400, `This template requires ${requiredVariableCount} variable(s), but this broadcast has ${providedCount || mappingCount} set. Recreate the broadcast with the correct variables.`);
      }
    }
    // Send-time re-check: the template may have changed (sync) since the draft was made.
    const paramError = headerButtonMappingError(templateRow, broadcastRow.variable_mapping);
    if (paramError) {
      return errorResponse(res, 400, `This broadcast's template has changed since the draft was made: ${paramError}. Recreate the broadcast.`);
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business || !business.isWhatsappConnected || !business.phoneNumberId) {
      return errorResponse(res, 400, 'WhatsApp is not connected to this business');
    }

    // Same audience the recipients preview showed (broadcastAudience.service.js).
    // The category is the stored template's, never the request's.
    const customers = await resolveAudience(businessId, broadcastRow.audience_filter, broadcastRow.audience_params, { category: templateRow.category });

    if (!customers || customers.length === 0) {
      return errorResponse(res, 400, noRecipientsMessage(broadcastRow.audience_filter, templateRow.category));
    }

    const usesCustomerNameMapping = (broadcastRow.variable_mapping || []).some((entry) => entry.source === 'customer.name');
    if (usesCustomerNameMapping) {
      const missingNameCount = customers.filter((c) => !c.name || !c.name.trim()).length;
      if (missingNameCount > 0) {
        return errorResponse(res, 400, `${missingNameCount} of ${customers.length} eligible recipients have no name on file, which this broadcast's template variable mapping requires. Update their customer records or change the variable mapping before sending.`);
      }
    }

    // Configurable safety ceiling, not tied to any real Meta or infrastructure
    // limit - the actual constraint is the business's WhatsApp phone number
    // messaging tier (250/1K/10K/100K recipients per 24h based on quality
    // rating), which Meta enforces independently. This is just a guardrail
    // against a single broadcast running away; adjust via MAX_BROADCAST_RECIPIENTS.
    if (customers.length > config.MAX_BROADCAST_RECIPIENTS) {
      return errorResponse(res, 400, `This broadcast has ${customers.length} eligible recipients, which exceeds the current limit of ${config.MAX_BROADCAST_RECIPIENTS}. Contact support to send larger broadcasts.`);
    }

    // India-only for now — the rate_cards table only has IN rows today;
    // this hardcode goes away once other countries are seeded.
    const countryCode = 'IN';
    const category = templateRow.category.toLowerCase();
    const ratePerMessage = await rateCardService.getRateForMessage(countryCode, category);
    const estimatedCostPaise = ratePerMessage * customers.length;

    // Claim the draft atomically BEFORE any money moves: only one of several
    // concurrent sends (double click, two tabs) gets the row back; the rest
    // are told it's already going out, with nothing debited or queued.
    const { data: updatedBroadcast, error: claimErr } = await supabase.from('broadcasts').update({
      total_recipients: customers.length,
      status: 'sending',
      started_at: new Date().toISOString()
    }).eq('id', id).eq('business_id', businessId).eq('status', 'draft').select().maybeSingle();
    if (claimErr) throw claimErr;
    if (!updatedBroadcast) {
      return errorResponse(res, 409, 'This broadcast is already being sent');
    }

    // Passed to the worker so it refunds failed sends only when this debit
    // actually happened.
    const billed = config.WALLET_BILLING_ENABLED && estimatedCostPaise > 0;
    let debited = false;
    const refund = async (amountPaise, notes) => {
      if (!debited || amountPaise <= 0) return;
      try {
        await walletService.refundToWallet(businessId, amountPaise, id, notes);
      } catch (refundErr) {
        logger.error(`Broadcast ${id}: failed to refund ${amountPaise} paise`, refundErr);
      }
    };
    // Back to a draft the owner can send again. Only a claim that never
    // reached the queue is released (see below for a partly queued one).
    const releaseClaim = async () => {
      await removeRecipientRows(id);
      const { error: releaseErr } = await supabase.from('broadcasts')
        .update({ status: 'draft', started_at: null, total_recipients: 0 })
        .eq('id', id).eq('business_id', businessId).eq('status', 'sending');
      if (releaseErr) logger.error(`Broadcast ${id}: failed to put it back to draft`, releaseErr);
    };

    let batches;
    try {
      if (billed) {
        try {
          await walletService.debitWallet(
            businessId,
            estimatedCostPaise,
            id,
            `Broadcast ${id}: ${customers.length} × ${category} message(s) @ ₹${(ratePerMessage / 100).toFixed(2)}`
          );
          debited = true;
        } catch (debitErr) {
          if (debitErr.message && debitErr.message.includes('Insufficient wallet balance')) {
            const wallet = await walletService.getOrCreateWallet(businessId);
            await releaseClaim();
            return errorResponse(res, 400, `Insufficient wallet balance: need ₹${(estimatedCostPaise / 100).toFixed(2)}, have ₹${(wallet.balance_paise / 100).toFixed(2)}`);
          }
          throw debitErr;
        }
      }

      const templateVariables = broadcastRow.template_variables || [];
      const components = buildTemplateComponents(templateRow, { body: templateVariables });
      batches = chunk(customers, BATCH_SIZE).map((batch) => ({
        recipients: batch,
        job: {
          broadcastId: id,
          businessId: businessId.toString(),
          phoneNumberId: business.phoneNumberId,
          encryptedAccessToken: business.accessToken,
          templateName: templateRow.name,
          language: templateRow.language,
          components,
          // The worker rebuilds components per recipient when there is a variable
          // mapping (no template row there), so the quick-reply payloads ride along.
          quickReplyComponents: buildQuickReplyComponents(templateRow),
          variableMapping: broadcastRow.variable_mapping || null,
          ratePerMessage,
          billed,
          recipients: batch.map((c) => ({ customerId: c.id, whatsappNumber: c.whatsapp_number, customer: { name: c.name } }))
        }
      }));
    } catch (setupErr) {
      // Failed after the claim, before anything was queued.
      await refund(estimatedCostPaise, `Refund: broadcast ${id} could not be started`);
      await releaseClaim();
      throw setupErr;
    }

    await createRecipientRows(id, businessId, customers);

    const results = await Promise.allSettled(batches.map((b) => addToBroadcastQueue(b.job)));
    const failedBatches = batches.filter((_, i) => results[i].status === 'rejected');
    if (failedBatches.length === batches.length) {
      // Nothing reached the queue: undo the debit and the claim.
      logger.error(`Broadcast ${id}: could not be queued`, results[0].reason);
      await refund(estimatedCostPaise, `Refund: broadcast ${id} could not be queued`);
      await releaseClaim();
      return errorResponse(res, 500, 'Could not start this broadcast. Nothing was sent or charged. Try again.');
    }
    if (failedBatches.length > 0) {
      // Some batches are already with the worker and will send, so the draft
      // can't be released (a retry would message them twice). Count only what
      // was queued and refund the rest.
      const lost = failedBatches.reduce((n, b) => n + b.recipients.length, 0);
      logger.error(`Broadcast ${id}: ${failedBatches.length} of ${batches.length} batches could not be queued (${lost} recipients)`);
      await refund(ratePerMessage * lost, `Refund: ${lost} broadcast ${id} message(s) could not be queued`);
      await removeRecipientRows(id, failedBatches.flatMap((b) => b.recipients.map((c) => c.whatsapp_number)));
      const { error: totalErr } = await supabase.from('broadcasts')
        .update({ total_recipients: customers.length - lost }).eq('id', id).eq('business_id', businessId);
      if (totalErr) logger.error(`Broadcast ${id}: failed to lower total_recipients by ${lost}`, totalErr);
      updatedBroadcast.total_recipients = customers.length - lost;
    }

    logger.info(`Broadcast ${id} queued: ${customers.length} recipients across ${batches.length} batches`);
    return successResponse(res, 200, toCamelCase(updatedBroadcast), 'Broadcast is sending');
  } catch (error) {
    logger.error('Error in sendBroadcast:', error);
    next(error);
  }
};

/**
 * GET /api/broadcasts/:id/recipients-preview
 * Preview the opted-in audience a draft broadcast would send to, without
 * actually sending: total eligible count, a small sample, and a
 * missing-name warning if the template's variable mapping needs it.
 */
const getBroadcastRecipientsPreview = async (req, res, next) => {
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
      return errorResponse(res, 400, 'Only draft broadcasts can be previewed');
    }

    const category = await templateCategory(businessId, broadcastRow.template_id);
    const eligibleCustomers = await resolveAudience(businessId, broadcastRow.audience_filter, broadcastRow.audience_params, { category });

    const result = {
      totalCount: eligibleCustomers.length,
      preview: eligibleCustomers.slice(0, 20).map((c) => ({
        id: c.id,
        name: c.name,
        whatsappNumber: c.whatsapp_number
      }))
    };

    const usesCustomerNameMapping = (broadcastRow.variable_mapping || []).some((entry) => entry.source === 'customer.name');
    if (usesCustomerNameMapping) {
      result.missingNameCount = eligibleCustomers.filter((c) => !c.name || !c.name.trim()).length;
    }

    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in getBroadcastRecipientsPreview:', error);
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

    // `stats` is the delivery picture (queued / sent / delivered / read / failed);
    // sentCount / failedCount stay exactly as the worker counted them.
    const stats = await getBroadcastStats(businessId, id, broadcast);
    return successResponse(res, 200, { ...toCamelCase(broadcast), stats });
  } catch (error) {
    logger.error('Error in getBroadcast:', error);
    next(error);
  }
};

const RECIPIENT_STATUS_FILTERS = ['queued', 'sent', 'delivered', 'read', 'failed'];
const RECIPIENTS_MAX_LIMIT = 100;

/**
 * GET /api/broadcasts/:id/recipients?status=&page=1&limit=50 (owner / superadmin)
 * → { recipients: [{ id, customerId, name, whatsappNumber, status, sentAt, deliveredAt,
 * readAt, failedAt, failure }], pagination }. `status` uses the same meaning as the
 * stats: sent = accepted by Meta (even if it failed later), delivered includes read,
 * failed = rejected at send time or failed afterwards, queued = not handled yet.
 * `failure` is null unless the recipient failed. A broadcast sent before delivery
 * tracking has no rows, so the list is empty.
 */
const getBroadcastRecipients = async (req, res, next) => {
  try {
    const { id } = req.params;
    const businessId = req.user.businessId;
    const { status } = req.query;
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);

    if (status !== undefined && !RECIPIENT_STATUS_FILTERS.includes(status)) {
      return errorResponse(res, 400, `status must be one of: ${RECIPIENT_STATUS_FILTERS.join(', ')}`);
    }
    if (!Number.isInteger(page) || page < 1) return errorResponse(res, 400, 'page must be a whole number from 1');
    if (!Number.isInteger(limit) || limit < 1 || limit > RECIPIENTS_MAX_LIMIT) {
      return errorResponse(res, 400, `limit must be a whole number from 1 to ${RECIPIENTS_MAX_LIMIT}`);
    }

    const { data: broadcast, error: broadcastErr } = await supabase
      .from('broadcasts').select('id').eq('id', id).eq('business_id', businessId).maybeSingle();
    if (broadcastErr) throw broadcastErr;
    if (!broadcast) return errorResponse(res, 404, 'Broadcast not found');

    let query = supabase.from('broadcast_recipients')
      .select('id, customer_id, whatsapp_number, status, sent_at, delivered_at, read_at, failed_at, error_code, error_title, error_details, customers(name)', { count: 'exact' })
      .eq('broadcast_id', id).eq('business_id', businessId);
    if (status === 'queued' || status === 'failed') query = query.eq('status', status);
    else if (status === 'sent') query = query.not('sent_at', 'is', null);
    else if (status === 'delivered') query = query.not('delivered_at', 'is', null);
    else if (status === 'read') query = query.not('read_at', 'is', null);

    const { data, error, count } = await query
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range((page - 1) * limit, page * limit - 1);
    if (error) throw error;

    const recipients = (data || []).map(({ customers, ...row }) => withRecipientFailure({ ...toCamelCase(row), name: (customers && customers.name) || null }));
    return successResponse(res, 200, { recipients, pagination: getPagination(count || 0, page, limit) });
  } catch (error) {
    logger.error('Error in getBroadcastRecipients:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts/audience-count
 * Body: { audienceFilter?, audienceParams?, templateId? } — how many customers an
 * audience reaches, for the "New broadcast" form before a draft exists. With
 * templateId (this business's template) a UTILITY template doesn't need opt-in;
 * without it, or for an unknown id, the opted-in marketing rule applies.
 */
const getAudienceCount = async (req, res, next) => {
  try {
    const { audienceFilter, audienceParams, templateId } = req.body || {};
    const audience = normalizeAudience(audienceFilter, audienceParams);
    if (audience.error) return errorResponse(res, 400, audience.error);
    const category = await templateCategory(req.user.businessId, templateId);
    const customers = await resolveAudience(req.user.businessId, audience.filter, audience.params, { category });
    return successResponse(res, 200, { count: customers.length });
  } catch (error) {
    logger.error('Error in getAudienceCount:', error);
    next(error);
  }
};

/**
 * POST /api/broadcasts/audience-summary
 * Body: { audienceFilter?, audienceParams?, templateId? } → { selected, willReceive,
 * skipped: { no_number, blocked, opted_out, not_opted_in }, overCap, cap }.
 * selected = who the audience picks; willReceive = those a send reaches;
 * overCap = willReceive is above MAX_BROADCAST_RECIPIENTS (a send would be refused).
 * templateId as for audience-count: a UTILITY template never skips for not_opted_in.
 */
const getAudienceSummary = async (req, res, next) => {
  try {
    const { audienceFilter, audienceParams, templateId } = req.body || {};
    const audience = normalizeAudience(audienceFilter, audienceParams);
    if (audience.error) return errorResponse(res, 400, audience.error);
    const category = await templateCategory(req.user.businessId, templateId);
    const summary = await audienceSummary(req.user.businessId, audience.filter, audience.params, { category });
    const cap = config.MAX_BROADCAST_RECIPIENTS;
    return successResponse(res, 200, { ...summary, overCap: summary.willReceive > cap, cap });
  } catch (error) {
    logger.error('Error in getAudienceSummary:', error);
    next(error);
  }
};

const SKIPPED_MAX_LIMIT = 100;

/**
 * POST /api/broadcasts/audience-skipped
 * Body: { audienceFilter?, audienceParams?, templateId?, reason?, page? (1), limit? (50, max 100) }
 * → { items: [{ customerId, name, number (masked), reason }], pagination }:
 * the customers the audience selects but a send would skip, A→Z, optionally
 * only for one reason (no_number | blocked | opted_out | not_opted_in).
 * templateId as for audience-count.
 */
const getAudienceSkipped = async (req, res, next) => {
  try {
    const { audienceFilter, audienceParams, templateId, reason, page = 1, limit = 50 } = req.body || {};
    const audience = normalizeAudience(audienceFilter, audienceParams);
    if (audience.error) return errorResponse(res, 400, audience.error);
    if (reason !== undefined && reason !== null && !SKIP_REASONS.includes(reason)) {
      return errorResponse(res, 400, `reason must be one of: ${SKIP_REASONS.join(', ')}`);
    }
    if (!Number.isInteger(page) || page < 1) return errorResponse(res, 400, 'page must be a whole number from 1');
    if (!Number.isInteger(limit) || limit < 1 || limit > SKIPPED_MAX_LIMIT) {
      return errorResponse(res, 400, `limit must be a whole number from 1 to ${SKIPPED_MAX_LIMIT}`);
    }
    const category = await templateCategory(req.user.businessId, templateId);
    const { items, total } = await audienceSkipped(req.user.businessId, audience.filter, audience.params, { reason: reason || null, page, limit, category });
    return successResponse(res, 200, { items, pagination: getPagination(total, page, limit) });
  } catch (error) {
    logger.error('Error in getAudienceSkipped:', error);
    next(error);
  }
};

module.exports = {
  getBroadcasts,
  createBroadcast,
  sendBroadcast,
  getBroadcastRecipientsPreview,
  getBroadcast,
  getBroadcastRecipients,
  getAudienceCount,
  getAudienceSummary,
  getAudienceSkipped
};
