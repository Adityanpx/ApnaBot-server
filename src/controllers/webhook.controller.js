const crypto = require('crypto');
const config = require('../config/env');
const tenantService = require('../services/tenant.service');
const chatbotService = require('../services/chatbot.service');
const smartFallbackService = require('../services/smartFallback.service');
const usageService = require('../services/usage.service');
const bookingService = require('../services/booking.service');
const bookingGraphService = require('../services/bookingGraph.service');
const socketService = require('../services/socket.service');
const { addToWhatsappQueue, addToWhatsappQueueAndWait } = require('../queues/whatsapp.queue');
const businessService = require('../services/business.service');
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { applyMessageTemplate, applyMessageTemplateWithFooter } = require('../utils/messageTemplating');
const { LANGUAGE_CATALOG, isValidLanguageCode } = require('../utils/languageCatalog');
const { getLocalizedText } = require('../utils/localization');
const { isIndefinitePause } = require('../utils/botPause');
const logger = require('../utils/logger');

// Exact-match greeting keywords that trigger the welcome message / menu.
// Kept as exact matches (not substring) so real rule keywords still win.
const GREETING_KEYWORDS = new Set(['hi', 'hello', 'hey', 'hii', 'hlo', 'namaste', 'start', 'menu']);

// Exact-match escape keywords that let a customer bail out of an active
// booking session instead of being stuck until the session TTL expires.
// Only checked against plain text (see the buttonReplyId/listReplyId guard
// at the call site) so an interactive tap can never coincidentally match.
// 'stop' is intentionally NOT included here — it's handled earlier in
// receiveWebhook by STOP_KEYWORDS below (customer-controlled bot pause),
// which always returns before this set would ever be checked.
const ESCAPE_KEYWORDS = new Set(['menu', 'cancel', 'exit', 'restart']);

// Customer-controlled bot pause, distinct from ESCAPE_KEYWORDS above:
// 'cancel'/'exit'/'restart' mean "cancel my active booking", these mean
// "stop messaging me" — a customer-triggered second way to set/clear the
// same customers.bot_paused_until column the business owner controls via
// message.controller.js's pause endpoint. Deliberately excludes 'cancel'/
// 'exit'/'restart' for the same reason ESCAPE_KEYWORDS keeps them separate.
const STOP_KEYWORDS = new Set(['stop', 'unsubscribe']);
const START_KEYWORDS = new Set(['start']);

// Lets a customer re-open the language picker at any time, not just on their
// very first message (see the change-language check in receiveWebhook, and
// Step 12.6 below for the first-time version of this same picker).
const CHANGE_LANGUAGE_KEYWORDS = new Set(['language', 'भाषा']);
const CUSTOMER_STOP_PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Insert a message row. Throws on failure — used at call sites that were
 * never wrapped in try/catch pre-migration, so an insert failure still
 * propagates to the outer handler's catch (logged, already-sent-200).
 * @param {Object} fields - snake_case row fields
 * @returns {Promise<Object>} camelCase row
 */
const saveMessage = async (fields) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (error) throw error;
  return toCamelCase(data);
};

/**
 * Insert a message row, swallowing failure — used at the carousel call sites
 * that were already wrapped in try/catch pre-migration, falling back to the
 * input fields (camelCased) so downstream reads still work; `.id` will be
 * undefined, same as the old fallback having no `_id`.
 * @param {Object} fields - snake_case row fields
 * @param {string} context - label for the log line
 * @returns {Promise<Object>} camelCase row (persisted) or camelCased fields (fallback)
 */
const createMessageSoft = async (fields, context) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (error) {
    logger.error(`Error creating ${context} message record:`, { message: error.message, stack: error.stack });
    return toCamelCase(fields);
  }
  return toCamelCase(data);
};

/**
 * Find-or-create the customer row for an inbound message, then bump their
 * lastMessageAt/totalMessages. Supabase has no atomic upsert-with-$inc, so
 * this is a read-then-write — a tiny race window under true concurrent
 * double-taps from the same customer, acceptable at current traffic.
 * @param {string} businessId
 * @param {string} customerNumber
 * @param {string} [profileName] - WhatsApp profile name from the webhook's contacts array
 * @returns {Promise<Object>} camelCase customer row
 */
const upsertCustomerForInboundMessage = async (businessId, customerNumber, profileName) => {
  const { data: existing, error: findErr } = await supabase
    .from('customers').select('*')
    .eq('business_id', businessId).eq('whatsapp_number', customerNumber).maybeSingle();
  if (findErr) throw findErr;

  const nowIso = new Date().toISOString();

  if (existing) {
    const updateFields = {
      last_message_at: nowIso,
      total_messages: (existing.total_messages || 0) + 1
    };
    // Only backfill the name from WhatsApp if we don't already have one —
    // a business owner's manual edit must win over a self-reported profile
    // name that the customer can change at any time.
    if (!existing.name && profileName) {
      updateFields.name = profileName;
    }
    const { data, error } = await supabase.from('customers').update(updateFields).eq('id', existing.id).select().single();
    if (error) throw error;
    return toCamelCase(data);
  }

  const { data, error } = await supabase.from('customers').insert({
    business_id: businessId,
    whatsapp_number: customerNumber,
    name: profileName || null,
    first_seen_at: nowIso,
    last_message_at: nowIso,
    total_messages: 1
  }).select().single();
  if (error) throw error;
  return toCamelCase(data);
};

/**
 * Send a booking-session field's prompt to the customer: plain text for a
 * 'text' field, a single message with an interactive attachment for
 * 'buttons'/'list', or the full intro + one-message-per-vehicle + "Other
 * options" carousel for 'vehicle_carousel'. Shared by the graph-engine
 * booking flow's normal turn-advance send and its stale-tap re-send (same
 * question, not advanced) — both need identical rendering, so this exists
 * once instead of duplicating the carousel multi-message block a second
 * time.
 *
 * WhatsApp interaction ids under the graph engine's scheme (see
 * 20260829140000_flow_nodes_edges.sql's header comment): every id a booking
 * session sees is options-backed — "{node_id}:{index}" for a 'buttons'/
 * 'list' field's rows (built via the worker/whatsapp.service `step`
 * job-data field, repurposed here to carry a node id string instead of a
 * numeric step — the worker only ever template-interpolates it, so this
 * needed no changes there) and, for vehicle_carousel, "{node_id}:{index}"
 * per vehicle plus the reserved "{node_id}:other" sentinel for the
 * standalone "Other options" button, both built directly below.
 * @param {Object} ctx - { tenant, customer, customerNumber, triggeredRuleId }
 * @param {Object} field - localized field (nodeId/fieldType/label/options)
 * @param {string} [introTextOverride] - vehicle_carousel only: send this as
 *   the intro message instead of field.label — used when re-rendering the
 *   carousel after a tap-time re-verification refreshed it in place
 *   (mirrors the old engine's rebuildCarouselOrFallback status string)
 */
