const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { toCamelCase } = require('../utils/caseConvert');
const usageService = require('./usage.service');
const socketService = require('./socket.service');
const categoryFeatureService = require('./categoryFeature.service');
const { addToWhatsappQueueAndWait } = require('../queues/whatsapp.queue');
const { applyMessageTemplate } = require('../utils/messageTemplating');
const { getLocalizedText } = require('../utils/localization');
const { getSystemMessage } = require('../utils/systemMessages');
const { buildInteractivePayload } = require('../utils/interactivePayload');
const { getCarouselMaxCards } = require('../utils/replyMediaLimits');
const { LIMITS, truncate } = require('../utils/textLimits');
const { resolveSettings } = require('../utils/catalogSettings');
const { planCatalogueCards, photoCaption, paginate } = require('../utils/catalogPayload');
const { buildPrefill } = require('../utils/catalogOrder');
const { parseCatalogTapId, pageId, collectionOrderId, itemOrderId, MENU_ID } = require('../utils/catalogIds');

// What a customer receives from the Catalogue (free session messages only - the customer has just written or
// tapped, so the 24h window is open). Entered from webhook.controller.js:
//   handleCatalogueNode  the catalogue reply node matched (typed keyword, or a menu button into it)
//   handleTap            a "cat:" button (View designs / Show more / Order / Catalogue)
//   claimTapPayload      a "cat:" payload that arrived as a message of type 'button'
//
// Everything is read live (settings, collections, photos), so an owner's edit applies to the very next
// message; nothing here is cached. Messages of one page are sent one after the other (queue + wait) so they
// arrive in order, and a whole page / carousel / order reply counts as ONE outbound usage unit.
//
// ctx = { tenant, customer, customerNumber }; tenant.plan limits the carousel's cards.

const must = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};

// ---- small helpers ------------------------------------------------------------------------------------

const label = (settings, key, builtIn, language) => {
  const custom = getLocalizedText(settings, key, language);
  const text = typeof custom === 'string' && custom.trim() ? custom.trim() : getSystemMessage(builtIn, language);
  return truncate(text, LIMITS.BUTTON_TITLE);
};

const message = (settings, key, builtIn, language) => {
  const custom = getLocalizedText(settings, key, language);
  return typeof custom === 'string' && custom.trim() ? custom.trim() : getSystemMessage(builtIn, language);
};

/**
 * Fire-and-forget counters for the Insights tab; never delays or breaks the reply. ctx.broadcastId (set by
 * handleTap for a tap on a "Send catalogue" broadcast's card) marks that tap's events source 'broadcast'; every
 * other event is written exactly as before (no source / broadcast_id columns in the row).
 */
const logEvents = (ctx, events) => {
  if (!events.length) return;
  const rows = events.map(e => ({
    business_id: ctx.tenant.businessId, customer_id: ctx.customer.id,
    event: e.event, collection_id: e.collectionId || null, item_id: e.itemId || null,
    ...(ctx.broadcastId ? { source: 'broadcast', broadcast_id: ctx.broadcastId } : {})
  }));
  Promise.resolve(supabase.from('catalog_events').insert(rows))
    .then(({ error }) => { if (error) logger.error('Catalogue event log failed:', error.message); })
    .catch(err => logger.error('Catalogue event log failed:', err.message));
};

/**
 * Saves the outbound row, sends the job (awaited, so order holds) and tells the dashboard. Never throws: a
 * failed send is logged and the next message still goes. Usage is NOT counted here (once per reply, see the
 * callers).
 */
