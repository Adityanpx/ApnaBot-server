const { distance } = require('fastest-levenshtein');
const supabase = require('../config/supabase');
const redis = require('../config/redis');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const {
  normalizeLegacy, normalizeUnicode, hasNonAsciiLetter, isMixedScript, asciiProjection,
  codePointDistance, nativeFuzzyThreshold, indexOfAtBoundary
} = require('../utils/textNormalize');
const { isUnicodeMatchingEnabled } = require('./unicodeMatching.service');

/**
 * Adaptive edit-distance threshold for fuzzy keyword matching, scaled to
 * keyword length so short keywords (e.g. "hi") don't fuzzy-match everything.
 * @param {number} keywordLength
 * @returns {number}
 */
const fuzzyThresholdFor = (keywordLength) => {
  if (keywordLength <= 5) return 1;
  if (keywordLength <= 10) return 2;
  return 3;
};

/**
 * Get reply-trigger flow nodes from cache or DB
 * @param {string} businessId - The business ID
 * @returns {Promise<Array>}
 */
const getRulesFromCache = async (businessId) => {
  const cacheKey = `flow:${businessId}`;

  try {
    // Try cache first
    const cachedNodes = await redis.get(cacheKey);
    if (cachedNodes) {
      return JSON.parse(cachedNodes);
    }

    // Cache miss - query DB
    const { data, error } = await supabase
      .from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
    if (error) throw error;
    const nodes = (data || []).map(toCamelCase);

    // Store in Redis with 1 hour TTL
    await redis.set(cacheKey, JSON.stringify(nodes), 'EX', 3600);

    return nodes;
  } catch (error) {
    logger.error('Error in getRulesFromCache:', error);
    // On error, try to fetch from DB directly
    const { data } = await supabase
      .from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
    return (data || []).map(toCamelCase);
  }
};

/**
 * Invalidate the reply-trigger flow node cache
 * @param {string} businessId - The business ID
 */
const invalidateRulesCache = async (businessId) => {
  const cacheKey = `flow:${businessId}`;

  try {
    await redis.del(cacheKey);
    logger.info(`Rules cache invalidated for business ${businessId}`);
  } catch (error) {
    logger.error('Error in invalidateRulesCache:', error);
  }
};

/**
 * Normalize text for matching
 * @param {string} text - Input text
 * @returns {string}
 */
const normalizeText = normalizeLegacy;

/**
 * Fire-and-forget trigger_count increment via RPC (atomic on the DB side,
 * unlike a read-then-write). See supabase/migrations for
 * increment_flow_node_trigger_count.
 * @param {string} nodeId
 */
const incrementTriggerCount = (nodeId) => {
  supabase.rpc('increment_flow_node_trigger_count', { node_id: nodeId })
    .then(({ error }) => {
      if (error) logger.error('Error incrementing trigger count:', error);
    })
    .catch(err => logger.error('Error incrementing trigger count:', err));
};

/**
 * Fetch a reply node's outgoing button/list edges, live (not cached — see
 * findMatchingRule). Each edge is annotated with `nextKeyword` = edge.id —
 * the field name is a holdover from the old keyword-text-based id scheme
 * (whatsapp.service.js/webhook.controller.js still read `.nextKeyword`, not
 * renamed here to keep this fix's diff minimal) but the value is now
 * unconditionally the edge's own id, regardless of what it targets. A
 * reply-node edge targeting another reply node, or one targeting a
 * question node directly (a button that starts a booking), both get a
 * working WhatsApp interaction id this way — the id only needs to be
 * unique and round-trippable, not tied to the target's node type.
 * Resolution back to whatever the edge points at happens on the inbound
 * side (see resolveTappedEdge / webhook.controller.js Step 13).
 * @param {string} nodeId - the matched reply node's id (from_node_id)
 * @returns {Promise<Array>}
 */
const getOutgoingEdges = async (nodeId) => {
  const { data, error } = await supabase
    .from('flow_edges').select('*').eq('from_node_id', nodeId)
    .order('display_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    logger.error('Error fetching outgoing flow edges:', error);
    return [];
  }

  return (data || []).map(toCamelCase).map(edge => ({ ...edge, nextKeyword: edge.id }));
};

const EDGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a tapped WhatsApp interaction id back to the flow_edges row and
 * target flow_nodes row it came from, for the inbound side of the
 * edge-id-based scheme getOutgoingEdges builds. Returns null (not an
 * error) for anything that isn't a live edge on this business — most
 * commonly a stale tap on a button delivered before this scheme shipped
 * (its id is the old keyword text, not a UUID, so it's rejected before
 * even querying) or a tap on an edge that's since been deleted/retargeted;
 * callers should treat null the same as "no match" and fall back to
 * keyword matching.
 * @param {string} businessId
 * @param {string} edgeId
 * @returns {Promise<{edge: Object, targetNode: Object}|null>}
 */
const resolveTappedEdge = async (businessId, edgeId) => {
  if (!EDGE_ID_PATTERN.test(edgeId)) {
    return null;
  }

  const { data: edgeRow, error: edgeError } = await supabase
    .from('flow_edges').select('*').eq('id', edgeId).eq('business_id', businessId).maybeSingle();
  if (edgeError) {
    logger.error('Error resolving tapped flow_edges row:', edgeError);
    return null;
  }
  if (!edgeRow) return null;

  const edge = toCamelCase(edgeRow);
  const { data: nodeRow, error: nodeError } = await supabase
    .from('flow_nodes').select('*').eq('id', edge.toNodeId).eq('business_id', businessId).maybeSingle();
  if (nodeError) {
    logger.error('Error resolving tapped edge target node:', nodeError);
    return null;
  }
  if (!nodeRow) return null;

  return { edge, targetNode: toCamelCase(nodeRow) };
};

/**
 * A quick-reply tap on a carousel card, if `payload` is one. Meta documents the tap of a card button
 * nowhere; if it ever arrives as a message of type 'button' (like a template quick-reply) instead of an
 * interactive button_reply, its payload is the id we sent: the flow edge's id. Claimed ONLY when the
 * payload is a UUID that is an edge of THIS business whose from-node is a carousel reply, so template
 * quick-reply and opt-out taps (opaque payloads of their own) are never touched.
 * @param {string} businessId
 * @param {*} payload  message.button.payload
 * @returns {Promise<string|null>} the edge id, or null when this is not a carousel tap
 */
const resolveCarouselTap = async (businessId, payload) => {
  if (typeof payload !== 'string' || !EDGE_ID_PATTERN.test(payload)) return null;
  const resolved = await resolveTappedEdge(businessId, payload);
  if (!resolved) return null;
  const { data: parent, error } = await supabase
    .from('flow_nodes').select('content_type').eq('id', resolved.edge.fromNodeId).eq('business_id', businessId).maybeSingle();
  if (error) {
    logger.error('Error resolving carousel tap parent node:', error);
    return null;
  }
  return parent && parent.content_type === 'carousel' ? payload : null;
};

/**
 * The passes, run against one already-normalized message. `unicode` only changes three things for
 * keywords that contain non-ASCII letters (native script): a startsWith/contains hit must not end
 * mid-grapheme (next char a combining mark), fuzzy distance is on code points, and fuzzy has the
 * native thresholds (off below 6 code points). ASCII keywords behave exactly as before in both modes.
 */
