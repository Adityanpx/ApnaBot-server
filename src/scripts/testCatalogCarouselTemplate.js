// src/scripts/testCatalogCarouselTemplate.js
//
// Checks the "Send catalogue" broadcast's carousel template for one business, once, before an owner uses it: which
// templates it would need, the exact JSON that creates each one on Meta, and the exact components one send carries.
// It uses the same code as POST /api/catalog/broadcast (services/catalogBroadcast.service.js).
//
// Default is a DRY RUN: reads the business, its collections and its template rows; prints everything; writes nothing,
// calls Meta for nothing. --confirm creates the missing (or rejected) template rows and SUBMITS them to Meta (a
// resumable-upload sample per card, then POST /{waba}/message_templates). It never sends a message to anyone and
// never uploads send-time media.
//
// Refuses Search cab AI (a live business with real customers), looked up by name - it is never a test account.
//
// Usage:
//   node src/scripts/testCatalogCarouselTemplate.js --business <businessId | exact name>
//   node src/scripts/testCatalogCarouselTemplate.js --business "<name>" --collections <id>,<id>,<id> --lang en,hi
//   node src/scripts/testCatalogCarouselTemplate.js --business <businessId> --confirm
//
// --collections  collection ids in card order (default: every active collection with a cover, up to the plan's limit)
// --lang         template languages, comma separated, from en, hi, mr (default en)
// --confirm      actually submit the templates
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_ID (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const { listCollections } = require('../services/catalogCollection.service');
const catalogBroadcast = require('../services/catalogBroadcast.service');
const tpl = require('../utils/catalogCarouselTemplate');
const { pageId, collectionOrderId } = require('../utils/catalogIds');
const { isUuid } = require('../utils/catalogValidation');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const json = (value) => JSON.stringify(value, null, 2);

const SEARCH_CAB = /search\s*cab/i;

/** The business named by --business (an id or an exact name, case-insensitive), or exits. */
const findBusiness = async (ref) => {
  let query = supabase.from('businesses').select('id, name');
  query = isUuid(ref) ? query.eq('id', ref) : query.ilike('name', ref);
  const { data, error } = await query.limit(2);
  if (error) throw error;
  if (!data || data.length === 0) fail(`No business matches "${ref}".`);
  if (data.length > 1) fail(`More than one business is called "${ref}" - pass its id.`);
  return data[0];
};

/** Search cab AI's id(s), looked up fresh by name; the target is refused if it is one of them or is named like it. */
const refuseSearchCab = async (target) => {
  const { data, error } = await supabase.from('businesses').select('id, name').ilike('name', '%search%cab%');
  if (error) throw error;
  if (SEARCH_CAB.test(target.name) || (data || []).some((b) => b.id === target.id)) {
    fail(`Refusing: "${target.name}" is Search cab AI, a live business with real customers. This script is for test businesses only.`);
  }
};

async function main() {
  const ref = argValue('--business');
  const confirm = process.argv.includes('--confirm');
  if (!ref) fail('Usage: node src/scripts/testCatalogCarouselTemplate.js --business <businessId | name> [--collections id,id] [--lang en,hi] [--confirm]');

  const found = await findBusiness(ref);
  await refuseSearchCab(found);
  const business = await businessService.getBusinessById(found.id);
  console.log(`Business: ${business.name} (${business.id}) category=${business.businessCategory} wabaId=${business.wabaId || '-'}`);
  console.log(confirm ? 'Mode: --confirm (templates WILL be submitted to Meta)' : 'Mode: dry run (nothing is written or sent)');

  const langs = (argValue('--lang') || 'en').split(',').map((l) => l.trim()).filter(Boolean);
  const bad = langs.filter((l) => !tpl.TEMPLATE_LANGUAGES.includes(l));
  if (bad.length > 0) fail(`Unsupported --lang ${bad.join(', ')} (use ${tpl.TEMPLATE_LANGUAGES.join(', ')}).`);

  let ids = (argValue('--collections') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) ids = (await listCollections(business.id)).filter((c) => c.isActive && c.coverUrl).map((c) => c.id);
  if (ids.length === 0) fail('This business has no active collection with a cover.');

  const selection = await catalogBroadcast.selectCards(business.id, ids);
  if (selection.error) fail(selection.error.message);
  const settings = await catalogBroadcast.catalogueSettings(business.id);
  const problems = catalogBroadcast.selectionErrors(selection, settings);
  const cardCount = selection.cards.length;
  const buttonCount = settings.orderAction ? 2 : 1;

  console.log(`\nCards (${cardCount}), ${buttonCount} button(s) each, plan limit ${selection.planMaxCards}:`);
  selection.cards.forEach((c, i) => console.log(`  ${i + 1}. ${c.title}  |  ${c.priceLabel || '-'}  |  ${c.coverUrl}`));
  if (selection.skipped.length > 0) {
    console.log('Left out:');
    selection.skipped.forEach((s) => console.log(`  - ${s.message}`));
  }
  if (problems.length > 0) {
    console.log('PROBLEMS (a real send would be refused):');
    problems.forEach((p) => console.log(`  - [${p.code}] ${p.message}`));
  }
  if (cardCount < tpl.MIN_CARDS || cardCount > tpl.MAX_CARDS) fail('A carousel needs 2 to 10 cards.');

  const descriptors = await catalogBroadcast.loadTemplates(business.id, cardCount, buttonCount, langs);
  for (const d of descriptors) {
    console.log(`\n=== ${d.name} (${d.metaLanguage}) - status: ${d.status}${d.rejectionReason ? ` (${d.rejectionReason})` : ''} ===`);
    const specErrors = tpl.validateSpec({ cardCount, lang: d.language, buttonCount });
    if (specErrors.length > 0) console.log(`Template spec problems: ${specErrors.join(' ')}`);
    console.log('Template creation JSON (POST /{waba}/message_templates; handles come from the resumable upload of each cover):');
    console.log(json(tpl.buildCreatePayload({
      cardCount, lang: d.language, buttonCount, headerHandles: selection.cards.map((_, i) => `<header_handle_${i + 1}>`)
    })));
    console.log('Send components for one recipient (media ids come from POST /{phone}/media at send time):');
    console.log(json(tpl.buildSendComponents({
      lang: d.language,
      customerName: 'Priya',
      cards: selection.cards.map((c, i) => ({
        mediaId: `<MEDIA_ID_${i + 1}>`,
        text: tpl.cardText(c.title, c.priceLabel),
        payloads: [pageId(c.id, 0, '<broadcastId>'), ...(buttonCount === 2 ? [collectionOrderId(c.id, '<broadcastId>')] : [])]
      }))
    })));
  }

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to submit the missing / rejected templates to Meta.');
    return;
  }
  if (problems.length > 0) fail('Not submitting: fix the problems above first.');
  if (!business.wabaId || !business.accessToken) fail('This business is not connected to WhatsApp (no wabaId / access token).');

  const results = await catalogBroadcast.ensureTemplates(business, { cardCount, buttonCount, sampleUrls: selection.cards.map((c) => c.coverUrl) }, descriptors);
  console.log('\nResult:');
  for (const r of results) {
    console.log(`  ${r.name}: ${r.submitError ? `FAILED - ${r.submitError}` : r.submitted ? 'submitted, now pending Meta approval' : `left as is (${r.status})`}`);
  }
  console.log('Nothing was sent to any customer. Run a template sync (or wait for the status webhook) to see approval.');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.response?.data || error);
  process.exit(1);
});