const sendOne = async (ctx, { content, rowType = 'text', mediaUrl = null, interactivePayload = null, ruleId = null, job }) => {
  const { tenant, customer, customerNumber } = ctx;
  let row = null;
  try {
    const { data, error } = await supabase.from('messages').insert({
      business_id: tenant.businessId, customer_id: customer.id, customer_number: customerNumber,
      direction: 'outbound', type: rowType, content, media_url: mediaUrl, status: 'sent',
      triggered_rule_id: ruleId, sender_type: 'bot', interactive_payload: interactivePayload, is_read: true
    }).select().single();
    if (error) throw error;
    row = toCamelCase(data);
  } catch (error) {
    logger.error('Catalogue: could not save the outbound message row:', { message: error.message });
  }
  try {
    await addToWhatsappQueueAndWait({
      businessId: tenant.businessId, phoneNumberId: tenant.phoneNumberId, encryptedAccessToken: tenant.accessToken,
      to: customerNumber, ...job, ...(row ? { messageId: row.id } : {})
    });
  } catch (error) {
    logger.error('Catalogue: sending a message failed:', { businessId: tenant.businessId, message: error.message });
  }
  if (row) {
    try {
      socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', { customer, message: row, customerNumber });
    } catch (socketError) {
      logger.error('Error emitting socket event:', socketError);
    }
  }
};

const countUsage = (tenant) => {
  Promise.resolve(usageService.incrementUsage(tenant.businessId, 'outbound'))
    .catch(err => logger.error('Error incrementing outbound usage:', err));
};

const sendText = async (ctx, text, ruleId = null) => {
  await sendOne(ctx, { content: text, ruleId, job: { type: 'text', message: text } });
};

// ---- state --------------------------------------------------------------------------------------------

/** The catalogue as the customer should see it right now: settings, whether it is on, active collections. */
const loadState = async (ctx) => {
  const { tenant } = ctx;
  const rows = must(await supabase.from('catalogs').select('settings').eq('business_id', tenant.businessId));
  const settings = resolveSettings(rows[0] ? rows[0].settings : null);
  let featureOn = true;
  try {
    featureOn = await categoryFeatureService.isEnabled(tenant.businessCategory, 'catalogue', tenant.businessId);
  } catch (error) {
    logger.error('Catalogue feature check failed, treating it as on:', error.message);
  }
  const collections = (settings.enabled && featureOn)
    ? must(await supabase.from('catalog_collections').select('*').eq('business_id', tenant.businessId).eq('is_active', true)
      .order('sort_order', { ascending: true }).order('created_at', { ascending: true })).map(toCamelCase)
    : [];
  return { settings, on: settings.enabled && featureOn, collections };
};

const localizedFields = (row, language) => ({
  id: row.id,
  title: getLocalizedText(row, 'title', language) || row.title,
  body: getLocalizedText(row, 'body', language) || '',
  priceLabel: getLocalizedText(row, 'priceLabel', language) || ''
});

const mediaUrls = async (businessId, ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = must(await supabase.from('business_media').select('id, url, media_type').eq('business_id', businessId).in('id', unique));
  return new Map(rows.filter(r => r.media_type === 'image').map(r => [r.id, r.url]));
};

const getCatalogueNodeId = async (businessId) => {
  try {
    const rows = must(await supabase.from('flow_nodes').select('id').eq('business_id', businessId).eq('content_type', 'catalog'));
    return rows[0] ? rows[0].id : null;
  } catch {
    return null;
  }
};

// ---- replies ------------------------------------------------------------------------------------------

const sendEmpty = async (ctx, settings, ruleId) => {
  const text = applyMessageTemplate(message(settings, 'emptyText', 'catalogEmptyText', ctx.customer.preferredLanguage), ctx.tenant, ctx.customer);
  await sendText(ctx, text, ruleId);
  countUsage(ctx.tenant);
};