const runPasses = (activeNodes, normalizedText, { norm, unicode }) => {
  const native = (kw) => unicode && hasNonAsciiLetter(kw);
  const startsWithKw = (kw) => {
    if (!normalizedText.startsWith(kw)) return false;
    if (!native(kw)) return true;
    const next = normalizedText.codePointAt(kw.length);
    return next === undefined || !/\p{M}/u.test(String.fromCodePoint(next));
  };
  const containsKw = (kw) => (native(kw) ? indexOfAtBoundary(normalizedText, kw) !== -1 : normalizedText.includes(kw));

  // Pass 1 - Exact match
  let matchedNode = activeNodes.find(node =>
    node.matchType === 'exact' && norm(node.keyword) === normalizedText
  );

  // Pass 2 - Starts with match
  if (!matchedNode) {
    matchedNode = activeNodes.find(node => {
      const normalizedKeyword = norm(node.keyword);
      return node.matchType === 'startsWith' && normalizedKeyword && startsWithKw(normalizedKeyword);
    });
  }

  // Pass 3 - Contains match
  if (!matchedNode) {
    matchedNode = activeNodes.find(node => {
      const normalizedKeyword = norm(node.keyword);
      return node.matchType === 'contains' && normalizedKeyword && containsKw(normalizedKeyword);
    });
  }

  // Pass 4 - Hindi/Hinglish alias match (last resort, after English matching fails)
  // Exact alias match first (highest confidence)
  if (!matchedNode) {
    matchedNode = activeNodes.find(node =>
      (node.hindiAliases || []).some(alias => norm(alias) === normalizedText)
    );
  }

  // Contains match - customer's message contains an alias phrase anywhere in it
  if (!matchedNode) {
    matchedNode = activeNodes.find(node =>
      (node.hindiAliases || []).some(alias => {
        const normalizedAlias = norm(alias);
        return normalizedAlias && containsKw(normalizedAlias);
      })
    );
  }

  // Pass 5 - Fuzzy match (last resort, free/local, no AI). Catches typos
  // and near-misses of the full keyword (e.g. "pric" vs "price") for
  // short customer messages — not substring fuzzy matching within longer
  // sentences, which produces too many false positives.
  if (!matchedNode) {
    let closestFuzzyMatch = null;
    let closestFuzzyDistance = Infinity;

    for (const node of activeNodes) {
      const normalizedKeyword = norm(node.keyword);
      if (!normalizedKeyword) continue;

      let editDistance;
      let threshold;
      if (native(normalizedKeyword)) {
        threshold = nativeFuzzyThreshold(Array.from(normalizedKeyword).length);
        if (threshold < 0) continue;
        editDistance = codePointDistance(normalizedText, normalizedKeyword);
      } else {
        editDistance = distance(normalizedText, normalizedKeyword);
        threshold = fuzzyThresholdFor(normalizedKeyword.length);
      }

      if (editDistance <= threshold && editDistance < closestFuzzyDistance) {
        closestFuzzyMatch = node;
        closestFuzzyDistance = editDistance;
      }
    }

    matchedNode = closestFuzzyMatch;
  }

  return matchedNode || null;
};

/**
 * The keyword matching itself, with no DB access or side effects: which of
 * `nodes` (reply nodes, camelCase; inactive ones are skipped) a message
 * triggers, or null. findMatchingRule runs it against the business's live
 * nodes; the Bot Builder draft preview (botSettings.controller.js) runs it
 * against an unpublished compiled graph, so both match identically.
 *
 * `unicode` false = the legacy normalizer (native-script text normalizes to '' and never matches).
 * `unicode` true = utils/textNormalize.js#normalizeUnicode, plus a fallback for mixed messages
 * ("hi भाई"): when the full text matches nothing, the passes run once more on its ASCII projection
 * ("hi") so Roman keywords keep matching exactly as they do for ASCII-only messages.
 * @param {Object[]} nodes
 * @param {string} incomingText
 * @param {{ unicode?: boolean }} [opts]
 * @returns {{ node: Object|null, via: 'full'|'projection'|null }}
 */
const matchNodeInListDetailed = (nodes, incomingText, { unicode = false } = {}) => {
  const activeNodes = nodes.filter(node => node.isActive);

  if (!unicode) {
    const normalizedText = normalizeText(incomingText);
    if (!normalizedText) return { node: null, via: null };
    const node = runPasses(activeNodes, normalizedText, { norm: normalizeText, unicode: false });
    return { node, via: node ? 'full' : null };
  }

  const normalizedText = normalizeUnicode(incomingText);
  if (!normalizedText) return { node: null, via: null };
  const full = runPasses(activeNodes, normalizedText, { norm: normalizeUnicode, unicode: true });
  if (full) return { node: full, via: 'full' };

  if (isMixedScript(incomingText)) {
    const projected = asciiProjection(incomingText);
    if (projected && projected !== normalizedText) {
      const node = runPasses(activeNodes, projected, { norm: normalizeUnicode, unicode: true });
      if (node) return { node, via: 'projection' };
    }
  }
  return { node: null, via: null };
};

const matchNodeInList = (nodes, incomingText, opts) => matchNodeInListDetailed(nodes, incomingText, opts).node;

