// "Send catalogue": a Meta media-card CAROUSEL marketing template built from the Catalogue's collections and sent
// as a broadcast. The routes are routes/catalogBroadcast.routes.js (mounted at /api/catalog/broadcast).
//
//   previewCatalogBroadcast  what a send would do: the cards, which collections are left out and why, the template
//                            status per language, the audience and the cost. Read-only.
//   sendCatalogBroadcast     check the same things, create + submit the reusable templates that don't exist yet
//                            (answer 202 until they are approved), then claim / debit / queue exactly like
//                            broadcast.controller.js#sendBroadcast does for a template broadcast.
//   ensureTemplates          create + submit the missing templates (also used by scripts/testCatalogCarouselTemplate.js)
//
// The templates themselves (names, wording, components) are utils/catalogCarouselTemplate.js. The worker
// (queues/broadcast.worker.js) sends a job that carries `catalog`; every other job is unchanged.
// Every function answers { status, message, data?, errors? } - the controller only maps that to the envelope.
const crypto = require('crypto');
const axios = require('axios');
const supabase = require('../config/supabase');
const config = require('../config/env');
const logger = require('../utils/logger');
const businessService = require('./business.service');
const walletService = require('./wallet.service');
const rateCardService = require('./rateCard.service');
const { META_API_BASE, uploadImageFromUrl } = require('./whatsapp.service');
const { uploadHeaderHandle } = require('./templateSubmit.service');
const { planOf } = require('./catalog.service');
const { listCollections } = require('./catalogCollection.service');
const { BATCH_SIZE, chunk, createRecipientRows, removeRecipientRows } = require('./broadcastDispatch.service');
const {
  normalizeAudience, resolveAudience, audienceSummary, businessGroupIds, businessCustomerIds
} = require('./broadcastAudience.service');
const { decrypt } = require('../utils/crypto');
const { resolveSettings } = require('../utils/catalogSettings');
const { isUuid } = require('../utils/catalogValidation');
const { extensionOf } = require('../utils/templateSendSupport');
const { templateStatusFromMeta } = require('../utils/templateStatus');
const { getLocalizedText } = require('../utils/localization');
const { pageId, collectionOrderId } = require('../utils/catalogIds');
const tpl = require('../utils/catalogCarouselTemplate');

const MAX_SELECTED = 50;                      // collection ids accepted in one request
const SENDABLE_EXTENSIONS = ['jpg', 'jpeg', 'png'];
const MARKETING = 'MARKETING';
const NOT_SENDABLE = ['rejected', 'paused', 'disabled'];  // statuses that cannot become approved by waiting
const PENDING_MESSAGE = 'Waiting for Meta approval — usually minutes, up to 24h. Send again once the templates are approved.';

const must = ({ data, error }) => {
  if (error) throw error;
  return data || [];
};
const reply = (status, message, data, errors) => ({ status, message, ...(data !== undefined ? { data } : {}), ...(errors ? { errors } : {}) });

// ---- the cards ----------------------------------------------------------------------------------------------

const SKIP_MESSAGE = {
  not_found: (c) => `Collection ${c.collectionId} was not found.`,
  inactive: (c) => `'${c.title}' is switched off - turn it on in Catalogue to include it.`,
  no_cover: (c) => `'${c.title}' has no cover photo and no photos - add one in Catalogue.`,
  over_plan_cap: (c, cap) => `Your plan shows up to ${cap} collections in a carousel, so '${c.title}' was left out.`
};

/**
 * Which of the requested collections make cards. Active ones with a cover, in the order asked for, at most the
 * plan's carousel limit (and 10); the others come back in `skipped` with a reason. A cover Meta can't take
 * (WebP...) is not skipped - it is an `issue`, because the owner can fix it and the send is blocked until then.
 */
