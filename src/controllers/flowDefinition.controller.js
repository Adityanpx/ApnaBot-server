const axios = require('axios');
const supabase = require('../config/supabase');
const { successResponse, errorResponse } = require('../utils/response');
const { toCamelCase } = require('../utils/caseConvert');
const businessCategoryService = require('../services/businessCategory.service');
const businessService = require('../services/business.service');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

// Meta's Flow-management endpoints are a different Graph API version from
// whatsapp.service.js's META_API_BASE (v18.0) - hardcoded separately here,
// same as messageTemplate.controller.js's META_UPLOAD_API_BASE.
const META_FLOWS_API_BASE = 'https://graph.facebook.com/v20.0';

/**
 * GET /api/admin/whatsapp-flows
 * List all category_whatsapp_flows rows.
 */
const getWhatsappFlows = async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('category_whatsapp_flows')
      .select('id, category, name, flow_json, created_at, updated_at')
      .order('category', { ascending: true });
    if (error) throw error;

    return successResponse(res, 200, { flows: (data || []).map(toCamelCase) });
  } catch (error) {
    logger.error('Error in getWhatsappFlows:', error);
    next(error);
  }
};

/**
 * POST /api/admin/whatsapp-flows
 * Body: { category, name, flowJson }
 */
const createWhatsappFlow = async (req, res, next) => {
  try {
    const { category, name, flowJson } = req.body;

    if (!category || !(await businessCategoryService.isKnownCategory(category))) {
      return errorResponse(res, 400, `Invalid category: ${category}`);
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return errorResponse(res, 400, 'name is required');
    }
    if (!flowJson || typeof flowJson !== 'object' || Array.isArray(flowJson)) {
      return errorResponse(res, 400, 'flowJson is required and must be an object');
    }

    const { data: flow, error } = await supabase.from('category_whatsapp_flows').insert({
      category,
      name: name.trim(),
      flow_json: flowJson
    }).select('id, category, name, flow_json, created_at, updated_at').single();
    if (error) throw error;

    return successResponse(res, 201, toCamelCase(flow));
  } catch (error) {
    logger.error('Error in createWhatsappFlow:', error);
    next(error);
  }
};

/**
 * PUT /api/admin/whatsapp-flows/:id
 * Body: { name?, flowJson? } - category is fixed at creation, not editable here.
 */
const updateWhatsappFlow = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, flowJson } = req.body;

    if (name === undefined && flowJson === undefined) {
      return errorResponse(res, 400, 'Nothing to update - provide name and/or flowJson');
    }
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return errorResponse(res, 400, 'name must be a non-empty string');
    }
    if (flowJson !== undefined && (typeof flowJson !== 'object' || Array.isArray(flowJson) || flowJson === null)) {
      return errorResponse(res, 400, 'flowJson must be an object');
    }

    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (flowJson !== undefined) updates.flow_json = flowJson;

    const { data: flow, error } = await supabase
      .from('category_whatsapp_flows')
      .update(updates)
      .eq('id', id)
      .select('id, category, name, flow_json, created_at, updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!flow) {
      return errorResponse(res, 404, 'WhatsApp Flow definition not found');
    }

    return successResponse(res, 200, toCamelCase(flow));
  } catch (error) {
    logger.error('Error in updateWhatsappFlow:', error);
    next(error);
  }
};

/**
 * DELETE /api/admin/whatsapp-flows/:id
 */
const deleteWhatsappFlow = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: flow, error: findErr } = await supabase
      .from('category_whatsapp_flows').select('id').eq('id', id).maybeSingle();
    if (findErr) throw findErr;
    if (!flow) {
      return errorResponse(res, 404, 'WhatsApp Flow definition not found');
    }

    const { error } = await supabase.from('category_whatsapp_flows').delete().eq('id', id);
    if (error) throw error;

    return successResponse(res, 200, null, 'WhatsApp Flow definition deleted successfully');
  } catch (error) {
    logger.error('Error in deleteWhatsappFlow:', error);
    next(error);
  }
};