/**
 * Why the legacy and Unicode matchers disagree, or null when they agree (or, with the flag ON, when
 * the difference is not a regression). `legacy` / `modern` are matchNodeInListDetailed results.
 * old_only = legacy matched, Unicode did not; mixed_fallback = Unicode matched only via the ASCII
 * projection; native_only = legacy found nothing on a native-script message; different_node = the rest.
 * @returns {'old_only'|'mixed_fallback'|'native_only'|'different_node'|null}
 */
const shadowReason = (incomingText, legacy, modern, unicodeOn) => {
  const oldId = legacy.node ? legacy.node.id : null;
  const newId = modern.node ? modern.node.id : null;
  if (oldId === newId) return null;
  if (oldId && !newId) return 'old_only';
  if (unicodeOn) return null;
  if (modern.via === 'projection') return 'mixed_fallback';
  if (!oldId && hasNonAsciiLetter(incomingText)) return 'native_only';
  return 'different_node';
};

/**
 * Shadow comparison of the legacy and Unicode matchers (never throws, no phone numbers).
 * Flag OFF: logs every difference. Flag ON: logs only 'old_only' (legacy matched, Unicode did not)
 * to catch regressions on enabled businesses. Search the logs for "[unicode-match-shadow]".
 */
const logUnicodeShadow = (businessId, incomingText, legacy, modern, unicodeOn) => {
  try {
    const reason = shadowReason(incomingText, legacy, modern, unicodeOn);
    if (!reason) return;
    const oldId = legacy.node ? legacy.node.id : null;
    const newId = modern.node ? modern.node.id : null;

    const messageSample = String(incomingText || '').slice(0, 40).replace(/\d{7,}/g, '#');
    logger.info(`[unicode-match-shadow] ${JSON.stringify({ businessId, oldNodeId: oldId, newNodeId: newId, messageSample, reason })}`);
  } catch (error) {
    logger.error('Unicode match shadow log failed:', error);
  }
};

/**
 * Find matching reply-trigger flow node for incoming message
 * @param {string} businessId - The business ID
 * @param {string} incomingText - The incoming message text
 * @param {Object} [opts]
 * @param {boolean} [opts.incrementCount=true] - set false for a probe call
 *   that isn't a real customer message (e.g. webhook.controller.js's
 *   no-rule-matched fallback borrowing the greeting node's buttons) so
 *   trigger_count isn't inflated by a match the customer didn't actually
 *   trigger.
 * @returns {Promise<{node: Object, edges: Array}|null>}
 */
const findMatchingRule = async (businessId, incomingText, { incrementCount = true } = {}) => {
  try {
    // Nothing matchable in either normalizer (empty, emoji-only, punctuation-only)
    if (!normalizeText(incomingText) && !normalizeUnicode(incomingText)) {
      return null;
    }

    const unicodeOn = await isUnicodeMatchingEnabled(businessId);

    // Load reply nodes from cache
    const nodes = await getRulesFromCache(businessId);

    // Both matchers always run: the enabled one answers, the other is the shadow comparison.
    // Probe calls (incrementCount:false: previews, the 'hi' fallback probe) are not customer messages.
    const legacy = matchNodeInListDetailed(nodes, incomingText, { unicode: false });
    const modern = matchNodeInListDetailed(nodes, incomingText, { unicode: true });
    if (incrementCount) logUnicodeShadow(businessId, incomingText, legacy, modern, unicodeOn);
    const matchedNode = (unicodeOn ? modern : legacy).node;

    if (!matchedNode) {
      return null;
    }

    if (incrementCount) incrementTriggerCount(matchedNode.id);

    // Only reply nodes with a rendered button/list carry outgoing edges —
    // skip the query for plain text replies (is_computed nodes are a
    // 'question'/'vehicle_carousel'/'rentalPackage' concept, never 'reply').
    const edges = matchedNode.contentType === 'text'
      ? []
      : await getOutgoingEdges(matchedNode.id);

    return { node: matchedNode, edges };
  } catch (error) {
    logger.error('Error in findMatchingRule:', error);
    return null;
  }
};

module.exports = {
  getRulesFromCache,
  invalidateRulesCache,
  normalizeText,
  matchNodeInList,
  matchNodeInListDetailed,
  shadowReason,
  findMatchingRule,
  getOutgoingEdges,
  resolveTappedEdge,
  resolveCarouselTap
};
