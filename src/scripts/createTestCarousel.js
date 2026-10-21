// src/scripts/createTestCarousel.js
//
// One-off: builds a small test carousel on ONE business so the native WhatsApp carousel (and its
// button taps) can be tried on a real number - nothing else is touched.
//
// Creates, through the SAME handlers the API uses (flowGraph.controller.js createReplyNode /
// createEdge, so every validation and plan limit applies):
//   - a reply node  --keyword (default "collection"), match exact, content_type "carousel",
//     text "Our new collection 👇 Swipe and tap a button", one card per image (the business's first 3
//     image rows in business_media, oldest first; at least 2 needed), card text "Collection 1/2/3"
//   - one target text reply node per card: keyword "carousel-test-N", text "You tapped collection N"
//   - one edge per card, carousel -> its target, label "View designs", card_index 0/1/2
// then flushes the business's flow cache.
//
// REFUSES Search cab AI (a live production business with real customers), looked up by name.
// Nothing is replaced: if any of the keywords already exists on the business it aborts.
//
// Dry-run by default (prints exactly what it would create, writes nothing). Pass --confirm to write.
// --cleanup removes what this script created (reply nodes matched by the keywords; their edges go with
// them); it is a dry run too until --confirm is added.
//
// Usage:
//   node src/scripts/createTestCarousel.js --business <id> [--keyword collection]              (dry run)
//   node src/scripts/createTestCarousel.js --business <id> [--keyword collection] --confirm    (creates)
//   node src/scripts/createTestCarousel.js --business <id> [--keyword collection] --cleanup            (dry run)
//   node src/scripts/createTestCarousel.js --business <id> [--keyword collection] --cleanup --confirm  (deletes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { invalidateRulesCache } = require('../services/chatbot.service');
const flowGraphController = require('../controllers/flowGraph.controller');

const CONFIRM = process.argv.includes('--confirm');
const CLEANUP = process.argv.includes('--cleanup');

const argValue = (name) => {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};

const MESSAGE = 'Our new collection 👇 Swipe and tap a button';
const BUTTON_LABEL = 'View designs';
const MAX_CARDS = 3;

// Runs an API handler the way the router would and returns { status, body }; a thrown / next(err) error is thrown here.
const callHandler = async (handler, { businessId, graphBusiness, body }) => {
  const out = {};
  let failure = null;
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ body, params: {}, query: {}, graphBusiness, user: { businessId, userId: null } }, res, (err) => { failure = err; });
  if (failure) throw failure;
  return out;
};
const must = (out, what) => {
  if (out.status >= 400) throw new Error(`${what} failed (${out.status}): ${out.body && out.body.message}`);
  return out.body.data;
};