/** The carousel of collections (native Meta carousel, or one message per card - the worker decides on a Meta 4xx). */
const sendCatalogue = async (ctx, { ruleId = null, state = null } = {}) => {
  const { tenant, customer } = ctx;
  const language = customer.preferredLanguage;
  const current = state || await loadState(ctx);
  const { settings } = current;
  const resolvedRuleId = ruleId || await getCatalogueNodeId(tenant.businessId);

  if (!current.on || current.collections.length === 0) {
    await sendEmpty(ctx, settings, resolvedRuleId);
    return;
  }

  const items = must(await supabase.from('catalog_items').select('collection_id, media_id, sort_order')
    .eq('business_id', tenant.businessId).in('collection_id', current.collections.map(c => c.id))
    .order('sort_order', { ascending: true }));
  const firstMedia = new Map();
  for (const item of items) if (!firstMedia.has(item.collection_id)) firstMedia.set(item.collection_id, item.media_id);
  const urls = await mediaUrls(tenant.businessId, current.collections.flatMap(c => [c.coverMediaId, firstMedia.get(c.id)]));

  const collections = current.collections.map(row => ({
    ...localizedFields(row, language),
    mediaUrl: urls.get(row.coverMediaId) || urls.get(firstMedia.get(row.id)) || null
  }));
  const plan = planCatalogueCards({
    collections,
    maxCards: getCarouselMaxCards(tenant.plan),
    viewLabel: label(settings, 'viewButtonLabel', 'catalogViewButton', language),
    orderLabel: settings.orderAction ? label(settings, 'orderButtonLabel', 'catalogOrderButton', language) : null
  });
  if (plan.skipped.overPlan > 0) {
    logger.info(`Catalogue (business ${tenant.businessId}): ${plan.skipped.overPlan} active collection(s) not shown, over the plan's card limit`);
  }

  const body = applyMessageTemplate(message(settings, 'text', 'catalogDefaultText', language), tenant, customer);
  await sendOne(ctx, {
    content: body, ruleId: resolvedRuleId,
    interactivePayload: buildInteractivePayload({ message: body, carouselCards: plan.cards }),
    job: { type: 'carousel', message: body, imageUrl: null, carouselCards: plan.cards, carouselNative: plan.native }
  });
  countUsage(tenant);

  const shownIds = plan.cards.map(card => parseCatalogTapId(card.buttons[0].nextKeyword)).filter(Boolean).map(t => t.collectionId);
  logEvents(ctx, [{ event: 'catalogue_open' }, ...shownIds.map(collectionId => ({ event: 'collection_view', collectionId }))]);
};