const selectCards = async (businessId, collectionIds) => {
  if (!Array.isArray(collectionIds) || collectionIds.length === 0) {
    return { error: reply(400, 'Choose at least 2 collections.', undefined, { code: 'INVALID_REQUEST' }) };
  }
  if (collectionIds.length > MAX_SELECTED || !collectionIds.every((id) => typeof id === 'string' && isUuid(id))) {
    return { error: reply(400, `collectionIds must be a list of up to ${MAX_SELECTED} collection ids.`, undefined, { code: 'INVALID_REQUEST' }) };
  }
  const ids = [...new Set(collectionIds.map((id) => id.toLowerCase()))];
  const [all, { carouselMaxCards }] = await Promise.all([listCollections(businessId), planOf(businessId)]);
  const byId = new Map(all.map((c) => [c.id, c]));
  const cap = Math.min(carouselMaxCards, tpl.MAX_CARDS);

  const usable = [];
  const skipped = [];
  const skip = (c, reason, id) => {
    const entry = { collectionId: id, title: c ? c.title : null, reason };
    skipped.push({ ...entry, message: SKIP_MESSAGE[reason](entry, cap) });
  };
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) skip(null, 'not_found', id);
    else if (!c.isActive) skip(c, 'inactive', id);
    else if (!c.coverUrl) skip(c, 'no_cover', id);
    else if (usable.length >= cap) skip(c, 'over_plan_cap', id);
    else usable.push(c);
  }

  const issues = usable.filter((c) => {
    const ext = extensionOf(c.coverUrl);
    return ext && !SENDABLE_EXTENSIONS.includes(ext);
  }).map((c) => ({
    code: 'WEBP_COVER',
    collectionId: c.id,
    message: extensionOf(c.coverUrl) === 'webp'
      ? `Cover of '${c.title}' is WebP — choose another cover or re-upload in Catalogue.`
      : `Cover of '${c.title}' is not a JPG or PNG — choose another cover or re-upload in Catalogue.`
  }));
  return { cards: usable, skipped, issues, planMaxCards: carouselMaxCards };
};

const catalogueSettings = async (businessId) => {
  const rows = must(await supabase.from('catalogs').select('settings').eq('business_id', businessId));
  return resolveSettings(rows[0] ? rows[0].settings : null);
};

/** Blocking problems with a selection, as [{ code, message, collectionId? }]. */
const selectionErrors = (selection, settings) => {
  const errors = [];
  if (!settings.enabled) errors.push({ code: 'CATALOGUE_DISABLED', message: 'The catalogue is switched off, so customers would get no designs. Switch it on in Catalogue first.' });
  errors.push(...selection.issues);
  if (selection.cards.length < tpl.MIN_CARDS) {
    errors.push({ code: 'TOO_FEW_CARDS', message: `A carousel needs at least ${tpl.MIN_CARDS} collections that are on and have a cover; ${selection.cards.length} can be used.` });
  }
  return errors;
};

// ---- the templates ------------------------------------------------------------------------------------------

const describe = (lang, cardCount, buttonCount, row) => ({
  language: lang,
  metaLanguage: tpl.metaLanguageOf(lang),
  name: tpl.templateName(cardCount, lang, buttonCount),
  templateId: row ? row.id : null,
  status: row && row.status !== 'deleted' ? row.status : 'missing',
  rejectionReason: row && row.status === 'rejected' ? (row.rejection_reason || null) : null
});

/** The stored template row (or none) for each language, as descriptors: { language, name, templateId, status, ... }. */
const loadTemplates = async (businessId, cardCount, buttonCount, langs) => {
  const names = langs.map((lang) => tpl.templateName(cardCount, lang, buttonCount));
  const rows = must(await supabase.from('message_templates').select('id, name, language, status, rejection_reason, created_at')
    .eq('business_id', businessId).eq('kind', 'catalog_carousel').in('name', names)
    .order('created_at', { ascending: false }));
  return langs.map((lang) => {
    const name = tpl.templateName(cardCount, lang, buttonCount);
    const forName = rows.filter((r) => r.name === name && r.language === tpl.metaLanguageOf(lang));
    // A row Meta no longer lists is 'deleted'; a live one wins over it.
    return describe(lang, cardCount, buttonCount, forName.find((r) => r.status !== 'deleted') || null);
  });
};

