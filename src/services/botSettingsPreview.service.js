// "Try it" chat for UNSAVED Bot Builder settings (POST
// /api/bot-settings/preview-message). The draft is compiled exactly as
// Preview/Publish compile it (botSettings.service.js#buildFromSettings —
// real courses, real business), then each message is answered the way the
// live webhook would answer it against that graph — same greeting-word
// check, same keyword matching (chatbot.service.js#matchNodeInList), same
// message templating — but against the in-memory draft instead of
// flow_nodes/flow_edges. Stateless and read-only: no DB writes, no
// WhatsApp sends, no form links, no AI fallback call.
//
// Response shape matches flowGraphPreview.controller.js's
// ({ replyText, buttons, listOptions, session: null }) so the same chat
// UI renders both, plus two optional keys:
//   form: the form as the parent will see it, when a form button is tapped
//   note: a preview-only explanation (e.g. "on WhatsApp an AI reply may be sent")
//   imageUrl: a course photo sent above the message on WhatsApp
const supabase = require('../config/supabase');
const botSettingsService = require('./botSettings.service');
const businessService = require('./business.service');
const { matchNodeInList } = require('./chatbot.service');
const { GREETING_KEYWORDS } = require('../controllers/webhook.controller');
const { applyMessageTemplate, applyMessageTemplateWithFooter } = require('../utils/messageTemplating');
const { getLocalizedText } = require('../utils/localization');
const { getSystemMessage } = require('../utils/systemMessages');
const { BUSINESS_COURSES_SOURCE, COURSE_BATCHES_SOURCE } = require('../utils/flowFieldsValidation');
const { formTitleForKeyword } = require('../utils/coachingBotSettings');

// Preview-only interaction ids (never real WhatsApp ids).
const DRAFT_EDGE_PREFIX = 'draft_edge:'; // + index into the compiled edges
const DRAFT_FORM_PREFIX = 'draft_form:'; // + compiled form node id

/**
 * The compiled draft as the matcher/renderer need it: nodes marked active
 * (compiled nodes carry no isActive), edges with stable preview ids.
 */
const toDraftGraph = (graph) => ({
  nodes: graph.replyNodes.map(n => ({ ...n, isActive: true })),
  edges: graph.edges.map((e, i) => ({ ...e, nextKeyword: `${DRAFT_EDGE_PREFIX}${i}` }))
});

const outgoingEdges = (draft, nodeId) => draft.edges
  .filter(e => e.fromNodeId === nodeId)
  .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

/** Buttons/list rows for a reply node, like the live Step 16 render. */
const renderOptions = (draft, node) => {
  const edges = outgoingEdges(draft, node.id);
  if (node.contentType === 'buttons') {
    return { buttons: edges.map(e => ({ nextKeyword: e.nextKeyword, title: e.label })), listOptions: [] };
  }
  if (node.contentType === 'list') {
    return {
      buttons: [],
      listOptions: edges.map(e => ({ nextKeyword: e.nextKeyword, label: e.label, description: e.description || null }))
    };
  }
  return { buttons: [], listOptions: [] };
};

/** One reply node → the chat response the live webhook would send. */
const renderNode = (draft, node, business) => {
  if (node.replyKind === 'web_form_trigger') {
    // Same label/button fallbacks as webhook.controller.js's web_form_trigger branch.
    const prompt = node.label || getSystemMessage('webFormPrompt', null);
    const buttonText = node.buttonText || getSystemMessage('webFormButtonText', null);
    return {
      replyText: applyMessageTemplateWithFooter(prompt, business, null),
      buttons: [{ nextKeyword: `${DRAFT_FORM_PREFIX}${node.id}`, title: `🔗 ${buttonText}` }],
      listOptions: [],
      session: null
    };
  }
  if (node.contentType === 'location') {
    const hasLocation = business.businessLatitude != null && business.businessLongitude != null;
    const place = [business.displayName || business.name, business.address].filter(Boolean).join(', ');
    return {
      replyText: hasLocation ? `📍 ${place}` : '📍 (Your shop location is not set in Settings yet.)',
      buttons: [], listOptions: [], session: null,
      note: 'On WhatsApp this is sent as a map pin the parent can open.'
    };
  }
  return {
    replyText: applyMessageTemplateWithFooter(getLocalizedText(node, 'label', null), business, null),
    ...renderOptions(draft, node),
    // A course photo, sent above the message on WhatsApp.
    ...(node.mediaId && draft.mediaUrls[node.mediaId] ? { imageUrl: draft.mediaUrls[node.mediaId] } : {}),
    session: null
  };
};