/** One page of a collection's photos, then Show more / Order / Catalogue. */
const sendDesigns = async (ctx, collectionId, requestedPage) => {
  const { tenant, customer } = ctx;
  const language = customer.preferredLanguage;
  const state = await loadState(ctx);
  const { settings } = state;
  const ruleId = await getCatalogueNodeId(tenant.businessId);

  if (!state.on) { await sendEmpty(ctx, settings, ruleId); return; }
  const row = state.collections.find(c => c.id === collectionId);
  if (!row) { await sendStale(ctx, state, ruleId); return; }

  const collection = localizedFields(row, language);
  const items = must(await supabase.from('catalog_items').select('*').eq('collection_id', collectionId).eq('business_id', tenant.businessId)
    .order('sort_order', { ascending: true }).order('created_at', { ascending: true })).map(toCamelCase);
  const menuLabel = label(settings, 'menuLabel', 'catalogMenuLabel', language);
  const orderEnabled = !!settings.orderAction;
  const orderLabel = label(settings, 'orderButtonLabel', 'catalogOrderButton', language);

  if (items.length === 0) {
    await sendOne(ctx, {
      content: getSystemMessage('catalogCollectionEmpty', language, { title: collection.title }), ruleId,
      job: { type: 'text', message: getSystemMessage('catalogCollectionEmpty', language, { title: collection.title }), buttons: [{ nextKeyword: MENU_ID, title: menuLabel }] }
    });
    countUsage(tenant);
    return;
  }

  const page = paginate(items.length, requestedPage, settings.photosPerPage);
  const pageItems = items.slice(page.offset, page.offset + page.limit);
  const urls = await mediaUrls(tenant.businessId, pageItems.map(i => i.mediaId));
  const orderThis = truncate(getSystemMessage('catalogOrderThisButton', language), LIMITS.BUTTON_TITLE);

  for (const item of pageItems) {
    const url = urls.get(item.mediaId);
    if (!url) { logger.info(`Catalogue photo ${item.id} no longer resolves, skipped`); continue; }
    const caption = photoCaption({
      designNo: item.designNo, priceText: item.priceText, caption: getLocalizedText(item, 'caption', language)
    });
    if (settings.photoStyle === 'order_button' && orderEnabled) {
      // An interactive message needs a body: the collection's title stands in for a photo with no text.
      const body = truncate(caption || collection.title, LIMITS.INTERACTIVE_BODY);
      const buttons = [{ nextKeyword: itemOrderId(item.id), title: orderThis }];
      await sendOne(ctx, {
        content: body, ruleId, interactivePayload: buildInteractivePayload({ message: body, imageUrl: url, buttons }),
        job: { type: 'text', message: body, imageUrl: url, buttons }
      });
    } else {
      await sendOne(ctx, { content: caption, rowType: 'image', mediaUrl: url, ruleId, job: { type: 'text', message: caption, imageUrl: url } });
    }
  }

  const summary = getSystemMessage('catalogPageSummary', language, {
    from: page.from, to: page.to, total: items.length, title: collection.title
  });
  const controls = [
    ...(page.hasMore ? [{ nextKeyword: pageId(collectionId, page.page + 1), title: label(settings, 'showMoreLabel', 'catalogShowMoreButton', language) }] : []),
    ...(orderEnabled ? [{ nextKeyword: collectionOrderId(collectionId), title: orderLabel }] : []),
    { nextKeyword: MENU_ID, title: menuLabel }
  ];
  const body = truncate(summary, LIMITS.INTERACTIVE_BODY);
  await sendOne(ctx, {
    content: body, ruleId, interactivePayload: buildInteractivePayload({ message: body, buttons: controls }),
    job: { type: 'text', message: body, buttons: controls }
  });

  countUsage(tenant);   // the whole page - photos and the buttons message - is one usage unit
  logEvents(ctx, [{ event: page.page === 0 ? 'designs_view' : 'designs_more', collectionId }]);
};

/** The tapped collection / photo is gone (deleted or switched off): say so and show the catalogue again. */
const sendStale = async (ctx, state, ruleId) => {
  const text = getSystemMessage('catalogTapStale', ctx.customer.preferredLanguage);
  await sendText(ctx, text, ruleId);
  countUsage(ctx.tenant);
  await sendCatalogue(ctx, { ruleId, state });
};

/**
 * Order tap. Returns { handled: true } when answered here (a message order, or a stale / disabled tap), or
 * { handled: false, orderNode, prefill } for a booking_trigger / web_form_trigger action: the webhook then
 * runs that node through its normal Step 14 branch with the prefill.
 */