const metaErrorText = (error) => {
  const e = error && error.response && error.response.data && error.response.data.error;
  return (e && (e.error_user_msg || e.message)) || (error && error.message) || 'unknown error';
};

/**
 * Create the row (if there is none to reuse) and submit one template to Meta: one sample header handle per card
 * (resumable upload of that card's picture), then POST /{waba}/message_templates.
 */
const submitTemplate = async (business, accessToken, { cardCount, lang, buttonCount, sampleUrls }, existingId) => {
  const errors = tpl.validateSpec({ cardCount, lang, buttonCount });
  if (errors.length > 0) throw new Error(errors[0]);

  let id = existingId;
  if (!id) {
    const { data, error } = await supabase.from('message_templates').insert({
      business_id: business.id,
      name: tpl.templateName(cardCount, lang, buttonCount),
      category: MARKETING,
      language: tpl.metaLanguageOf(lang),
      body_text: tpl.GREETING[lang],
      variable_count: 1,
      variable_samples: [tpl.SAMPLE_NAME[lang]],
      header_type: 'NONE',
      meta_components: tpl.buildStoredComponents({ cardCount, lang, buttonCount }),
      status: 'draft',
      kind: 'catalog_carousel',
      // Never a normal broadcast / follow-up template: only this service sends it.
      send_support: 'unsupported_component'
    }).select('id').single();
    if (error) {
      // uq_msg_templates_business_name_lang_unregistered: a draft from a racing request - use it.
      if (error.code !== '23505') throw error;
      const { data: existing } = await supabase.from('message_templates').select('id')
        .eq('business_id', business.id).eq('name', tpl.templateName(cardCount, lang, buttonCount)).is('meta_template_id', null).maybeSingle();
      if (!existing) throw error;
      id = existing.id;
    } else {
      id = data.id;
    }
  }

  const headerHandles = [];
  for (const url of sampleUrls.slice(0, cardCount)) headerHandles.push(await uploadHeaderHandle({ url, accessToken }));
  const payload = tpl.buildCreatePayload({ cardCount, lang, buttonCount, headerHandles });
  const response = await axios.post(`${META_API_BASE}/${business.wabaId}/message_templates`, payload, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
  });
  const { error: updateErr } = await supabase.from('message_templates').update({
    meta_template_id: String(response.data.id),
    status: templateStatusFromMeta(response.data.status) || 'pending',
    meta_status: response.data.status || 'PENDING',
    rejection_reason: null,
    submitted_at: new Date().toISOString()
  }).eq('id', id).eq('business_id', business.id);
  if (updateErr) throw updateErr;
};

/**
 * Submit every template in `descriptors` that is missing, still a draft or was rejected (rejected ones are tried
 * again). Pending / approved / paused / disabled are left alone. Never throws for one template's failure: that
 * descriptor gets `submitError` and the rest carry on.
 * @param {Object} business  camelCase business (wabaId, accessToken encrypted)
 * @param {{ cardCount: number, buttonCount: number, sampleUrls: string[] }} spec
 * @param {Object[]} descriptors  from loadTemplates
 * @returns {Promise<Object[]>} descriptors with the new status ('pending' after a submit)
 */
const ensureTemplates = async (business, { cardCount, buttonCount, sampleUrls }, descriptors) => {
  const accessToken = decrypt(business.accessToken);
  const out = [];
  for (const d of descriptors) {
    if (!['missing', 'draft', 'rejected'].includes(d.status)) { out.push(d); continue; }
    try {
      await submitTemplate(business, accessToken, { cardCount, lang: d.language, buttonCount, sampleUrls }, d.templateId);
      logger.info('Catalogue broadcast template submitted', { businessId: business.id, name: d.name });
      out.push({ ...d, status: 'pending', rejectionReason: null, submitted: true });
    } catch (error) {
      logger.error('Catalogue broadcast template could not be submitted', { businessId: business.id, name: d.name, error: error.response?.data || error.message });
      out.push({ ...d, submitError: metaErrorText(error) });
    }
  }
  return out;
};