async function main() {
  const businessId = argValue('business');
  const keyword = (argValue('keyword') || 'collection').toLowerCase().trim();
  if (!businessId) throw new Error('--business <id> is required');
  const targetKeywords = [1, 2, 3].map(n => `carousel-test-${n}`);
  if (targetKeywords.includes(keyword)) throw new Error(`--keyword must not be one of ${targetKeywords.join(', ')}`);

  // ---- the business, and the Search cab AI guard -------------------------------------------
  const { data: business, error: bizErr } = await supabase
    .from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (bizErr) throw bizErr;
  if (!business) throw new Error(`No business with id ${businessId}`);

  const { data: protectedRows, error: protectedErr } = await supabase
    .from('businesses').select('id, name').ilike('name', '%search cab%');
  if (protectedErr) throw protectedErr;
  if ((protectedRows || []).some(b => b.id === business.id) || /search\s*cab/i.test(business.name || '')) {
    throw new Error(`REFUSING: "${business.name}" (${business.id}) is Search cab AI, a LIVE production business with real customers. Use a test account.`);
  }
  console.log(`Business: ${business.name} (${business.id}), category ${business.business_category}`);
  console.log(CONFIRM ? 'MODE: --confirm (writes)\n' : 'MODE: dry run (writes nothing; add --confirm to execute)\n');

  const allKeywords = [keyword, ...targetKeywords];
  const { data: existing, error: existingErr } = await supabase
    .from('flow_nodes').select('id, keyword, content_type, label').eq('business_id', businessId).eq('node_type', 'reply').in('keyword', allKeywords);
  if (existingErr) throw existingErr;

  // ---- cleanup -------------------------------------------------------------------------------
  if (CLEANUP) {
    if (existing.length === 0) {
      console.log('Nothing to clean up: none of these reply keywords exist:', allKeywords.join(', '));
      return;
    }
    console.log('Would delete these reply nodes (their edges go with them):');
    existing.forEach(n => console.log(`  - "${n.keyword}" (${n.content_type}) id ${n.id}`));
    if (!CONFIRM) return;
    const ids = existing.map(n => n.id);
    const { error: edgeErr } = await supabase.from('flow_edges').delete().eq('business_id', businessId).in('from_node_id', ids);
    if (edgeErr) throw edgeErr;
    const { error: edgeToErr } = await supabase.from('flow_edges').delete().eq('business_id', businessId).in('to_node_id', ids);
    if (edgeToErr) throw edgeToErr;
    const { error: nodeErr } = await supabase.from('flow_nodes').delete().eq('business_id', businessId).in('id', ids);
    if (nodeErr) throw nodeErr;
    await invalidateRulesCache(businessId);
    console.log(`\nDeleted ${ids.length} reply node(s) and flushed the flow cache.`);
    return;
  }

  // ---- create ----------------------------------------------------------------------------------
  if (existing.length > 0) {
    console.log('ABORT: these reply keywords already exist on this business (run --cleanup first):');
    existing.forEach(n => console.log(`  - "${n.keyword}" (${n.content_type}) id ${n.id}`));
    process.exitCode = 1;
    return;
  }

  const { data: images, error: mediaErr } = await supabase
    .from('business_media').select('id, url, original_filename').eq('business_id', businessId).eq('media_type', 'image')
    .order('created_at', { ascending: true }).limit(MAX_CARDS);
  if (mediaErr) throw mediaErr;
  if (!images || images.length < 2) {
    console.log(`ABORT: the business has ${images ? images.length : 0} image(s) in business_media; a carousel needs at least 2.`);
    process.exitCode = 1;
    return;
  }

  const cards = images.map((m, i) => ({ mediaId: m.id, mediaType: 'image', body: `Collection ${i + 1}` }));
  console.log(`Would create ${1 + cards.length} reply nodes and ${cards.length} edges:\n`);
  console.log(`  1. carousel reply  keyword "${keyword}" (exact), text: ${MESSAGE}`);
  images.forEach((m, i) => console.log(`       card ${i + 1}: "Collection ${i + 1}"  <- ${m.original_filename || m.id}  (${m.url})`));
  images.forEach((m, i) => {
    console.log(`  ${i + 2}. target reply    keyword "carousel-test-${i + 1}", text: You tapped collection ${i + 1}`);
    console.log(`       edge: carousel -> carousel-test-${i + 1}, label "${BUTTON_LABEL}", card_index ${i}`);
  });
  if (!CONFIRM) {
    console.log('\nDry run - nothing written. Re-run with --confirm.');
    return;
  }

  const graphBusiness = { businessCategory: business.business_category };

  // Same handlers as POST /api/flow-graph/reply-nodes and /edges (validation, plan limits, cache flush).
  const targets = [];
  for (let i = 0; i < images.length; i++) {
    const node = must(await callHandler(flowGraphController.createReplyNode, {
      businessId, graphBusiness,
      body: { keyword: `carousel-test-${i + 1}`, matchType: 'exact', replyKind: 'text', contentType: 'text', label: `You tapped collection ${i + 1}` }
    }), `Creating target reply carousel-test-${i + 1}`);
    targets.push(node);
    console.log(`created target "carousel-test-${i + 1}" ${node.id}`);
  }

  const carousel = must(await callHandler(flowGraphController.createReplyNode, {
    businessId, graphBusiness,
    body: { keyword, matchType: 'exact', replyKind: 'text', contentType: 'carousel', label: MESSAGE, carouselCards: cards }
  }), `Creating carousel reply "${keyword}"`);
  console.log(`created carousel "${keyword}" ${carousel.id}`);

  for (let i = 0; i < targets.length; i++) {
    const edge = must(await callHandler(flowGraphController.createEdge, {
      businessId, graphBusiness,
      body: { fromNodeId: carousel.id, toNodeId: targets[i].id, label: BUTTON_LABEL, cardIndex: i }
    }), `Creating the edge for card ${i + 1}`);
    console.log(`created edge card ${i + 1} -> carousel-test-${i + 1} ${edge.id}`);
  }

  await invalidateRulesCache(businessId);
  console.log(`\nDone. Send "${keyword}" from a WhatsApp number to this business to see the carousel.`);
  console.log(`Remove it with: node src/scripts/createTestCarousel.js --business ${businessId} --keyword ${keyword} --cleanup --confirm`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('FAILED:', err && err.message ? err.message : err);
    process.exit(1);
  });
