// Stateless conversation preview for the flow-graph canvas: simulates
// webhook.controller.js's Step 12 (active booking session) / Step 12.5
// (greeting) / Step 13 (tap resolution + rule matching) / Step 14 (reply
// preparation) / Step 16 (button/list rendering) against the SAME
// bookingGraphService/chatbotService calls the real webhook uses, stripped
// of everything WhatsApp/DB-side-effect-related: no customers/messages/
// booking_leads rows, no Redis session, no addToWhatsappQueue, no
// trigger_count increments (findMatchingRule is always called with
// incrementCount:false here — never a real customer trigger).
//
// Session is entirely client-held: the caller echoes back whatever this
// endpoint last returned as `session`, or null to (re)start a fresh
// simulated conversation. Nothing here is written server-side, so there is
// nothing to expire, collide with a real customer session, or clean up.
//
// Real DB reads ARE intentional (route_fares/vehicles/rental_packages via
// bookingGraphService's live fare lookups) so the carousel/fares a preview
// user sees match what a real customer would see.
const bookingGraphService = require('../services/bookingGraph.service');
const bookingService = require('../services/booking.service');
const chatbotService = require('../services/chatbot.service');
const smartFallbackService = require('../services/smartFallback.service');
const businessService = require('../services/business.service');
const { GREETING_KEYWORDS } = require('./webhook.controller');
const { applyMessageTemplate, applyMessageTemplateWithFooter } = require('../utils/messageTemplating');
const { getLocalizedText } = require('../utils/localization');
const { successResponse, errorResponse } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * Render a booking-graph field (buttons/list/vehicle_carousel) into this
 * endpoint's {buttons, listOptions} shape. Mirrors the id scheme
 * sendFieldPrompt/whatsapp.service.js build for real WhatsApp sends
 * ("{node_id}:{index}", "{node_id}:other" for the carousel escape hatch) so
 * a tapped option round-trips correctly through this same endpoint's Step-12
 * tap-resolution on the next turn — this endpoint never sends anything to
 * WhatsApp, so there's no reason to fragment a carousel into N separate
 * messages the way the real send does; it's flattened into one listOptions
 * array instead (a deliberate, flagged deviation from "identical to a real
 * WhatsApp bubble" for this one field type).
 */
const buildFieldOptions = (field) => {
  if (!field) return { buttons: [], listOptions: [] };

  if (field.fieldType === 'vehicle_carousel') {
    const listOptions = (field.options || []).map(option => {
      const parts = [option.name];
      if (option.seats) parts.push(`${option.seats} seats`);
      parts.push(`₹${option.fare}`);
      return {
        nextKeyword: `${field.nodeId}:${option.index}`,
        label: parts.join(' • '),
        description: null,
        photoUrl: option.photoUrl || null
      };
    });
    listOptions.push({
      nextKeyword: `${field.nodeId}:other`,
      label: 'Other options',
      description: null
    });
    return { buttons: [], listOptions };
  }

  if (field.fieldType === 'buttons' || field.fieldType === 'list') {
    const options = (field.options || []).map(bookingService.normalizeOption);
    if (field.fieldType === 'buttons') {
      return {
        buttons: options.map((opt, index) => ({ nextKeyword: `${field.nodeId}:${index}`, title: opt.label })),
        listOptions: []
      };
    }
    return {
      buttons: [],
      listOptions: options.map((opt, index) => ({ nextKeyword: `${field.nodeId}:${index}`, label: opt.label, description: null }))
    };
  }

  return { buttons: [], listOptions: [] };
};

/**
 * Render a reply node's outgoing edges into this endpoint's
 * {buttons, listOptions} shape — mirrors Step 16's localizedButtons/
 * localizedListOptions exactly (edge.id as nextKeyword, per
 * chatbot.service.js's getOutgoingEdges).
 */
const buildReplyNodeOptions = (node, edges) => {
  const buttons = node?.contentType === 'buttons'
    ? edges.map(edge => ({ nextKeyword: edge.nextKeyword, title: getLocalizedText(edge, 'label', null) }))
    : [];
  const listOptions = node?.contentType === 'list'
    ? edges.map(edge => ({
        nextKeyword: edge.nextKeyword,
        label: getLocalizedText(edge, 'label', null),
        description: getLocalizedText(edge, 'description', null)
      }))
    : [];
  return { buttons, listOptions };
};

const isDistanceEstimateCarousel = (field) =>
  !!field && field.fieldType === 'vehicle_carousel' &&
  (field.options || []).some(opt => opt.source === 'distance_estimate');

/**
 * Gate a freshly (re)computed vehicle_carousel field behind the SAME manual-
 * preview credit pool booking.controller.js's getVehicleCarouselPreview
 * already reads/writes (previewCreditsUsed/Purchased) — not a second
 * counter. Charges ONLY when the carousel resolved via the distance_estimate
 * tier; route_fare/rental_package are plain DB reads with no external cost,
 * so they're free. Note: by the time this runs, bookingGraphService already
 * performed the live lookup (a cache-miss distance_estimate resolution calls
 * the real Google Distance Matrix API) — there's no hook to check credits
 * before that call fires without duplicating the engine's routing logic
 * here, so this gates whether the preview user gets to SEE the result, not
 * the API spend itself.
 * @returns {Promise<{allowed: true}|{allowed: false, replyText: string}>}
 */
const gateDistanceEstimateCarousel = async (businessId, field) => {
  if (!isDistanceEstimateCarousel(field)) return { allowed: true };
  const credit = await bookingService.checkAndConsumeManualPreviewCredit(businessId);
  if (!credit.allowed) {
    return {
      allowed: false,
      replyText: "This route needs a live fare check, and your business is out of free previews this month — ask your platform admin for more."
    };
  }
  return { allowed: true };
};

/**
 * Mirrors Step 12.5 (greeting) + Step 13 (tap resolution / rule matching) +
 * Step 14 (reply preparation) + Step 16 (button/list rendering) with no
 * active session. Returns the full { replyText, buttons, listOptions,
 * session } response shape.
 */
const handleNoActiveSession = async (business, messageText, buttonReplyId) => {
  const normalizedText = (messageText || '').trim().toLowerCase();

  // Step 12.5 - greeting (exact match only, real rule keywords still win)
  if (GREETING_KEYWORDS.has(normalizedText)) {
    const localizedWelcomeMessage = getLocalizedText(business, 'welcomeMessage', null);
    if (localizedWelcomeMessage) {
      const replyText = applyMessageTemplateWithFooter(localizedWelcomeMessage, business, null);
      return { replyText, buttons: [], listOptions: [], session: null };
    }
    // No welcomeMessage configured - fall through to rule matching below,
    // same as the real webhook.
  }

  // Step 13 - resolve a tapped reply-node button/list row structurally
  // first (its id is a flow_edges.id, never a keyword), falling back to
  // keyword matching for real typed text or a stale/unresolvable tap.
  let matchedNode = null;
  let matchedEdges = [];
  let directBookingEntry = null;

  if (buttonReplyId) {
    const resolvedTap = await chatbotService.resolveTappedEdge(business.id, buttonReplyId);
    if (resolvedTap?.targetNode?.nodeType === 'question') {
      directBookingEntry = { nodeId: resolvedTap.targetNode.id, ruleId: resolvedTap.edge.fromNodeId, edge: resolvedTap.edge };
    } else if (resolvedTap?.targetNode?.nodeType === 'reply') {
      matchedNode = resolvedTap.targetNode;
      matchedEdges = matchedNode.contentType === 'text' ? [] : await chatbotService.getOutgoingEdges(matchedNode.id);
    }
  }

  if (!directBookingEntry && !matchedNode) {
    // incrementCount:false - this is a preview, never a real customer trigger.
    const matchResult = await chatbotService.findMatchingRule(business.id, messageText, { incrementCount: false });
    matchedNode = matchResult?.node || null;
    matchedEdges = matchResult?.edges || [];
  }

  // Step 14 - prepare the reply
  if (directBookingEntry) {
    const { session: newBookingSession, field: firstField } = await bookingGraphService.startGraphSessionAtNode(
      business.id, directBookingEntry.nodeId, directBookingEntry.ruleId, null, directBookingEntry.edge
    );
    const replyText = applyMessageTemplateWithFooter(firstField.label, business, null);
    const rendered = buildFieldOptions(firstField);
    return { replyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session: newBookingSession };
  }

  if (matchedNode) {
    if (matchedNode.replyKind === 'text') {
      const localizedReply = getLocalizedText(matchedNode, 'label', null);
      const replyText = applyMessageTemplateWithFooter(localizedReply, business, null);
      const rendered = buildReplyNodeOptions(matchedNode, matchedEdges);
      return { replyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session: null };
    }

    if (matchedNode.replyKind === 'booking_trigger') {
      const { session: newBookingSession, result } = await bookingGraphService.startGraphSession(business.id, matchedNode.id, null);

      if (result.done) {
        // Mirrors handleActiveSession's {done:true} handling above - NEVER
        // call finalizeGraphBooking/createBookingAndConfirmation here, that
        // would insert a real `bookings` row for a canvas preview click.
        const displayCollected = { ...result.collected, ...(newBookingSession.displayOverrides || {}) };
        const summaryBody = bookingService.buildBookingSummaryBody(
          displayCollected,
          newBookingSession.answeredFields,
          newBookingSession.localRentalUnconfigured
        );
        const replyText = '✅ This is where a real booking would be created.\n\n' + summaryBody;
        return { replyText, buttons: [], listOptions: [], session: null };
      }

      const replyText = applyMessageTemplateWithFooter(result.label, business, null);
      const rendered = buildFieldOptions(result);
      return { replyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session: newBookingSession };
    }

    if (matchedNode.replyKind === 'payment_trigger') {
      const replyText = applyMessageTemplateWithFooter(matchedNode.label, business, null) || 'Please complete your payment.';
      return { replyText, buttons: [], listOptions: [], session: null };
    }
  }

  // No rule matched - AI-generated fallback (opt-in per business), falling
  // back to the static reply, same as the real webhook's no-match branch.
  let smartReply = null;
  if (business.enableSmartFallback) {
    try {
      smartReply = await Promise.race([
        smartFallbackService.getSmartFallbackReply(business.id, messageText),
        new Promise((resolve) => setTimeout(() => resolve(null), 4000))
      ]);
    } catch (smartFallbackError) {
      logger.error('Error generating smart fallback reply (preview):', smartFallbackError);
      smartReply = null;
    }
  }

  const replyText = smartReply || applyMessageTemplate(business.fallbackReply, business, null) || 'Thank you for your message. We will get back to you soon.';

  // Borrow the greeting/menu reply node's buttons (if configured) so the
  // fallback isn't a dead end - same probe the real no-match branch uses.
  let fallbackMenuNode = null;
  let fallbackMenuEdges = [];
  const greetingMatch = await chatbotService.findMatchingRule(business.id, 'hi', { incrementCount: false });
  if (greetingMatch?.node &&
      (greetingMatch.node.contentType === 'buttons' || greetingMatch.node.contentType === 'list') &&
      greetingMatch.edges.length > 0) {
    fallbackMenuNode = greetingMatch.node;
    fallbackMenuEdges = greetingMatch.edges;
  }
  const rendered = buildReplyNodeOptions(fallbackMenuNode, fallbackMenuEdges);
  return { replyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session: null };
};

/**
 * Mirrors Step 12 (active booking session) with everything
 * WhatsApp/DB-side-effect-related stripped: no session persistence (the
 * caller holds `session`), no message rows, and {done:true} builds a
 * synthetic summary instead of calling finalizeGraphBooking/
 * createBookingAndConfirmation (which would insert a real `bookings` row).
 */
const handleActiveSession = async (business, session, messageText, buttonReplyId) => {
  let resolvedReply = messageText;

  if (buttonReplyId) {
    const currentField = await bookingGraphService.getCurrentNodeField(business.id, session, null);

    if (currentField &&
        (currentField.fieldType === 'buttons' || currentField.fieldType === 'list' || currentField.fieldType === 'vehicle_carousel')) {
      const lastColonIdx = buttonReplyId.lastIndexOf(':');
      const tappedNodeId = lastColonIdx === -1 ? null : buttonReplyId.slice(0, lastColonIdx);
      const suffix = lastColonIdx === -1 ? null : buttonReplyId.slice(lastColonIdx + 1);

      if (tappedNodeId === null || tappedNodeId !== session.currentNodeId) {
        // Stale tap - re-render the current question without advancing,
        // same as the real webhook's stale-tap guard.
        // Mirrors sendFieldPrompt: only the non-carousel path gets the
        // footer/template treatment — a vehicle_carousel's intro text is
        // sent as-is by the real webhook, so the preview must match.
        const rendered = buildFieldOptions(currentField);
        const staleReplyText = currentField.fieldType === 'vehicle_carousel'
          ? currentField.label
          : applyMessageTemplateWithFooter(currentField.label, business, null);
        return { replyText: staleReplyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session };
      }

      if (currentField.fieldType === 'vehicle_carousel') {
        resolvedReply = suffix;
      } else {
        const tappedIndex = parseInt(suffix, 10);
        if (!Number.isNaN(tappedIndex) && currentField.options[tappedIndex] !== undefined) {
          resolvedReply = currentField.options[tappedIndex].value;
        }
      }
    }
  }

  // advanceGraphSession mutates the `session` object it's given IN PLACE and
  // returns that same reference (fine for the real webhook, which never
  // needs the pre-call state again) - so `session` and `updatedSession`
  // below are literally the same object once this resolves. The
  // credit-exhausted soft-fail branches need to hand back the conversation
  // exactly where it was BEFORE this turn, which requires an independent
  // snapshot taken before the call, not a reference to `session` itself.
  const sessionBeforeThisTurn = JSON.parse(JSON.stringify(session));

  const { session: updatedSession, result } = await bookingGraphService.advanceGraphSession({
    businessId: business.id,
    session,
    reply: resolvedReply,
    languageCode: null
  });

  if (result === null) {
    // Expired/unresolvable session (or a foreign session object echoed back
    // from a stale preview) - fall through to a fresh conversation, same
    // fallback the real webhook applies.
    return handleNoActiveSession(business, messageText, buttonReplyId);
  }

  if (result.done) {
    // NEVER call finalizeGraphBooking/createBookingAndConfirmation here -
    // that would insert a real `bookings` row. Build the same
    // field/fare/note-line summary from result.collected directly instead.
    const displayCollected = { ...result.collected, ...(updatedSession.displayOverrides || {}) };
    const summaryBody = bookingService.buildBookingSummaryBody(
      displayCollected,
      updatedSession.answeredFields,
      updatedSession.localRentalUnconfigured
    );
    const replyText = '✅ This is where a real booking would be created.\n\n' + summaryBody;
    return { replyText, buttons: [], listOptions: [], session: null };
  }

  if (typeof result === 'string') {
    if (result.startsWith('Sorry, that vehicle is no longer available')) {
      // Tap-time re-verification refreshed the carousel in place - resend
      // it with this status string as the intro, same as the real webhook.
      const refreshedField = await bookingGraphService.getCurrentNodeField(business.id, updatedSession, null);
      const gate = await gateDistanceEstimateCarousel(business.id, refreshedField);
      if (!gate.allowed) {
        // Credits exhausted - leave the conversation exactly where the
        // caller found it (no partial advance) and hand back a soft
        // in-conversation message instead of the carousel. Must be the
        // pre-call snapshot, not `session`/`updatedSession` - see the
        // mutation note above advanceGraphSession's call site.
        return { replyText: gate.replyText, buttons: [], listOptions: [], session: sessionBeforeThisTurn };
      }
      const rendered = buildFieldOptions(refreshedField);
      return { replyText: result, buttons: rendered.buttons, listOptions: rendered.listOptions, session: updatedSession };
    }
    // Plain re-prompt (invalid choice) - no field to render, just the message.
    return { replyText: result, buttons: [], listOptions: [], session: updatedSession };
  }

  // result is the next field object.
  const gate = await gateDistanceEstimateCarousel(business.id, result);
  if (!gate.allowed) {
    // Same soft-fail as above - don't hand the caller a session that
    // advanced onto a carousel they can't actually see.
    return { replyText: gate.replyText, buttons: [], listOptions: [], session: sessionBeforeThisTurn };
  }
  // Mirrors sendFieldPrompt: only the non-carousel path gets the
  // footer/template treatment — a vehicle_carousel's intro text is sent
  // as-is by the real webhook, so the preview must match.
  const rendered = buildFieldOptions(result);
  const nextReplyText = result.fieldType === 'vehicle_carousel'
    ? result.label
    : applyMessageTemplateWithFooter(result.label, business, null);
  return { replyText: nextReplyText, buttons: rendered.buttons, listOptions: rendered.listOptions, session: updatedSession };
};

/**
 * POST /api/flow-graph/preview/message
 */
const previewMessage = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;
    const { message, buttonReplyId, session } = req.body;

    if (typeof message !== 'string') {
      return errorResponse(res, 400, 'message must be a string');
    }
    if (session !== null && session !== undefined && typeof session !== 'object') {
      return errorResponse(res, 400, 'session must be an object or null');
    }

    const business = await businessService.getBusinessById(businessId);
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    const result = session
      ? await handleActiveSession(business, session, message, buttonReplyId || null)
      : await handleNoActiveSession(business, message, buttonReplyId || null);

    return successResponse(res, 200, result);
  } catch (error) {
    logger.error('Error in flow-graph conversation preview:', error);
    next(error);
  }
};

module.exports = { previewMessage };