const startOrder = async (ctx, tap) => {
  const { tenant, customer } = ctx;
  const language = customer.preferredLanguage;
  const state = await loadState(ctx);
  const { settings } = state;
  const ruleId = await getCatalogueNodeId(tenant.businessId);
  if (!state.on) { await sendEmpty(ctx, settings, ruleId); return { handled: true }; }

  let collectionRow;
  let itemRow = null;
  if (tap.kind === 'item_order') {
    itemRow = must(await supabase.from('catalog_items').select('*').eq('id', tap.itemId).eq('business_id', tenant.businessId))[0] || null;
    collectionRow = itemRow ? state.collections.find(c => c.id === itemRow.collection_id) : null;
  } else {
    collectionRow = state.collections.find(c => c.id === tap.collectionId);
  }
  const action = settings.orderAction;
  if (!collectionRow || !action) {
    if (!collectionRow) await sendStale(ctx, state, ruleId);
    else { await sendText(ctx, getSystemMessage('catalogOrderMessageDefault', language), ruleId); countUsage(tenant); }
    return { handled: true };
  }

  // The booking records the owner-side (base language) title, design number and price.
  const prefill = buildPrefill({
    collection: { title: collectionRow.title, priceLabel: collectionRow.priceLabel },
    item: itemRow ? { designNo: itemRow.design_no, priceText: itemRow.price_text } : null
  });
  logEvents(ctx, [{ event: itemRow ? 'order_item' : 'order_collection', collectionId: collectionRow.id, itemId: itemRow ? itemRow.id : null }]);

  if (action.type === 'message') {
    const custom = getLocalizedText(action, 'text', language);
    const text = applyMessageTemplate(
      typeof custom === 'string' && custom.trim() ? custom.trim() : getSystemMessage('catalogOrderMessageDefault', language),
      tenant, customer
    );
    await sendText(ctx, text, ruleId);
    countUsage(tenant);
    return { handled: true };
  }

  const nodes = must(await supabase.from('flow_nodes').select('*').eq('id', action.nodeId).eq('business_id', tenant.businessId));
  const node = nodes[0];
  if (!node || node.node_type !== 'reply' || node.reply_kind !== action.type) {
    logger.error('Catalogue order action points at a missing / wrong reply node, sending the default order message', {
      businessId: tenant.businessId, nodeId: action.nodeId, type: action.type
    });
    await sendText(ctx, getSystemMessage('catalogOrderMessageDefault', language), ruleId);
    countUsage(tenant);
    return { handled: true };
  }
  return { handled: false, orderNode: toCamelCase(node), prefill };
};

// ---- entry points -------------------------------------------------------------------------------------

/** The catalogue reply node matched. */
const handleCatalogueNode = async (ctx, node) => {
  await sendCatalogue(ctx, { ruleId: node && node.id });
};

/**
 * A tap whose id carries ":b:<broadcastId>" came from a catalogue broadcast's card: ctx.broadcastId is set when
 * that broadcast is a catalogue broadcast of THIS business (a forged or stale id is just a normal tap).
 */
const withBroadcastSource = async (ctx, tap) => {
  if (!tap.broadcastId) return ctx;
  try {
    const rows = must(await supabase.from('broadcasts').select('id').eq('id', tap.broadcastId)
      .eq('business_id', ctx.tenant.businessId).eq('kind', 'catalog'));
    return rows.length > 0 ? { ...ctx, broadcastId: tap.broadcastId } : ctx;
  } catch (error) {
    logger.error('Catalogue: could not check the broadcast of a tap, counting it as a normal tap:', { message: error.message });
    return ctx;
  }
};

/**
 * A "cat:" tap (parseCatalogTapId result). Never throws.
 * @returns {Promise<{ handled: true } | { handled: false, orderNode: Object, prefill: Object[] }>}
 */
const handleTap = async (ctx, tap) => {
  try {
    ctx = await withBroadcastSource(ctx, tap);
    if (tap.kind === 'menu') await sendCatalogue(ctx);
    else if (tap.kind === 'page') await sendDesigns(ctx, tap.collectionId, tap.page);
    else return await startOrder(ctx, tap);
    return { handled: true };
  } catch (error) {
    logger.error('Error handling a catalogue tap:', { businessId: ctx.tenant.businessId, message: error.message, stack: error.stack });
    return { handled: true };
  }
};

/**
 * A "cat:" payload delivered as a message of type 'button' (how a card button tap may arrive): the payload only
 * when it is a well-formed catalogue id whose collection / photo belongs to THIS business, else null (a template
 * quick-reply keeps its own handling).
 */
const claimTapPayload = async (businessId, payload) => {
  const tap = parseCatalogTapId(payload);
  if (!tap) return null;
  if (tap.kind === 'menu') return payload;
  const table = tap.kind === 'item_order' ? 'catalog_items' : 'catalog_collections';
  const id = tap.kind === 'item_order' ? tap.itemId : tap.collectionId;
  const rows = must(await supabase.from(table).select('id').eq('id', id).eq('business_id', businessId));
  return rows.length > 0 ? payload : null;
};

module.exports = { handleCatalogueNode, handleTap, claimTapPayload, sendCatalogue, sendDesigns, loadState };