// ---- audience, languages, cost ------------------------------------------------------------------------------

const audienceOf = async (businessId, body) => {
  const audience = normalizeAudience(body.audienceFilter, body.audienceParams);
  if (audience.error) return { error: reply(400, audience.error, undefined, { code: 'INVALID_AUDIENCE' }) };
  if (audience.filter === 'groups') {
    const found = await businessGroupIds(businessId, audience.params.groupIds);
    if (found.length !== audience.params.groupIds.length) return { error: reply(404, 'One or more of the chosen groups were not found', undefined, { code: 'NOT_FOUND' }) };
  }
  if (audience.filter === 'customers') {
    const found = await businessCustomerIds(businessId, audience.params.customerIds);
    if (found.length !== audience.params.customerIds.length) return { error: reply(404, 'One or more of the chosen customers were not found', undefined, { code: 'NOT_FOUND' }) };
  }
  return { audience };
};

/** { en: 12, hi: 3 }: how many recipients each template language is wanted for (a language without wording counts as English). */
const wantedLanguages = (customers) => {
  const counts = { [tpl.FALLBACK_LANGUAGE]: 0 };
  for (const c of customers) {
    const lang = tpl.templateLanguageFor(c.preferred_language);
    counts[lang] = (counts[lang] || 0) + 1;
  }
  return counts;
};

const rateOf = async (informational) => {
  try {
    return await rateCardService.getRateForMessage('IN', 'marketing');
  } catch (error) {
    if (!informational) throw error;
    logger.warn('Catalogue broadcast: rate card lookup failed, cost shown as unknown', { message: error.message });
    return null;
  }
};

const costOf = (rate, recipients) => ({
  category: 'marketing',
  ratePerMessagePaise: rate,
  estimatedPaise: rate === null ? null : rate * recipients,
  walletBilling: !!config.WALLET_BILLING_ENABLED
});

// ---- preview ------------------------------------------------------------------------------------------------

/**
 * POST /api/catalog/broadcast/preview  Body { collectionIds, audienceFilter?, audienceParams? }
 * Creates and sends nothing.
 */
const previewCatalogBroadcast = async (businessId, body) => {
  const selection = await selectCards(businessId, body.collectionIds);
  if (selection.error) return selection.error;
  const { error: audienceError, audience } = await audienceOf(businessId, body);
  if (audienceError) return audienceError;

  const settings = await catalogueSettings(businessId);
  const errors = selectionErrors(selection, settings);
  const customers = await resolveAudience(businessId, audience.filter, audience.params, { category: MARKETING });
  const summary = await audienceSummary(businessId, audience.filter, audience.params, { category: MARKETING });
  const cap = config.MAX_BROADCAST_RECIPIENTS;
  if (customers.length === 0) errors.push({ code: 'NO_RECIPIENTS', message: 'Nobody in this audience can receive a marketing message (not opted in, opted out, blocked, or no valid number).' });
  if (customers.length > cap) errors.push({ code: 'TOO_MANY_RECIPIENTS', message: `This audience has ${customers.length} eligible recipients, above the limit of ${cap}.` });

  const cardCount = selection.cards.length;
  const buttonCount = settings.orderAction ? 2 : 1;
  const wanted = wantedLanguages(customers);
  const languages = cardCount >= tpl.MIN_CARDS && cardCount <= tpl.MAX_CARDS
    ? (await loadTemplates(businessId, cardCount, buttonCount, Object.keys(wanted))).map((d) => ({ ...d, recipients: wanted[d.language] }))
    : [];
  const english = languages.find((d) => d.language === tpl.FALLBACK_LANGUAGE);
  const templatesReady = !!english && english.status === 'approved';
  const rate = await rateOf(true);

  return reply(200, 'OK', {
    cards: selection.cards.map((c) => ({ collectionId: c.id, title: c.title, priceLabel: c.priceLabel || null, coverUrl: c.coverUrl })),
    skipped: selection.skipped,
    errors,
    cardCount,
    planMaxCards: selection.planMaxCards,
    orderButton: buttonCount === 2,
    buttonCount,
    languages,
    templatesReady,
    canPrepare: errors.length === 0,
    canSend: errors.length === 0 && templatesReady,
    audience: { ...summary, overCap: summary.willReceive > cap, cap },
    cost: costOf(rate, customers.length)
  });
};