const sendFieldPrompt = async (ctx, field, introTextOverride = null) => {
  const { tenant, customer, customerNumber, triggeredRuleId } = ctx;

  if (field.fieldType === 'vehicle_carousel') {
    try {
      const introText = introTextOverride || field.label;
      const introMsg = await createMessageSoft({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: customerNumber,
        direction: 'outbound',
        type: 'text',
        content: introText,
        status: 'sent',
        triggered_rule_id: triggeredRuleId,
        is_read: true
      }, 'carousel intro');

      // Awaited-to-completion (not just enqueued) so this intro message is
      // guaranteed to land at WhatsApp before the vehicle messages below,
      // even though the worker processes jobs with concurrency: 5.
      try {
        await addToWhatsappQueueAndWait({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: introText,
          type: 'text',
          messageId: introMsg.id
        });
      } catch (sendError) {
        logger.error('Error sending carousel intro message', {
          businessId: tenant.businessId,
          customerNumber,
          message: sendError.message,
          stack: sendError.stack
        });
      }

      usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );
      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer,
          message: introMsg,
          customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting socket event:', socketError);
      }

      // One message per vehicle option: image + caption + "Book this" button
      logger.info('Sending vehicle carousel', { businessId: tenant.businessId, customerNumber, optionCount: field.options.length });
      let sentCount = 0;
      for (const option of field.options) {
        const captionParts = [option.name];
        if (option.seats) captionParts.push(`${option.seats} seats`);
        captionParts.push(`₹${option.fare}`);
        const caption = captionParts.join(' • ');

        const vehicleMsg = await createMessageSoft({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: caption,
          status: 'sent',
          triggered_rule_id: triggeredRuleId,
          is_read: true
        }, 'carousel vehicle');

        // Awaited-to-completion so vehicle messages send in the same order
        // they're constructed, regardless of worker concurrency.
        try {
          await addToWhatsappQueueAndWait({
            businessId: tenant.businessId,
            phoneNumberId: tenant.phoneNumberId,
            encryptedAccessToken: tenant.accessToken,
            to: customerNumber,
            message: caption,
            type: 'text',
            imageUrl: option.photoUrl || null,
            buttons: [{ title: 'Book this', nextKeyword: `${field.nodeId}:${option.index}` }],
            messageId: vehicleMsg.id
          });
          sentCount++;
        } catch (sendError) {
          logger.error('Error sending carousel vehicle message', {
            businessId: tenant.businessId,
            customerNumber,
            optionIndex: option.index,
            optionName: option.name,
            message: sendError.message,
            stack: sendError.stack
          });
        }

        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: vehicleMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }
      }

      logger.info('Vehicle carousel send complete', {
        businessId: tenant.businessId,
        customerNumber,
        totalOptions: field.options.length,
        sentCount
      });

      // Escape hatch: let the customer opt out of the carousel if their
      // preferred vehicle isn't listed.
      const otherOptionsText = "Don't see the vehicle you want?";
      const otherOptionsMsg = await createMessageSoft({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: customerNumber,
        direction: 'outbound',
        type: 'text',
        content: otherOptionsText,
        status: 'sent',
        triggered_rule_id: triggeredRuleId,
        is_read: true
      }, 'carousel other-options');

      // Awaited-to-completion so this message lands after the last vehicle
      // message, preserving the constructed order.
      try {
        await addToWhatsappQueueAndWait({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: otherOptionsText,
          type: 'text',
          buttons: [{ title: 'Other options', nextKeyword: `${field.nodeId}:other` }],
          messageId: otherOptionsMsg.id
        });
      } catch (sendError) {
        logger.error('Error sending carousel "other options" message', {
          businessId: tenant.businessId,
          customerNumber,
          message: sendError.message,
          stack: sendError.stack
        });
      }

      usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );
      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer,
          message: otherOptionsMsg,
          customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting socket event:', socketError);
      }
    } catch (error) {
      logger.error('Fatal error in vehicle carousel send block', {
        businessId: tenant.businessId,
        customerNumber,
        message: error.message,
        stack: error.stack
      });
    }
    return;
  }

  const templatedLabel = applyMessageTemplateWithFooter(field.label, tenant, customer);

  const outboundMsg = await saveMessage({
    business_id: tenant.businessId,
    customer_id: customer.id,
    customer_number: customerNumber,
    direction: 'outbound',
    type: 'text',
    content: templatedLabel,
    status: 'sent',
    triggered_rule_id: triggeredRuleId,
    is_read: true
  });

  const outboundJobData = {
    businessId: tenant.businessId,
    phoneNumberId: tenant.phoneNumberId,
    encryptedAccessToken: tenant.accessToken,
    to: customerNumber,
    message: templatedLabel,
    type: 'text',
    messageId: outboundMsg.id
  };
  if (field.fieldType === 'buttons' || field.fieldType === 'list') {
    outboundJobData.step = field.nodeId;
    const labels = (field.options || []).map(opt => opt.label);
    if (field.fieldType === 'buttons') {
      outboundJobData.interactiveButtons = labels;
    } else {
      outboundJobData.interactiveList = labels;
      outboundJobData.listButtonLabel = 'Choose';
    }
  }
  await addToWhatsappQueue(outboundJobData);

  usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
    logger.error('Error incrementing outbound usage:', err)
  );
  try {
    socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
      customer,
      message: outboundMsg,
      customerNumber
    });
  } catch (socketError) {
    logger.error('Error emitting socket event:', socketError);
  }
};

/**
 * GET /api/webhook/verify
 * Meta webhook verification
 */
const verifyWebhook = async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.WEBHOOK_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  return res.status(403).send('Forbidden');
};

/**
 * POST /api/webhook/receive
 * Main webhook handler for WhatsApp events
 */
