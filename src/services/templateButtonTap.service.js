// Resolves an inbound template quick-reply tap (message type 'button') into
// what the webhook should do. The decision itself is utils/templateButtonTap.js;
// this loads the template the payload names (this business's only - another
// business's payload counts as unknown) and, for a 'node' action, the node.
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { parseTapPayload, decideTap } = require('../utils/templateButtonTap');
const logger = require('../utils/logger');

// A tap can start a booking (question node) or send a reply (reply node).
const TAP_NODE_TYPES = ['reply', 'question'];

const loadTemplate = async (businessId, templateId) => {
  const { data, error } = await supabase
    .from('message_templates').select('id, button_actions').eq('id', templateId).eq('business_id', businessId).maybeSingle();
  if (error) {
    // Includes "column button_actions does not exist" before the migration is
    // applied - the tap then falls back to the button's text.
    logger.error('Button tap: could not load the template, treating the tap as unknown', { businessId, templateId, message: error.message });
    return null;
  }
  return data || null;
};

/** The node a 'node' action points at, if it still exists, belongs to this business and can be entered. */
const loadTapNode = async (businessId, nodeId) => {
  const { data, error } = await supabase
    .from('flow_nodes').select('*').eq('id', nodeId).eq('business_id', businessId).maybeSingle();
  if (error) {
    logger.error('Button tap: could not load the action node', { businessId, nodeId, message: error.message });
    return null;
  }
  if (!data) return null;
  const node = toCamelCase(data);
  if (!TAP_NODE_TYPES.includes(node.nodeType)) return null;
  if (node.nodeType === 'reply' && !node.isActive) return null;
  return node;
};

/**
 * Do the node ids in these button actions exist, belong to this business and
 * can a tap enter them (a reply node or a question node)?
 * @param {string} businessId
 * @param {Array<{ index: number, action: Object }>} buttonActions
 * @returns {Promise<string|null>} owner-readable error, or null
 */
const checkActionNodes = async (businessId, buttonActions) => {
  for (const { index, action } of buttonActions || []) {
    if (action.type !== 'node') continue;
    const { data, error } = await supabase
      .from('flow_nodes').select('id, node_type').eq('id', action.nodeId).eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    if (!data || !TAP_NODE_TYPES.includes(data.node_type)) {
      return 'Button ' + index + ": the chosen flow node was not found - pick a reply node or a question node from this business's flow.";
    }
  }
  return null;
};

/**
 * @param {string} businessId
 * @param {{ payload?: string, text?: string }} button  Meta's message.button
 * @returns {Promise<{ kind: 'optout' } | { kind: 'action', action: Object } | { kind: 'node', node: Object } | { kind: 'text', text: string } | null>}
 */
const resolveButtonTap = async (businessId, button) => {
  const parsed = parseTapPayload(button && button.payload);
  const template = parsed ? await loadTemplate(businessId, parsed.templateId) : null;
  const decision = decideTap({ button, template });

  if (decision && decision.kind === 'action' && decision.action.type === 'node') {
    const node = await loadTapNode(businessId, decision.action.nodeId);
    // A deleted / inactive / foreign node: act on what the button says instead.
    return node ? { kind: 'node', node } : decideTap({ button, template: null });
  }
  return decision;
};

module.exports = { resolveButtonTap, checkActionNodes };