/** URLs of the draft's page images (business_media), one query; {} when none. */
const loadMediaUrls = async (businessId, nodes) => {
  const ids = [...new Set(nodes.map(n => n.mediaId).filter(Boolean))];
  if (ids.length === 0) return {};
  const { data, error } = await supabase.from('business_media').select('id, url').eq('business_id', businessId).in('id', ids);
  if (error) throw error;
  return Object.fromEntries((data || []).map(m => [m.id, m.url]));
};

/** The form a form node opens, as the parent sees it (course list filled in). */
const renderForm = (node, courses) => {
  const courseNames = courses.map(c => c.name);
  // Same shape publicServiceForm.controller.js#resolveDynamicOptions gives the real form.
  const optionsByCourse = Object.fromEntries(courses
    .filter(c => Array.isArray(c.batches) && c.batches.length > 0)
    .map(c => [c.name, c.batches]));
  const title = formTitleForKeyword(node.keyword);
  return {
    title: title ? title.title : null,
    subtitle: title ? title.subtitle : null,
    fields: (node.formFields || []).map(f => {
      if (f.type === 'dropdown' && f.source === BUSINESS_COURSES_SOURCE) return { ...f, options: courseNames };
      const base = { ...f, options: Array.isArray(f.options) ? f.options : [] };
      return f.type === 'dropdown' && f.source === COURSE_BATCHES_SOURCE ? { ...base, optionsByCourse } : base;
    })
  };
};

/**
 * @param {{ businessId, graphBusiness, preset, settings, message, buttonReplyId }} args
 * @returns {Promise<Object>} a chat response, or { status, error }
 */
const previewMessage = async ({ businessId, graphBusiness, preset, settings, message, buttonReplyId }) => {
  const built = await botSettingsService.buildFromSettings({ businessId, graphBusiness, presetName: preset, settings });
  if (built.error) return built;
  const business = await businessService.getBusinessById(businessId);
  if (!business) return { status: 404, error: 'Business not found' };
  const draft = toDraftGraph(built.graph);
  draft.mediaUrls = await loadMediaUrls(businessId, draft.nodes);

  // A tapped form button: show the form instead of creating a link.
  if (buttonReplyId && buttonReplyId.startsWith(DRAFT_FORM_PREFIX)) {
    const formNode = draft.nodes.find(n => n.id === buttonReplyId.slice(DRAFT_FORM_PREFIX.length));
    if (formNode) {
      return {
        replyText: '📝 On WhatsApp this opens the form in the parent\'s browser. Here is what they will see:',
        buttons: [], listOptions: [], session: null,
        form: renderForm(formNode, built.courses)
      };
    }
  }

  // A tapped button/list row → its target (like resolveTappedEdge).
  if (buttonReplyId && buttonReplyId.startsWith(DRAFT_EDGE_PREFIX)) {
    const edge = draft.edges[Number(buttonReplyId.slice(DRAFT_EDGE_PREFIX.length))];
    const target = edge && draft.nodes.find(n => n.id === edge.toNodeId);
    if (target) return renderNode(draft, target, business);
  }

  // Step 12.5 — a business welcome message wins over the menu for greeting words.
  const normalizedText = (message || '').trim().toLowerCase();
  if (GREETING_KEYWORDS.has(normalizedText)) {
    const welcome = getLocalizedText(business, 'welcomeMessage', null);
    if (welcome) {
      return {
        replyText: applyMessageTemplateWithFooter(welcome, business, null),
        buttons: [], listOptions: [], session: null,
        note: 'Your business has a welcome message in Settings, so greetings send it instead of this menu. Clear it there to show the menu.'
      };
    }
  }

  // Step 13 — typed text, matched exactly like live messages.
  const matched = matchNodeInList(draft.nodes, message);
  if (matched) return renderNode(draft, matched, business);

  // No match — the static fallback reply plus the menu's buttons, like live.
  const menu = matchNodeInList(draft.nodes, 'hi');
  const menuOptions = menu && (menu.contentType === 'buttons' || menu.contentType === 'list')
    ? renderOptions(draft, menu)
    : { buttons: [], listOptions: [] };
  return {
    replyText: applyMessageTemplate(business.fallbackReply, business, null) || getSystemMessage('genericFallbackReply', null),
    ...menuOptions,
    session: null,
    ...(business.enableSmartFallback
      ? { note: 'On WhatsApp an AI-written answer may be sent here instead (AI replies are not used in this preview).' }
      : {})
  };
};

module.exports = { previewMessage, DRAFT_EDGE_PREFIX, DRAFT_FORM_PREFIX };