const receiveWebhook = async (req, res) => {
  console.log('WEBHOOK POST received:', JSON.stringify(req.body, null, 2));
  // Step 1 - Return 200 immediately
  res.status(200).json({ status: 'ok' });

  // Everything below runs async
  try {
    // Step 2 - Verify Meta signature
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      logger.warn('Missing webhook signature');
      return;
    }

    if (!req.rawBody) {
      logger.warn('Missing rawBody for signature verification');
      return;
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', config.META_APP_SECRET)
      .update(req.rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      logger.warn('Invalid webhook signature');
      return;
    }

    // Step 3 - Parse payload
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Handle status updates
    const statuses = value?.statuses;
    if (statuses) {
      for (const status of statuses) {
        const { data: updatedMsg, error } = await supabase
          .from('messages')
          .update({ status: status.status })
          .eq('meta_message_id', status.id)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message status:', error);
          continue;
        }
        if (updatedMsg) {
          try {
            socketService.emitToBusiness(updatedMsg.business_id, 'message_status', {
              messageId: updatedMsg.id,
              metaMessageId: status.id,
              status: status.status
            });
          } catch (socketErr) {
            logger.error('Error emitting message_status socket event:', socketErr);
          }
        }
      }
      return;
    }

    // Handle message template status updates (Meta approves/rejects/pauses a
    // template submitted via messageTemplate.controller.js's submit flow) so
    // message_templates.status doesn't stay stuck on 'pending' forever.
    if (changes?.field === 'message_template_status_update') {
      const templateEvent = value?.event; // Meta's casing: 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
      const metaTemplateId = value?.message_template_id;
      const templateName = value?.message_template_name;
      const rejectionReason = value?.reason; // present on rejections

      // message_templates.status has a check constraint of
      // ('draft','pending','approved','rejected') - PAUSED/DISABLED have no
      // matching value, so they're logged and skipped rather than written.
      const TEMPLATE_EVENT_TO_STATUS = { APPROVED: 'approved', REJECTED: 'rejected' };
      const mappedStatus = TEMPLATE_EVENT_TO_STATUS[templateEvent];

      if (!mappedStatus) {
        logger.warn(`Unhandled message_template_status_update event "${templateEvent}" - no matching message_templates.status value, skipping`, {
          metaTemplateId,
          templateName
        });
        return;
      }

      const updateFields = {
        status: mappedStatus,
        reviewed_at: new Date().toISOString(),
        rejection_reason: mappedStatus === 'rejected' ? (rejectionReason || null) : null
      };

      let updatedTemplate = null;
      if (metaTemplateId) {
        const { data, error } = await supabase
          .from('message_templates')
          .update(updateFields)
          .eq('meta_template_id', metaTemplateId)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message_templates by meta_template_id:', error);
          return;
        }
        updatedTemplate = data;
      }

      // Legacy fallback: submitMessageTemplate always sets meta_template_id
      // together with status 'pending', so this only matters for a row that
      // predates that flow or otherwise never got meta_template_id persisted.
      if (!updatedTemplate && templateName) {
        const { data, error } = await supabase
          .from('message_templates')
          .update(updateFields)
          .eq('name', templateName)
          .is('meta_template_id', null)
          .select()
          .maybeSingle();
        if (error) {
          logger.error('Error updating message_templates by name fallback:', error);
          return;
        }
        updatedTemplate = data;
      }

      if (!updatedTemplate) {
        logger.warn('No message_templates row found for template status update', {
          metaTemplateId,
          templateName,
          templateEvent
        });
        return;
      }

      try {
        socketService.emitToBusiness(updatedTemplate.business_id, 'template_status_update', {
          templateId: updatedTemplate.id,
          metaTemplateId: updatedTemplate.meta_template_id,
          name: updatedTemplate.name,
          status: updatedTemplate.status,
          rejectionReason: updatedTemplate.rejection_reason
        });
      } catch (socketErr) {
        logger.error('Error emitting template_status_update socket event:', socketErr);
      }

      return;
    }

    // Check for messages
    const messages = value?.messages;
    if (!messages) {
      return;
    }

    const message = messages[0];
    const metaMessageId = message.id;
    const customerNumber = message.from;
    const messageType = message.type;
    // A tapped reply-button arrives as type 'interactive'. We stored the target
    // rule's keyword as the button id (see sendInteractiveButtons), so treat that
    // id as the incoming "text" and let the normal rule matcher chain the flow.
    const buttonReplyId = message.interactive?.button_reply?.id || null;
    // A tapped list-message row arrives as type 'interactive' too, with its
    // id in list_reply instead of button_reply (see sendListMessage).
    const listReplyId = message.interactive?.list_reply?.id || null;
    let messageText = message.text?.body || buttonReplyId || listReplyId || '';
    const phoneNumberId = value.metadata.phone_number_id;
    // Meta includes the sender's current WhatsApp display name alongside each
    // inbound message via the contacts array — capture it for first contact.
    const profileName = value.contacts?.[0]?.profile?.name || null;

    // Step 4 - Resolve tenant
    const tenant = await tenantService.resolveBusinessByPhoneNumberId(phoneNumberId);
    if (!tenant) {
      logger.warn(`No business found for phoneNumberId: ${phoneNumberId}`);
      return;
    }

    // Step 5 - Check business active
    if (!tenant.isActive) {
      logger.warn(`Business ${tenant.businessId} is inactive`);
      return;
    }

    // Step 6 - Check subscription
    if (!tenant.subscription || tenant.subscription.status !== 'active') {
      logger.warn(`Business ${tenant.businessId} has no active subscription`);
      return;
    }

    // Step 7 - Check usage limit (used below, AFTER the message is saved —
    // an over-limit business must still receive/store the message; only the
    // reply is blocked. See Step 9.5.)
    const msgLimit = tenant.plan?.msg_limit || 500;
    const usageCheck = await usageService.checkUsageLimit(tenant.businessId, msgLimit);

    // Step 8 - Upsert customer
    const customer = await upsertCustomerForInboundMessage(tenant.businessId, customerNumber, profileName);

    if (customer.isBlocked) {
      logger.warn(`Blocked customer ${customerNumber}`);
      return;
    }

    // Bot pause: a business owner can silence the bot for this customer
    // (see message.controller.js sendMessage / the pause endpoint) without
    // blocking them outright. The inbound message is still recorded and
    // usage still counted below — only the language/greeting/booking/rule
    // matching that would generate a reply is skipped. The booking session
    // in Redis (if any) is deliberately left untouched: it expires on its
    // own TTL, so if the pause lifts first the customer resumes mid-flow.
    const isBotPaused = !!customer.botPausedUntil && new Date(customer.botPausedUntil).getTime() > Date.now();

    // Step 9 - Save inbound message
    const inboundMsg = await saveMessage({
      business_id: tenant.businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'inbound',
      type: messageType,
      content: messageText,
      meta_message_id: metaMessageId,
      status: 'delivered',
      is_read: false
    });

    // Step 9.5 - Enforce usage limit (message is already saved above — only
    // the reply, and the now-meaningless usage increment below, are blocked)
    if (!usageCheck.allowed) {
      logger.warn(`Usage limit reached for business ${tenant.businessId} — message saved, reply suppressed`);
      return;
    }

    // Step 10 - Increment usage (fire and forget)
    usageService.incrementUsage(tenant.businessId, 'inbound');

    // ADD THIS — Emit usage_update to Flutter dashboard
    usageService.checkUsageLimit(tenant.businessId, tenant.plan?.msg_limit || 500)
      .then(usageCheck => {
        socketService.emitToBusiness(tenant.businessId.toString(), 'usage_update', {
          msgCount: usageCheck.current,
          limit: usageCheck.limit
        });
      })
      .catch(err => logger.error('Error emitting usage_update:', err));

    // Customer-controlled pause: checked ahead of both the active-booking-
    // session handling (Step 12) and the isBotPaused early-return below —
    // (a) "stop" mid-booking must not be treated as a booking answer, and
    // (b) "start" must be able to clear a pause that would otherwise cause
    // the isBotPaused check to silently swallow it first. Only plain text is
    // checked (same guard ESCAPE_KEYWORDS uses) so a button/list tap can
    // never coincidentally match.
    const isPlainTextStopStart = !buttonReplyId && !listReplyId;
    const normalizedStopStartText = isPlainTextStopStart ? (message.text?.body || '').trim().toLowerCase() : '';
    if (STOP_KEYWORDS.has(normalizedStopStartText)) {
      const newBotPausedUntil = new Date(Date.now() + CUSTOMER_STOP_PAUSE_DURATION_MS).toISOString();
      const { error: stopPauseErr } = await supabase
        .from('customers').update({ bot_paused_until: newBotPausedUntil }).eq('id', customer.id);
      if (stopPauseErr) {
        logger.error('Error pausing bot via customer STOP keyword:', stopPauseErr);
      }
      customer.botPausedUntil = newBotPausedUntil;

      const stopText = "You won't receive messages for 24 hours. Reply START anytime to resume sooner.";
      const stopMsg = await saveMessage({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: customerNumber,
        direction: 'outbound',
        type: 'text',
        content: stopText,
        status: 'sent',
        is_read: true
      });
      await addToWhatsappQueue({
        businessId: tenant.businessId,
        phoneNumberId: tenant.phoneNumberId,
        encryptedAccessToken: tenant.accessToken,
        to: customerNumber,
        message: stopText,
        type: 'text',
        messageId: stopMsg.id
      });
      usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );
      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer,
          message: stopMsg,
          customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting socket event:', socketError);
      }

      logger.info(`Customer ${customerNumber} paused the bot via STOP keyword for business ${tenant.businessId}`);
      return; // Do not process booking session, greeting, or rule matching
    } else if (START_KEYWORDS.has(normalizedStopStartText) &&
               customer.botPausedUntil && new Date(customer.botPausedUntil).getTime() > Date.now() &&
               !isIndefinitePause(customer.botPausedUntil)) {
      // Indefinite pauses (owner "forever" pause / human handoff) are
      // deliberately NOT clearable by the customer's own START — only a
      // timed pause (owner's 24h pause or a prior customer STOP) is.
      const { error: startPauseErr } = await supabase
        .from('customers').update({ bot_paused_until: null }).eq('id', customer.id);
      if (startPauseErr) {
        logger.error('Error clearing bot pause via customer START keyword:', startPauseErr);
      }
      customer.botPausedUntil = null;

      const startText = "You're all set — messages have resumed.";
      const startMsg = await saveMessage({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: customerNumber,
        direction: 'outbound',
        type: 'text',
        content: startText,
        status: 'sent',
        is_read: true
      });
      await addToWhatsappQueue({
        businessId: tenant.businessId,
        phoneNumberId: tenant.phoneNumberId,
        encryptedAccessToken: tenant.accessToken,
        to: customerNumber,
        message: startText,
        type: 'text',
        messageId: startMsg.id
      });
      usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );
      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer,
          message: startMsg,
          customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting socket event:', socketError);
      }

      logger.info(`Customer ${customerNumber} resumed the bot via START keyword for business ${tenant.businessId}`);
      return; // Do not process booking session, greeting, or rule matching
    }

    if (isBotPaused) {
      logger.info(`Bot paused for ${customerNumber} until ${customer.botPausedUntil}, skipping reply`);
      return;
    }

    // Step 11.5 - Change-language keyword: lets a customer who already has a
    // preferredLanguage ask for the picker again at any time, not just on
    // their first-ever message. Checked ahead of both Step 12's active-
    // booking-session handling and Step 12.6's preferredLanguage === null
    // check below — same reasoning as STOP_KEYWORDS/START_KEYWORDS above, a
    // keyword like this must not be swallowed as a booking answer — but
    // after the isBotPaused check above (unlike STOP/START, this doesn't
    // control the pause flag itself, so a paused customer shouldn't get an
    // unsolicited reply). Only plain text is checked, same guard as
    // STOP_KEYWORDS/START_KEYWORDS/ESCAPE_KEYWORDS.
    const normalizedLanguageText = isPlainTextStopStart ? (message.text?.body || '').trim().toLowerCase() : '';
    if (CHANGE_LANGUAGE_KEYWORDS.has(normalizedLanguageText)) {
      const languageBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const enabledLanguages = languageBusinessDoc?.enabledLanguages?.length ? languageBusinessDoc.enabledLanguages : ['en'];

      if (enabledLanguages.length === 1) {
        // Nothing to ask - confirm the (only) language instead of showing a
        // 1-option picker. Also (re-)persists preferred_language in case it
        // was never set yet (e.g. this was the customer's very first
        // message and it happened to be "language" instead of "hi").
        const { data: updatedCustomer, error: langErr } = await supabase
          .from('customers')
          .update({ preferred_language: enabledLanguages[0] })
          .eq('id', customer.id)
          .select()
          .single();
        if (langErr) throw langErr;
        customer.preferredLanguage = toCamelCase(updatedCustomer).preferredLanguage;

        const onlyLanguageName = LANGUAGE_CATALOG[enabledLanguages[0]]?.name || enabledLanguages[0];
        const onlyLanguageText = `This business only replies in ${onlyLanguageName}.`;
        const onlyLanguageMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: onlyLanguageText,
          status: 'sent',
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: onlyLanguageText,
          type: 'text',
          messageId: onlyLanguageMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: onlyLanguageMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        logger.info(`Change-language keyword: only one language enabled for business ${tenant.businessId}, confirmed to customer ${customerNumber}`);
        return; // Do not process booking session, greeting, or rule matching
      }

      // 2 or 3 languages enabled - ask, then wait for the reply. Deliberately
      // does NOT touch customer.preferredLanguage here - it stays whatever it
      // already was until a tap actually lands (handled by the same lang_
      // handler below), so an abandoned picker leaves the existing language
      // working normally on the customer's next message.
      const languageButtons = enabledLanguages.map((code) => ({
        title: (LANGUAGE_CATALOG[code]?.name || code).slice(0, 20),
        nextKeyword: `lang_${code}`
      }));
      const languageChoiceLine = 'Choose your language / अपनी भाषा चुनें';
      const welcomeMessage = getLocalizedText(languageBusinessDoc, 'welcomeMessage', 'en');
      const languagePromptText = applyMessageTemplate(
        welcomeMessage ? `${welcomeMessage}\n\n${languageChoiceLine}` : languageChoiceLine,
        tenant,
        customer
      );

      const languagePromptMsg = await saveMessage({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: customerNumber,
        direction: 'outbound',
        type: 'text',
        content: languagePromptText,
        status: 'sent',
        is_read: true
      });
      await addToWhatsappQueue({
        businessId: tenant.businessId,
        phoneNumberId: tenant.phoneNumberId,
        encryptedAccessToken: tenant.accessToken,
        to: customerNumber,
        message: languagePromptText,
        type: 'text',
        buttons: languageButtons,
        messageId: languagePromptMsg.id
      });
      usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
        logger.error('Error incrementing outbound usage:', err)
      );
      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer,
          message: languagePromptMsg,
          customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting socket event:', socketError);
      }

      logger.info(`Sent change-language picker for business ${tenant.businessId}, customer ${customerNumber}`);
      return; // Do not process booking session, greeting, or rule matching
    }

    // Step 11 - Skip non-text messages, EXCEPT interactive button taps (which
    // carry a keyword in button_reply.id and must chain to the next rule).
    if (messageType !== 'text' && !buttonReplyId && !listReplyId) {
      logger.info('Non-text message received, skipping chatbot');
      return;
    }

    // Step 12 - Check active booking session
    const activeSession = await bookingService.getBookingSession(tenant.businessId, customerNumber);
    // A language-picker tap (lang_{code}) must never be treated as a booking-
    // session answer — its id shape ("lang_{code}") doesn't match the graph
    // engine's "{node_id}:{index}" options scheme, so left unguarded it would
    // be misread as a stale tap below and silently re-prompt the current
    // booking question instead of ever reaching the lang_ handler further
    // down (Step 12.6-adjacent). This matters now that "language" (above) can
    // fire mid-booking, leaving activeSession untouched on purpose.
    const isLanguagePickerTap = !!(buttonReplyId && buttonReplyId.startsWith('lang_'));
    if (activeSession && !isLanguagePickerTap) {
      logger.info(`Active booking session for ${customerNumber}`);

      // Escape hatch: let the customer cancel out of the booking flow with a
      // plain-text keyword instead of being stuck answering booking questions
      // until the session TTL expires. Only plain text is checked — a tapped
      // button/list reply id (e.g. an index like "2") could coincidentally
      // match one of these words, so interactive taps skip this entirely.
      const isPlainTextMessage = !buttonReplyId && !listReplyId;
      const normalizedEscapeText = isPlainTextMessage ? (message.text?.body || '').trim().toLowerCase() : '';
      if (ESCAPE_KEYWORDS.has(normalizedEscapeText)) {
        await bookingService.deleteBookingSession(tenant.businessId, customerNumber);

        // Cancellation confirmation message
        const cancelText = "Booking cancelled. Type 'hi' to see what I can help with.";
        const cancelMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: cancelText,
          status: 'sent',
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: cancelText,
          type: 'text',
          messageId: cancelMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: cancelMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        logger.info(`Booking session cancelled via escape keyword for ${customerNumber}`);
        return; // Do not process booking step, greeting, or rule matching
      }

      // Decode an inbound button/list tap's id. Under the graph engine's
      // scheme (20260829140000_flow_nodes_edges.sql), a booking session only
      // ever sees options-backed ids — "{node_id}:{index}" or
      // "{node_id}:other" — never flow_edges.id (that scheme belongs solely
      // to reply-node buttons/lists, Step 13-16's rule-matching path, which
      // never runs while a booking session is active). So this is a single,
      // unambiguous parse, not a lookup-and-see: split on the LAST ':'
      // (node ids are UUIDs, which never contain one). Only fetched for an
      // actual tap (replyId !== null) — a plain-text reply never needs the
      // current node resolved, so this skips an otherwise-wasted
      // loadGraph+business round trip on every free-text answer.
      let resolvedReply = messageText;
      const replyId = listReplyId !== null ? listReplyId : buttonReplyId;
      if (replyId !== null) {
        const currentField = await bookingGraphService.getCurrentNodeField(tenant.businessId, activeSession, customer.preferredLanguage);

        if (currentField &&
            (currentField.fieldType === 'buttons' || currentField.fieldType === 'list' || currentField.fieldType === 'vehicle_carousel')) {
          const lastColonIdx = replyId.lastIndexOf(':');
          const tappedNodeId = lastColonIdx === -1 ? null : replyId.slice(0, lastColonIdx);
          const suffix = lastColonIdx === -1 ? null : replyId.slice(lastColonIdx + 1);

          if (tappedNodeId === null || tappedNodeId !== activeSession.currentNodeId) {
            // Stale tap from an already-answered question (or a malformed
            // id) — don't resolve it as an answer to the current question.
            // Silently ignore it and re-send the current question's prompt
            // so the customer sees the bot is still waiting here, without
            // advancing the session. Unlike the old {step}/vehicle_ scheme,
            // this check now also covers vehicle_carousel taps.
            await sendFieldPrompt(
              { tenant, customer, customerNumber, triggeredRuleId: activeSession.ruleId },
              currentField
            );
            logger.info(`Ignored stale tap for ${customerNumber} (tapped node ${tappedNodeId}, current node ${activeSession.currentNodeId})`);
            return; // Do not advance the session or run rule matching
          }

          if (currentField.fieldType === 'vehicle_carousel') {
            // Carousel options are options-backed but aren't label/value
            // pairs — advanceGraphSession expects the raw index (or 'other')
            // as text, not a resolved value.
            resolvedReply = suffix;
          } else {
            const tappedIndex = parseInt(suffix, 10);
            if (!Number.isNaN(tappedIndex) && currentField.options[tappedIndex] !== undefined) {
              resolvedReply = currentField.options[tappedIndex].value;
            }
          }
        }
      }

      // Advance the graph. advanceGraphSession is side-effect-free by
      // design — the caller (here) owns persisting the returned session.
      const { session: updatedSession, result } = await bookingGraphService.advanceGraphSession({
        businessId: tenant.businessId,
        session: activeSession,
        reply: resolvedReply,
        languageCode: customer.preferredLanguage
      });

      if (result === null) {
        // Session expired — or, per bookingGraph.service.js's distinguishing
        // log line, an old-shape session from before the graph-engine
        // cutover. Either way, fall through to rule matching below.
        logger.info(`Booking session expired for ${customerNumber}`);
      } else if (result.done) {
        let confirmationText;
        try {
          confirmationText = await bookingService.finalizeGraphBooking(tenant.businessId, customerNumber, updatedSession);
        } catch (finalizeError) {
          logger.error('Error finalizing graph booking', {
            businessId: tenant.businessId,
            customerNumber,
            message: finalizeError.message,
            stack: finalizeError.stack
          });

          const fallbackText = 'Sorry, something went wrong confirming your booking — our team will reach out to you shortly.';
          const fallbackMsg = await saveMessage({
            business_id: tenant.businessId,
            customer_id: customer.id,
            customer_number: customerNumber,
            direction: 'outbound',
            type: 'text',
            content: fallbackText,
            status: 'sent',
            triggered_rule_id: activeSession.ruleId,
            is_read: true
          });
          await addToWhatsappQueue({
            businessId: tenant.businessId,
            phoneNumberId: tenant.phoneNumberId,
            encryptedAccessToken: tenant.accessToken,
            to: customerNumber,
            message: fallbackText,
            type: 'text',
            messageId: fallbackMsg.id
          });
          usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
            logger.error('Error incrementing outbound usage:', err)
          );
          try {
            socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
              customer,
              message: fallbackMsg,
              customerNumber
            });
          } catch (socketError) {
            logger.error('Error emitting socket event:', socketError);
          }

          return; // Do not run rule matching
        }

        const outboundMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: confirmationText,
          status: 'sent',
          triggered_rule_id: activeSession.ruleId,
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: confirmationText,
          type: 'text',
          messageId: outboundMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: outboundMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        return; // Do not run rule matching
      } else {
        // Non-terminal turn — persist the advanced session before sending
        // anything (advanceGraphSession never writes to Redis itself).
        await bookingService.saveBookingSession(tenant.businessId, customerNumber, updatedSession, tenant.phoneNumberId, tenant.accessToken);

        if (typeof result === 'string') {
          if (result.startsWith('Sorry, that vehicle is no longer available')) {
            // Tap-time re-verification found the carousel stale and
            // refreshed it in place (rebuildOrFallback) — resend the
            // carousel with this status string as the intro, using the
            // SAME node's freshly computed options already sitting in
            // updatedSession.currentNodeComputedOptions.
            const refreshedField = await bookingGraphService.getCurrentNodeField(tenant.businessId, updatedSession, customer.preferredLanguage);
            if (refreshedField) {
              await sendFieldPrompt(
                { tenant, customer, customerNumber, triggeredRuleId: activeSession.ruleId },
                refreshedField,
                result
              );
            }
          } else {
            // Plain re-prompt (invalid choice) — no state change, no field
            // to render, just the message.
            const outboundMsg = await saveMessage({
              business_id: tenant.businessId,
              customer_id: customer.id,
              customer_number: customerNumber,
              direction: 'outbound',
              type: 'text',
              content: result,
              status: 'sent',
              triggered_rule_id: activeSession.ruleId,
              is_read: true
            });
            await addToWhatsappQueue({
              businessId: tenant.businessId,
              phoneNumberId: tenant.phoneNumberId,
              encryptedAccessToken: tenant.accessToken,
              to: customerNumber,
              message: result,
              type: 'text',
              messageId: outboundMsg.id
            });
            usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
              logger.error('Error incrementing outbound usage:', err)
            );
            try {
              socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
                customer,
                message: outboundMsg,
                customerNumber
              });
            } catch (socketError) {
              logger.error('Error emitting socket event:', socketError);
            }
          }
        } else {
          // result is the next field object (any fieldType, including a
          // freshly is_computed vehicle_carousel).
          await sendFieldPrompt(
            { tenant, customer, customerNumber, triggeredRuleId: activeSession.ruleId },
            result
          );
        }

        return; // Do not run rule matching
      }
    }

    // Step 12.6 - Dynamic language selection. Runs only once Step 12's
    // booking-session handling has fallen through (no active session, or it
    // just expired) so an in-progress booking is never hijacked mid-flow.
    if (customer.preferredLanguage === null && !(buttonReplyId && buttonReplyId.startsWith('lang_'))) {
      const languageBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const enabledLanguages = languageBusinessDoc?.enabledLanguages?.length ? languageBusinessDoc.enabledLanguages : ['en'];

      if (enabledLanguages.length === 1) {
        // Nothing to ask - set it directly and fall through to greeting/rule
        // matching this same turn.
        const { data: updatedCustomer, error: langErr } = await supabase
          .from('customers')
          .update({ preferred_language: enabledLanguages[0] })
          .eq('id', customer.id)
          .select()
          .single();
        if (langErr) throw langErr;
        customer.preferredLanguage = toCamelCase(updatedCustomer).preferredLanguage;
      } else {
        // 2 or 3 languages enabled - ask, then wait for the reply.
        const languageButtons = enabledLanguages.map((code) => ({
          title: (LANGUAGE_CATALOG[code]?.name || code).slice(0, 20),
          nextKeyword: `lang_${code}`
        }));
        const languageChoiceLine = 'Choose your language / अपनी भाषा चुनें';
        const welcomeMessage = getLocalizedText(languageBusinessDoc, 'welcomeMessage', 'en');
        const languagePromptText = applyMessageTemplate(
          welcomeMessage ? `${welcomeMessage}\n\n${languageChoiceLine}` : languageChoiceLine,
          tenant,
          customer
        );

        const languagePromptMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: languagePromptText,
          status: 'sent',
          is_read: true
        });
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: languagePromptText,
          type: 'text',
          buttons: languageButtons,
          messageId: languagePromptMsg.id
        });
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: languagePromptMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting socket event:', socketError);
        }

        logger.info(`Sent language picker for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run greeting or rule matching this turn
      }
    }

    if (buttonReplyId && buttonReplyId.startsWith('lang_')) {
      // Customer tapped a language-picker button - validate (defends
      // against a stale/tampered id), persist, then fall through to the
      // greeting/rule-matching flow below as if the customer had just said
      // "hi" - the language picker only ever fires on a new customer's
      // first-ever message (Step 12.6 only runs when preferredLanguage is
      // null), so treating the tap as a greeting reproduces the normal
      // "hi" experience (menu, rules, buttons and all) via Step 12.5 /
      // Step 13, instead of sending a separate, simpler welcome message
      // that skips rule matching.
      const tappedCode = buttonReplyId.slice('lang_'.length);
      const langBusinessDoc = await businessService.getBusinessById(tenant.businessId);
      const enabledLanguages = langBusinessDoc?.enabledLanguages?.length ? langBusinessDoc.enabledLanguages : ['en'];

      if (!isValidLanguageCode(tappedCode) || !enabledLanguages.includes(tappedCode)) {
        logger.warn(`Ignoring language selection tap with invalid/stale code "${tappedCode}" for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run rule matching
      }

      const { data: updatedCustomer, error: langErr } = await supabase
        .from('customers')
        .update({ preferred_language: tappedCode })
        .eq('id', customer.id)
        .select()
        .single();
      if (langErr) throw langErr;
      customer.preferredLanguage = toCamelCase(updatedCustomer).preferredLanguage;

      if (activeSession) {
        // Customer changed language mid-booking (Step 11.5's keyword can fire
        // while a session is active, deliberately leaving it untouched) -
        // resume the pending question in the new language instead of falling
        // through to the greeting/menu below, which would otherwise abandon
        // the booking's visible flow even though the session is still alive
        // in Redis (isLanguagePickerTap kept Step 12 from consuming this tap
        // as a booking answer).
        const resumedField = await bookingGraphService.getCurrentNodeField(tenant.businessId, activeSession, customer.preferredLanguage);
        if (resumedField) {
          await sendFieldPrompt(
            { tenant, customer, customerNumber, triggeredRuleId: activeSession.ruleId },
            resumedField
          );
          logger.info(`Set preferred language ${tappedCode} for business ${tenant.businessId}, customer ${customerNumber}; resumed active booking session`);
          return; // Do not run greeting or rule matching - booking session is still active
        }
      }

      logger.info(`Set preferred language ${tappedCode} for business ${tenant.businessId}, customer ${customerNumber}; falling through to greeting`);
      messageText = 'hi';
      // No return - fall through to Step 12.5 / Step 13 below, which will
      // greet with the business's welcomeMessage if configured, or
      // otherwise run rule matching against 'hi' exactly like a real
      // greeting message would.
    }

    // Step 12.5 - Greeting -> welcome message (exact match only, so
    // real rule keywords still take priority over this).
    const normalizedText = (messageText || '').trim().toLowerCase();
    if (GREETING_KEYWORDS.has(normalizedText)) {
      const businessDoc = await businessService.getBusinessById(tenant.businessId);

      const localizedWelcomeMessage = getLocalizedText(businessDoc, 'welcomeMessage', customer.preferredLanguage);

      if (businessDoc && localizedWelcomeMessage) {
        const greetingReplyText = applyMessageTemplateWithFooter(localizedWelcomeMessage, tenant, customer);

        // Save outbound message
        const greetingOutboundMsg = await saveMessage({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: customerNumber,
          direction: 'outbound',
          type: 'text',
          content: greetingReplyText,
          status: 'sent',
          is_read: true
        });

        // Queue outbound message the same way Step 16 does
        const greetingJobData = {
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: greetingReplyText,
          type: 'text',
          messageId: greetingOutboundMsg.id
        };
        await addToWhatsappQueue(greetingJobData);

        // Increment outbound usage (fire and forget)
        usageService.incrementUsage(tenant.businessId, 'outbound').catch(err =>
          logger.error('Error incrementing outbound usage:', err)
        );

        // Emit socket event
        try {
          socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
            customer,
            message: greetingOutboundMsg,
            customerNumber
          });
        } catch (socketError) {
          logger.error('Error emitting new_message socket event for greeting:', socketError);
        }

        logger.info(`Sent welcome message for business ${tenant.businessId}, customer ${customerNumber}`);
        return; // Do not run rule matching or fallback
      }
    }

    // Step 13 - Resolve what to reply to. A tap on a reply-node button/list
    // row carries its flow_edges.id as the WhatsApp interaction id (see
    // chatbot.service.js's getOutgoingEdges) — resolve it structurally
    // first, since a UUID will never match a keyword. Only reached with no
    // active session (Step 12 returns early otherwise) and past the lang_
    // picker tap (handled above; it falls through with messageText='hi'
    // instead of a real edge id, hence the startsWith('lang_') guard here).
    // Falls back to keyword text matching — same as before this fix — for
    // an actual typed message, or for a stale tap whose id predates this
    // scheme (an old keyword-text button id already delivered to a
    // customer before this change shipped) or targets a since-deleted edge.
    let matchedNode = null;
    let matchedEdges = [];
    // Set when a tapped edge targets a question node directly (a button
    // wired straight into the booking graph, bypassing the booking_trigger
    // reply-node convention) — handled in Step 14 below instead of via
    // matchedNode.replyKind.
    let directBookingEntry = null;

    const tappedEdgeId = (buttonReplyId && !buttonReplyId.startsWith('lang_')) ? buttonReplyId : listReplyId;
    if (tappedEdgeId) {
      const resolvedTap = await chatbotService.resolveTappedEdge(tenant.businessId, tappedEdgeId);
      if (resolvedTap?.targetNode?.nodeType === 'question') {
        directBookingEntry = { nodeId: resolvedTap.targetNode.id, ruleId: resolvedTap.edge.fromNodeId, edge: resolvedTap.edge };
      } else if (resolvedTap?.targetNode?.nodeType === 'reply') {
        matchedNode = resolvedTap.targetNode;
        matchedEdges = matchedNode.contentType === 'text' ? [] : await chatbotService.getOutgoingEdges(matchedNode.id);
      } else if (resolvedTap) {
        logger.error(`Tapped flow_edges row ${tappedEdgeId} (business ${tenant.businessId}) targets node type '${resolvedTap.targetNode.nodeType}', which isn't a supported button/list target — falling back to keyword matching`);
      }
    }

    if (!directBookingEntry && !matchedNode) {
      const matchResult = await chatbotService.findMatchingRule(tenant.businessId, messageText);
      matchedNode = matchResult?.node || null;
      matchedEdges = matchResult?.edges || [];
    }

    // Step 14 — Prepare reply based on rule type
    let replyText = null;
    let triggeredRuleId = null;
    let bookingField = null; // set when booking_trigger (or a direct question-node tap) fires, for interactive rendering below
    // Set only in the no-rule-matched fallback branch below, when the
    // business has a greeting/menu reply node — its buttons are borrowed
    // for Step 16's outbound render so the fallback isn't a dead-end text
    // message. Deliberately kept separate from matchedNode/triggeredRuleId:
    // the fallback reply is not "from" this node for analytics/trigger-count
    // purposes, only its buttons are reused.
    let fallbackMenuNode = null;
    let fallbackMenuEdges = [];

    if (directBookingEntry) {
      // Button targeted a question node directly — start the graph right
      // there instead of following a booking_trigger node's single edge.
      triggeredRuleId = directBookingEntry.ruleId;
      const { session: newBookingSession, field: firstField } = await bookingGraphService.startGraphSessionAtNode(
        tenant.businessId,
        directBookingEntry.nodeId,
        directBookingEntry.ruleId,
        customer.preferredLanguage,
        directBookingEntry.edge
      );
      await bookingService.saveBookingSession(tenant.businessId, customerNumber, newBookingSession, tenant.phoneNumberId, tenant.accessToken);
      bookingService.recordBookingLead(tenant.businessId, customer.id).catch(err =>
        logger.error('Error recording booking lead:', err)
      );
      bookingField = firstField;
      replyText = applyMessageTemplateWithFooter(firstField.label, tenant, customer);

    } else if (matchedNode) {
      triggeredRuleId = matchedNode.id;

      if (matchedNode.replyKind === 'text') {
        // Simple text reply (may also carry an image and/or buttons).
        const localizedReply = getLocalizedText(matchedNode, 'label', customer.preferredLanguage);
        replyText = applyMessageTemplateWithFooter(localizedReply, tenant, customer);

      } else if (matchedNode.replyKind === 'booking_trigger') {
        // Start booking flow — ask first question. startGraphSession is
        // side-effect-free (mirrors advanceGraphSession) — unlike the old
        // startBookingSession, which saved the session internally, the
        // session it returns must be persisted here.
        const { session: newBookingSession, field: firstField } = await bookingGraphService.startGraphSession(
          tenant.businessId,
          matchedNode.id,
          customer.preferredLanguage
        );
        await bookingService.saveBookingSession(tenant.businessId, customerNumber, newBookingSession, tenant.phoneNumberId, tenant.accessToken);
        bookingService.recordBookingLead(tenant.businessId, customer.id).catch(err =>
          logger.error('Error recording booking lead:', err)
        );
        bookingField = firstField;
        replyText = applyMessageTemplateWithFooter(firstField.label, tenant, customer);

      } else if (matchedNode.replyKind === 'payment_trigger') {
        replyText = applyMessageTemplateWithFooter(matchedNode.label, tenant, customer) || 'Please complete your payment.';
      }
    } else {
      // No rule matched — try an AI-generated fallback (opt-in per business),
      // falling back to the static reply on any failure or timeout.
      let smartReply = null;
      if (tenant.enableSmartFallback) {
        try {
          smartReply = await Promise.race([
            smartFallbackService.getSmartFallbackReply(tenant.businessId, messageText),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000))
          ]);
        } catch (smartFallbackError) {
          logger.error('Error generating smart fallback reply:', smartFallbackError);
          smartReply = null;
        }
      }

      replyText = smartReply || applyMessageTemplate(tenant.fallbackReply, tenant, customer) || 'Thank you for your message. We will get back to you soon.';

      // Attach the business's greeting/menu buttons (if one is configured)
      // so the customer has a tappable way forward instead of a dead-end
      // text message. Probes the same rule-matching findMatchingRule uses
      // for a real "hi" greeting, with incrementCount:false since this is
      // not a real customer trigger of that node (see its doc comment).
      const greetingMatch = await chatbotService.findMatchingRule(tenant.businessId, 'hi', { incrementCount: false });
      if (greetingMatch?.node &&
          (greetingMatch.node.contentType === 'buttons' || greetingMatch.node.contentType === 'list') &&
          greetingMatch.edges.length > 0) {
        fallbackMenuNode = greetingMatch.node;
        fallbackMenuEdges = greetingMatch.edges;
      }
    }

    // Step 15 - Save outbound message
    const outboundMsg = await saveMessage({
      business_id: tenant.businessId,
      customer_id: customer.id,
      customer_number: customerNumber,
      direction: 'outbound',
      type: 'text',
      content: replyText,
      status: 'sent',
      triggered_rule_id: triggeredRuleId,
      is_read: true
    });

    // Step 16 - Queue outbound message. matchedNode's buttons/list options
    // are built from its outgoing flow_edges — nextKeyword is each edge's
    // own id (see chatbot.service.js's getOutgoingEdges), which comes back
    // unchanged as button_reply.id/list_reply.id and is resolved
    // structurally by Step 13's resolveTappedEdge on the next inbound tap.
    // matchedNode stays null in the no-rule-matched fallback branch above,
    // so this borrows fallbackMenuNode/fallbackMenuEdges (the greeting
    // node's buttons) for rendering only — matchedNode itself, and
    // therefore triggeredRuleId/outboundMsg.triggered_rule_id above, are
    // untouched.
    const buttonSourceNode = matchedNode || fallbackMenuNode;
    const buttonSourceEdges = matchedNode ? matchedEdges : fallbackMenuEdges;

    const localizedButtons = buttonSourceNode?.contentType === 'buttons'
      ? buttonSourceEdges.map(edge => ({
          nextKeyword: edge.nextKeyword,
          title: getLocalizedText(edge, 'label', customer.preferredLanguage)
        }))
      : [];
    const localizedListOptions = buttonSourceNode?.contentType === 'list'
      ? buttonSourceEdges.map(edge => ({
          nextKeyword: edge.nextKeyword,
          label: getLocalizedText(edge, 'label', customer.preferredLanguage),
          description: getLocalizedText(edge, 'description', customer.preferredLanguage)
        }))
      : [];

    const outboundJobData = {
      businessId: tenant.businessId,
      phoneNumberId: tenant.phoneNumberId,
      encryptedAccessToken: tenant.accessToken,
      to: customerNumber,
      message: replyText,
      type: 'text',
      imageUrl: matchedNode?.imageUrl || null,
      buttons: localizedButtons,
      listOptions: localizedListOptions,
      messageId: outboundMsg.id
    };
    if (bookingField && (bookingField.fieldType === 'buttons' || bookingField.fieldType === 'list')) {
      // Reuses the worker/whatsapp.service `step` job-data field to carry
      // the entry node's id under the graph engine's "{node_id}:{index}" id
      // scheme (see sendFieldPrompt's doc comment) instead of a numeric step.
      outboundJobData.step = bookingField.nodeId;
      const bookingFieldLabels = (bookingField.options || []).map(bookingService.normalizeOption).map(opt => opt.label);
      if (bookingField.fieldType === 'buttons') {
        outboundJobData.interactiveButtons = bookingFieldLabels;
      } else {
        outboundJobData.interactiveList = bookingFieldLabels;
        outboundJobData.listButtonLabel = 'Choose';
      }
    }

    if (matchedNode?.contentType === 'location') {
      // Reply node sends the business's own saved coordinates as a map pin
      // instead of authored text (matchedNode.label is '' for this
      // contentType -- see flowGraph.controller.js's createReplyNode/
      // saveFullGraph carve-out). outboundMsg was already saved above with
      // replyText ('' here), so reuse its id rather than saving a second row.
      const locationBusiness = await businessService.getBusinessById(tenant.businessId);
      if (locationBusiness?.businessLatitude != null && locationBusiness?.businessLongitude != null) {
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          messageId: outboundMsg.id,
          location: {
            latitude: locationBusiness.businessLatitude,
            longitude: locationBusiness.businessLongitude,
            name: locationBusiness.displayName || locationBusiness.name,
            address: locationBusiness.address || undefined
          }
        });
      } else {
        logger.warn(`Business ${tenant.businessId} matched a location-type reply node but has no businessLatitude/businessLongitude configured; sending fallback text instead.`);
        await addToWhatsappQueue({
          businessId: tenant.businessId,
          phoneNumberId: tenant.phoneNumberId,
          encryptedAccessToken: tenant.accessToken,
          to: customerNumber,
          message: 'Sorry, our location is not set up yet.',
          type: 'text',
          messageId: outboundMsg.id
        });
      }
    } else {
      await addToWhatsappQueue(outboundJobData);
    }

    // ADD THIS — Emit new_message to Flutter app with full customer object
    try {
      socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
        customer,
        message: outboundMsg,
        customerNumber
      });
    } catch (socketError) {
      logger.error('Error emitting new_message socket event:', socketError);
    }

    // Step 17 - Increment outbound usage (fire and forget)
    usageService.incrementUsage(tenant.businessId, 'outbound');

    logger.info(`Processed webhook for business ${tenant.businessId}, customer ${customerNumber}`);

  } catch (error) {
    logger.error('Error processing webhook:', error);
    // Already sent 200, so we just log the error
  }
};

module.exports = {
  verifyWebhook,
  receiveWebhook,
  // Exported for flowGraphPreview.controller.js to reuse rather than
  // duplicate the literal set.
  GREETING_KEYWORDS
};