/**
 * POST /api/admin/whatsapp-flows/:id/publish-to-business
 * Body: { businessId }
 *
 * Two-step Meta call: create the Flow on the business's WABA, then publish
 * it. If the create succeeds but publish fails, the business is left with
 * whatsapp_flow_id set and whatsapp_flow_status='draft' - a recoverable
 * partial state (the Flow exists on Meta's side, just not published) rather
 * than a rollback, since there's no delete-flow call here. That partial
 * state is reported back as an error so it isn't mistaken for success.
 *
 * Retry guard: if the business is already stuck in that exact partial state
 * FOR THIS SAME DEFINITION (whatsapp_flow_status='draft' and
 * whatsapp_flow_source_id matches this :id), skip the create call and retry
 * only the publish step against the already-created flowId - otherwise a
 * second call after a failed publish would create a second, orphaned draft
 * Flow on the WABA instead of finishing the first one. If the business is in
 * 'draft' for a DIFFERENT definition, that's a separate stuck state this
 * endpoint doesn't resolve - proceeds with a normal create for the
 * definition actually being requested, same as today.
 */
const publishFlowToBusiness = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { businessId } = req.body;

    if (!businessId || typeof businessId !== 'string') {
      return errorResponse(res, 400, 'businessId is required');
    }

    const { data: definitionRow, error: fetchErr } = await supabase
      .from('category_whatsapp_flows').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!definitionRow) {
      return errorResponse(res, 404, 'WhatsApp Flow definition not found');
    }
    const definition = toCamelCase(definitionRow);

    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }
    if (!business.wabaId || !business.accessToken) {
      return errorResponse(res, 400, 'Business is not connected to WhatsApp. Please connect WhatsApp first.');
    }

    const accessToken = decrypt(business.accessToken);

    const resumingStuckDraft = business.whatsappFlowStatus === 'draft'
      && !!business.whatsappFlowId
      && business.whatsappFlowSourceId === definition.id;

    let flowId = resumingStuckDraft ? business.whatsappFlowId : null;

    if (resumingStuckDraft) {
      logger.info('Resuming a previously stuck draft Flow - skipping create, retrying publish only', {
        businessId,
        flowDefinitionId: id,
        flowId
      });
    } else {
      try {
        const createResponse = await axios.post(
          `${META_FLOWS_API_BASE}/${business.wabaId}/flows`,
          {
            name: definition.name,
            categories: ['OTHER'],
            flow_json: JSON.stringify(definition.flowJson)
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        flowId = createResponse.data.id;
      } catch (error) {
        logger.error('Error creating WhatsApp Flow on Meta:', {
          businessId,
          flowDefinitionId: id,
          error: error.response?.data || error.message
        });
        return errorResponse(res, 400, 'Failed to create Flow on Meta', error.response?.data || error.message);
      }

      const { error: updateErr } = await supabase.from('businesses').update({
        whatsapp_flow_id: flowId,
        whatsapp_flow_status: 'draft',
        whatsapp_flow_source_id: definition.id
      }).eq('id', businessId);
      if (updateErr) throw updateErr;
    }

    try {
      await axios.post(
        `${META_FLOWS_API_BASE}/${flowId}/publish`,
        null,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
    } catch (error) {
      logger.error('WhatsApp Flow created but publish step failed - business left in draft state:', {
        businessId,
        flowDefinitionId: id,
        flowId,
        error: error.response?.data || error.message
      });
      return errorResponse(
        res, 400,
        `Flow was created on Meta (id: ${flowId}) but publishing it failed. The business is now stuck with a draft Flow - retry publishing or investigate before this business can use it.`,
        error.response?.data || error.message
      );
    }

    const { data: updatedBusiness, error: publishedUpdateErr } = await supabase.from('businesses').update({
      whatsapp_flow_status: 'published'
    }).eq('id', businessId).select('id, whatsapp_flow_id, whatsapp_flow_status, whatsapp_flow_source_id').single();
    if (publishedUpdateErr) throw publishedUpdateErr;

    logger.info('WhatsApp Flow published to business successfully', {
      businessId,
      flowDefinitionId: id,
      flowId
    });

    return successResponse(res, 200, toCamelCase(updatedBusiness), 'WhatsApp Flow published successfully');
  } catch (error) {
    logger.error('Error in publishFlowToBusiness:', error);
    next(error);
  }
};

module.exports = {
  getWhatsappFlows,
  createWhatsappFlow,
  updateWhatsappFlow,
  deleteWhatsappFlow,
  publishFlowToBusiness
};
