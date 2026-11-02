// The text sent when a booking chat ends for inactivity (queues/sessionTimeout.worker.js). Every business gets the
// built-in `sessionTimeout` ("... Send 'book' anytime to start again") except a chat that was in a travel-quote flow:
// there 'book' is the wrong word (it can open the web booking form), so the text names the keyword that starts THAT
// flow - read from the flow's entry trigger node (a reply node of kind booking_trigger that leads to the entry question).
// Light on purpose (supabase + pure helpers only): the worker loads it at start-up.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const { quoteFlowEntry } = require('../utils/quoteChat');
const { getSystemMessage } = require('../utils/systemMessages');

/**
 * The keyword that starts the quote flow `nodeId` (the session's current question) belongs to, or null when the
 * business has no quote flow (one cheap query and done), the node is in another flow, or the trigger has no keyword.
 * A "manual sibling" question ("Type the pickup time") has no edge into it, so the flow is also looked up from the
 * session's `ruleId`: the trigger node it started from, or the entry question a "Change" restarted at.
 */
const getQuoteKeyword = async (businessId, nodeId, ruleId = null) => {
  if (!nodeId) return null;
  const { data: pickers, error } = await supabase.from('flow_nodes').select('id')
    .eq('business_id', businessId).eq('node_type', 'route_picker').eq('is_active', true).limit(1);
  if (error) throw error;
  if (!pickers || pickers.length === 0) return null;

  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from('flow_nodes').select('id, node_type, reply_kind, keyword').eq('business_id', businessId),
    supabase.from('flow_edges').select('from_node_id, to_node_id').eq('business_id', businessId)
  ]);
  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;
  const nodes = (nodesRes.data || []).map(toCamelCase);
  const edges = (edgesRes.data || []).map(toCamelCase);

  const keywordOf = (n) => (n && n.nodeType === 'reply' && n.replyKind === 'booking_trigger' && typeof n.keyword === 'string' && n.keyword.trim() !== ''
    ? n.keyword.trim() : null);
  const entryKeyword = (entry) => {
    const into = new Set(edges.filter((e) => e.toNodeId === entry).map((e) => e.fromNodeId));
    for (const n of nodes) if (into.has(n.id) && keywordOf(n)) return keywordOf(n);
    return null;
  };

  const entry = quoteFlowEntry(nodes, edges, nodeId);
  if (entry) return entryKeyword(entry);
  if (!ruleId) return null;
  const ruleNode = nodes.find((n) => n.id === ruleId);
  if (!ruleNode) return null;
  if (ruleNode.nodeType !== 'reply') {
    const ruleEntry = quoteFlowEntry(nodes, edges, ruleId);
    return ruleEntry ? entryKeyword(ruleEntry) : null;
  }
  // the trigger itself: its keyword when it leads to the entry of a quote flow
  const leadsToQuote = edges.some((e) => e.fromNodeId === ruleId && quoteFlowEntry(nodes, edges, e.toNodeId) === e.toNodeId);
  return leadsToQuote ? keywordOf(ruleNode) : null;
};

/**
 * The inactivity message for an ended session. The quote wording exists in en / hi / mr; a machine-translated
 * language would get the English quote text (its own `sessionTimeout` text has the keyword translated into a
 * word of its language), which still names the right keyword. Never throws: any failure gives the built-in text.
 * @param {string} businessId
 * @param {Object} session  the booking session (currentNodeId)
 * @param {string|null|undefined} languageCode
 */
const sessionTimeoutText = async (businessId, session, languageCode) => {
  try {
    const keyword = await getQuoteKeyword(businessId, session && session.currentNodeId, session && session.ruleId);
    if (keyword) return getSystemMessage('sessionTimeoutQuote', languageCode, { keyword });
  } catch (error) {
    logger.error('Session timeout: could not check for a quote flow, using the standard text:', { businessId, message: error.message });
  }
  return getSystemMessage('sessionTimeout', languageCode);
};

module.exports = { getQuoteKeyword, sessionTimeoutText };