// ---- send ---------------------------------------------------------------------------------------------------

const defaultName = (cards) => {
  const titles = cards.slice(0, 2).map((c) => c.title).join(', ');
  return `Catalogue: ${titles}${cards.length > 2 ? ` +${cards.length - 2}` : ''}`.slice(0, 100);
};

/**
 * POST /api/catalog/broadcast  Body { collectionIds, audienceFilter?, audienceParams?, name?, prepareOnly? }
 *   201 sent to the queue | 202 templates not approved yet (nothing created or sent) | 400 | 404 | 502
 * The English template must be approved; another language whose template isn't yet is sent English.
 */
const sendCatalogBroadcast = async (businessId, body) => {
  const selection = await selectCards(businessId, body.collectionIds);
  if (selection.error) return selection.error;
  const { error: audienceError, audience } = await audienceOf(businessId, body);
  if (audienceError) return audienceError;

  const settings = await catalogueSettings(businessId);
  const selectionProblems = selectionErrors(selection, settings);
  if (selectionProblems.length > 0) {
    return reply(400, selectionProblems[0].message, undefined, { code: selectionProblems[0].code, problems: selectionProblems, skipped: selection.skipped });
  }

  const business = await businessService.getBusinessById(businessId);
  if (!business || !business.isWhatsappConnected || !business.phoneNumberId || !business.wabaId || !business.accessToken) {
    return reply(400, 'WhatsApp is not connected to this business', undefined, { code: 'WHATSAPP_NOT_CONNECTED' });
  }

  const customers = await resolveAudience(businessId, audience.filter, audience.params, { category: MARKETING });
  if (customers.length === 0) {
    return reply(400, 'Nobody in this audience can receive a marketing message (not opted in, opted out, blocked, or no valid number).', undefined, { code: 'NO_RECIPIENTS' });
  }
  if (customers.length > config.MAX_BROADCAST_RECIPIENTS) {
    return reply(400, `This broadcast has ${customers.length} eligible recipients, which exceeds the current limit of ${config.MAX_BROADCAST_RECIPIENTS}. Contact support to send larger broadcasts.`, undefined, { code: 'TOO_MANY_RECIPIENTS' });
  }

  const cards = selection.cards;
  const cardCount = cards.length;
  const buttonCount = settings.orderAction ? 2 : 1;
  const wanted = wantedLanguages(customers);

  // Templates: create what is missing (the samples are this send's covers), then see what can be used now.
  let templates = await loadTemplates(businessId, cardCount, buttonCount, Object.keys(wanted));
  const blocked = templates.find((d) => d.language === tpl.FALLBACK_LANGUAGE && ['paused', 'disabled'].includes(d.status));
  if (blocked) {
    return reply(400, `The English carousel template is ${blocked.status} on WhatsApp.`, undefined, { code: 'TEMPLATE_BLOCKED', templates: templates.map((d) => ({ ...d, recipients: wanted[d.language] })) });
  }
  templates = await ensureTemplates(business, { cardCount, buttonCount, sampleUrls: cards.map((c) => c.coverUrl) }, templates);
  const english = templates.find((d) => d.language === tpl.FALLBACK_LANGUAGE);
  const listed = templates.map((d) => ({ ...d, recipients: wanted[d.language] }));
  if (english.submitError) {
    return reply(400, `The English carousel template could not be submitted to Meta: ${english.submitError}`, undefined, { code: 'TEMPLATE_SUBMIT_FAILED', templates: listed });
  }
  if (NOT_SENDABLE.includes(english.status)) {
    return reply(400, english.status === 'rejected'
      ? `Meta rejected the English carousel template${english.rejectionReason ? ` (${english.rejectionReason})` : ''}.`
      : `The English carousel template is ${english.status} on WhatsApp.`, undefined, { code: 'TEMPLATE_BLOCKED', templates: listed });
  }
  if (english.status !== 'approved' || body.prepareOnly === true) {
    const pending = listed.filter((d) => d.status !== 'approved');
    if (pending.length === 0) return reply(200, 'The templates are approved - ready to send.', { templatesPending: [], templates: listed });
    return reply(202, PENDING_MESSAGE, { templatesPending: pending, templates: listed });
  }

  // Which template each recipient gets: their language when that template is approved, else English.
  const approved = new Set(templates.filter((d) => d.status === 'approved').map((d) => d.language));
  const templateLang = (customer) => {
    const lang = tpl.templateLanguageFor(customer.preferred_language);
    return approved.has(lang) ? lang : tpl.FALLBACK_LANGUAGE;
  };
  const usedLangs = [...new Set(customers.map(templateLang))];
  const languageFallbacks = Object.keys(wanted).filter((lang) => !approved.has(lang))
    .map((language) => ({ language, recipients: wanted[language], status: templates.find((d) => d.language === language).status }));

  // The pictures go to Meta once for the whole broadcast; every recipient's send refers to the returned ids.
  let mediaIds;
  try {
    mediaIds = [];
    for (const card of cards) mediaIds.push(await uploadImageFromUrl(business.phoneNumberId, business.accessToken, card.coverUrl));
  } catch (error) {
    return reply(502, `Could not upload the collection covers to WhatsApp: ${metaErrorText(error)}`, undefined, { code: 'COVER_UPLOAD_FAILED' });
  }

  const rate = config.WALLET_BILLING_ENABLED ? await rateOf(false) : 0;
  const estimatedCostPaise = rate * customers.length;
  const englishRow = english.templateId;
  const catalogConfig = {
    collectionIds: cards.map((c) => c.id), cardCount, buttons: buttonCount,
    templates: Object.fromEntries(usedLangs.map((lang) => {
      const d = templates.find((t) => t.language === lang);
      return [lang, { templateId: d.templateId, name: d.name, language: d.metaLanguage }];
    }))
  };

  // The id goes into every button payload, so it is made here and not by the database.
  const broadcastId = crypto.randomUUID();
  const { error: insertErr } = await supabase.from('broadcasts').insert({
    id: broadcastId,
    business_id: businessId,
    template_id: englishRow,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : defaultName(cards),
    kind: 'catalog',
    catalog_config: catalogConfig,
    status: 'sending',
    started_at: new Date().toISOString(),
    total_recipients: customers.length,
    ...(audience.filter !== 'all_customers' ? { audience_filter: audience.filter, audience_params: audience.params } : {})
  });
  if (insertErr) throw insertErr;

  const billed = config.WALLET_BILLING_ENABLED && estimatedCostPaise > 0;
  let debited = false;
  const refund = async (amountPaise, notes) => {
    if (!debited || amountPaise <= 0) return;
    try {
      await walletService.refundToWallet(businessId, amountPaise, broadcastId, notes);
    } catch (refundErr) {
      logger.error(`Broadcast ${broadcastId}: failed to refund ${amountPaise} paise`, refundErr);
    }
  };
  // Unlike a template broadcast there is no draft to go back to: a send that never reached the queue is 'failed'.
  const markFailed = async () => {
    await removeRecipientRows(broadcastId);
    const { error } = await supabase.from('broadcasts').update({ status: 'failed', completed_at: new Date().toISOString() })
      .eq('id', broadcastId).eq('business_id', businessId).eq('status', 'sending');
    if (error) logger.error(`Broadcast ${broadcastId}: failed to mark it failed`, error);
  };

  if (billed) {
    try {
      await walletService.debitWallet(businessId, estimatedCostPaise, broadcastId,
        `Broadcast ${broadcastId}: ${customers.length} × marketing message(s) @ ₹${(rate / 100).toFixed(2)}`);
      debited = true;
    } catch (debitErr) {
      await markFailed();
      if (debitErr.message && debitErr.message.includes('Insufficient wallet balance')) {
        const wallet = await walletService.getOrCreateWallet(businessId);
        return reply(400, `Insufficient wallet balance: need ₹${(estimatedCostPaise / 100).toFixed(2)}, have ₹${(wallet.balance_paise / 100).toFixed(2)}`, undefined, { code: 'INSUFFICIENT_WALLET' });
      }
      throw debitErr;
    }
  }

  const jobCatalog = {
    templates: Object.fromEntries(usedLangs.map((lang) => [lang, { name: catalogConfig.templates[lang].name, language: catalogConfig.templates[lang].language }])),
    cards: cards.map((card, i) => ({
      mediaId: mediaIds[i],
      texts: Object.fromEntries(usedLangs.map((lang) => [lang, tpl.cardText(getLocalizedText(card, 'title', lang) || card.title, getLocalizedText(card, 'priceLabel', lang) || card.priceLabel)])),
      payloads: [pageId(card.id, 0, broadcastId), ...(buttonCount === 2 ? [collectionOrderId(card.id, broadcastId)] : [])]
    }))
  };
  const batches = chunk(customers, BATCH_SIZE).map((batch) => ({
    recipients: batch,
    job: {
      broadcastId,
      businessId: businessId.toString(),
      phoneNumberId: business.phoneNumberId,
      encryptedAccessToken: business.accessToken,
      catalog: jobCatalog,
      ratePerMessage: rate,
      billed,
      recipients: batch.map((c) => ({ customerId: c.id, whatsappNumber: c.whatsapp_number, customer: { name: c.name }, templateLang: templateLang(c) }))
    }
  }));

  await createRecipientRows(broadcastId, businessId, customers);
  // Required here, not at the top: loading the queue opens a Redis connection, which the template script must not.
  const { addToBroadcastQueue } = require('../queues/broadcast.queue');
  const results = await Promise.allSettled(batches.map((b) => addToBroadcastQueue(b.job)));
  const failedBatches = batches.filter((_, i) => results[i].status === 'rejected');
  if (failedBatches.length === batches.length) {
    logger.error(`Broadcast ${broadcastId}: could not be queued`, results[0].reason);
    await refund(estimatedCostPaise, `Refund: broadcast ${broadcastId} could not be queued`);
    await markFailed();
    return reply(500, 'Could not start this broadcast. Nothing was sent or charged. Try again.', undefined, { code: 'QUEUE_FAILED' });
  }
  let totalRecipients = customers.length;
  if (failedBatches.length > 0) {
    // Some batches are already with the worker: count only what was queued and refund the rest.
    const lost = failedBatches.reduce((n, b) => n + b.recipients.length, 0);
    logger.error(`Broadcast ${broadcastId}: ${failedBatches.length} of ${batches.length} batches could not be queued (${lost} recipients)`);
    await refund(rate * lost, `Refund: ${lost} broadcast ${broadcastId} message(s) could not be queued`);
    await removeRecipientRows(broadcastId, failedBatches.flatMap((b) => b.recipients.map((c) => c.whatsapp_number)));
    totalRecipients = customers.length - lost;
    const { error: totalErr } = await supabase.from('broadcasts').update({ total_recipients: totalRecipients }).eq('id', broadcastId).eq('business_id', businessId);
    if (totalErr) logger.error(`Broadcast ${broadcastId}: failed to lower total_recipients by ${lost}`, totalErr);
  }

  logger.info(`Catalogue broadcast ${broadcastId} queued: ${customers.length} recipients, ${cardCount} cards, ${batches.length} batches`);
  return reply(201, 'Broadcast is sending', {
    broadcastId,
    status: 'sending',
    totalRecipients,
    cardCount,
    skippedCollections: selection.skipped,
    languageFallbacks,
    templates: listed,
    cost: costOf(rate, customers.length)
  });
};

module.exports = { previewCatalogBroadcast, sendCatalogBroadcast, ensureTemplates, loadTemplates, selectCards, catalogueSettings, selectionErrors, wantedLanguages };
