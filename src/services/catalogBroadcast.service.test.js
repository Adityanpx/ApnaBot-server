// Run: node --test src/services/catalogBroadcast.service.test.js
// "Send catalogue": preview (cards, skipped collections, WebP covers, template status per language, audience, cost)
// and send (templates created + submitted -> 202 until approved, then the queued jobs, language fallback, plan cap,
// wallet). In-memory Supabase (storage harness); Meta, the queue and the wallet are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
h.cfg.WALLET_BILLING_ENABLED = false;
h.cfg.MAX_BROADCAST_RECIPIENTS = 1000;
require('../test-support/stubRedis');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

let plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 };
stub('../services/subscription.service', { getActiveSubscription: async () => ({ status: 'active', plan }) });
stub('../services/unicodeMatching.service', { isUnicodeMatchingEnabled: async () => false });

const { encrypt } = require('../utils/crypto');
const B = h.B1;
let business;
stub('../services/business.service', { getBusinessById: async () => business });

const posted = [];
let postFails = null;
let templateStatusOnPost = 'PENDING';
stub('axios', {
  post: async (url, payload) => {
    if (postFails) throw Object.assign(new Error('Meta said no'), { response: { data: { error: { error_user_msg: postFails } } } });
    posted.push({ url, payload });
    return { data: { id: `meta-${posted.length}`, status: templateStatusOnPost } };
  },
  get: async () => ({ data: Buffer.from('x'), headers: {} })
});
const uploadedHandles = [];
stub('../services/templateSubmit.service', {
  uploadHeaderHandle: async ({ url }) => { uploadedHandles.push(url); return `handle-${uploadedHandles.length}`; }
});
const uploadedMedia = [];
let mediaFails = false;
stub('../services/whatsapp.service', {
  META_API_BASE: 'https://graph.test',
  uploadImageFromUrl: async (phoneNumberId, token, url) => {
    if (mediaFails) throw new Error('upload rejected');
    uploadedMedia.push(url);
    return `MEDIA-${uploadedMedia.length}`;
  }
});
const queued = [];
let queueFails = false;
stub('../queues/broadcast.queue', { addToBroadcastQueue: async (job) => { if (queueFails) throw new Error('redis down'); queued.push(job); } });
const debits = [];
const refunds = [];
stub('../services/wallet.service', {
  debitWallet: async (...a) => { debits.push(a); },
  refundToWallet: async (...a) => { refunds.push(a); },
  getOrCreateWallet: async () => ({ balance_paise: 0 })
});
let rate = 0;
stub('../services/rateCard.service', { getRateForMessage: async () => rate });

const service = require('./catalogBroadcast.service');
const { parseCatalogTapId } = require('../utils/catalogIds');

const { uuid, url } = h;
const C = [1, 2, 3, 4, 5].map((n) => uuid(100 + n));
const MEDIA = [1, 2, 3, 4, 5].map((n) => uuid(200 + n));
let db;

const customer = (n, extra = {}) => ({
  id: uuid(300 + n), business_id: B, whatsapp_number: `9198000000${String(n).padStart(2, '0')}`, name: `Cust ${n}`,
  opted_in: true, is_blocked: false, opted_out_at: null, marketing_blocked_at: null, preferred_language: null, ...extra
});
const template = (cardCount, lang, buttons, status, extra = {}) => ({
  id: uuid(500 + db.message_templates.length), business_id: B, kind: 'catalog_carousel', name: `apnabot_catalog_v2_${cardCount}_${lang}_${buttons}`,
  language: { en: 'en_US', hi: 'hi', mr: 'mr' }[lang], status, meta_template_id: status === 'draft' ? null : `m-${lang}`, created_at: new Date().toISOString(), ...extra
});

test.beforeEach(() => {
  db = h.reset();
  plan = { name: 'pro', display_name: 'Pro', carousel_max_cards: 10 };
  rate = 0; h.cfg.WALLET_BILLING_ENABLED = false;
  posted.length = 0; uploadedHandles.length = 0; uploadedMedia.length = 0; queued.length = 0; debits.length = 0; refunds.length = 0;
  postFails = null; mediaFails = false; queueFails = false; templateStatusOnPost = 'PENDING';
  business = { id: B, name: 'Shambhu', isWhatsappConnected: true, phoneNumberId: 'pn1', wabaId: 'waba1', accessToken: encrypt('tok') };
  db.businesses = [{ id: B, name: 'Shambhu' }];
  db.catalogs = [{ id: uuid(1), business_id: B, settings: { enabled: true, orderAction: { type: 'message' } } }];
  db.business_media = MEDIA.map((id, i) => ({ id, business_id: B, url: url(`cover${i + 1}.jpg`), media_type: 'image', file_size_bytes: 10 }));
  db.catalog_collections = C.map((id, i) => ({
    id, business_id: B, title: `Collection ${i + 1}`, body: null, price_label: `From Rs ${100 * (i + 1)}`, cover_media_id: MEDIA[i],
    is_active: true, sort_order: i, created_at: new Date(2026, 0, i + 1).toISOString(),
    title_translations: { hi: `HI ${i + 1}` }, price_label_translations: null
  }));
  db.catalog_items = [];
  db.customers = [customer(1), customer(2), customer(3, { preferred_language: 'hi' }), customer(4, { preferred_language: 'mr' }), customer(5, { preferred_language: 'gu' })];
  db.message_templates = []; db.broadcasts = []; db.broadcast_recipients = [];
  h.state.fake.rpc = async (name) => {
    if (name === 'broadcast_audience_summary') return { data: { selected: db.customers.length, willReceive: db.customers.length, skipped: {} }, error: null };
    return { data: null, error: { message: `no rpc ${name}` } };
  };
});

const approve = (cardCount, langs, buttons = 2) => langs.forEach((lang) => db.message_templates.push(template(cardCount, lang, buttons, 'approved')));
const send = (body) => service.sendCatalogBroadcast(B, body);
const preview = (body) => service.previewCatalogBroadcast(B, body);

// ---- preview ------------------------------------------------------------------------------------------------

test('preview: the cards, the audience, the cost and the template status per language', async () => {
  rate = 80;
  approve(3, ['en']);
  const out = await preview({ collectionIds: C.slice(0, 3) });
  assert.equal(out.status, 200);
  const d = out.data;
  assert.deepEqual(d.cards.map((c) => [c.collectionId, c.title, c.priceLabel]), C.slice(0, 3).map((id, i) => [id, `Collection ${i + 1}`, `From Rs ${100 * (i + 1)}`]));
  assert.deepEqual([d.cardCount, d.buttonCount, d.orderButton, d.planMaxCards], [3, 2, true, 10]);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.skipped, []);
  assert.deepEqual(d.languages.map((l) => [l.language, l.name, l.status, l.recipients]), [
    ['en', 'apnabot_catalog_v2_3_en_2', 'approved', 3], ['hi', 'apnabot_catalog_v2_3_hi_2', 'missing', 1], ['mr', 'apnabot_catalog_v2_3_mr_2', 'missing', 1]
  ]);
  assert.deepEqual([d.templatesReady, d.canPrepare, d.canSend], [true, true, true]);
  assert.deepEqual([d.audience.selected, d.audience.willReceive, d.audience.overCap, d.audience.cap], [5, 5, false, 1000]);
  assert.deepEqual(Object.keys(d.audience.skipped).sort(), ['blocked', 'marketing_stopped', 'no_number', 'not_opted_in', 'opted_out']);
  assert.deepEqual(d.cost, { category: 'marketing', ratePerMessagePaise: 80, estimatedPaise: 400, walletBilling: false });
  assert.equal(db.message_templates.length, 1, 'a preview creates nothing');
  assert.equal(db.broadcasts.length, 0);
});

test('preview: not ready until the English template is approved; nothing is created', async () => {
  const out = await preview({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.data.templatesReady, out.data.canPrepare, out.data.canSend], [false, true, false]);
  assert.equal(out.data.languages[0].status, 'missing');
  assert.equal(db.message_templates.length, 0);
  assert.equal(posted.length, 0);
});

test('preview: a rejected template shows its reason', async () => {
  db.message_templates.push(template(2, 'en', 2, 'rejected', { rejection_reason: 'INVALID_FORMAT' }));
  const out = await preview({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.data.languages[0].status, out.data.languages[0].rejectionReason], ['rejected', 'INVALID_FORMAT']);
});

test('preview: a WebP cover blocks the send with a message that says which collection and what to do', async () => {
  db.business_media[1].url = url('cover2.webp');
  const out = await preview({ collectionIds: C.slice(0, 3) });
  assert.deepEqual(out.data.errors, [{
    code: 'WEBP_COVER', collectionId: C[1], message: "Cover of 'Collection 2' is WebP — choose another cover or re-upload in Catalogue."
  }]);
  assert.deepEqual([out.data.canPrepare, out.data.canSend], [false, false]);
  assert.equal(out.data.cardCount, 3, 'the card is kept - it is fixable, not skipped');
  assert.deepEqual(out.data.skipped, []);
});

test('preview: lists which collections are left out and why - off, no cover, over the plan cap, unknown', async () => {
  plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 2 };
  db.catalog_collections[0].is_active = false;
  db.catalog_collections[1].cover_media_id = null;
  const ghost = uuid(999);
  const out = await preview({ collectionIds: [C[0], C[1], C[2], C[3], C[4], ghost] });
  assert.deepEqual(out.data.cards.map((c) => c.collectionId), [C[2], C[3]]);
  assert.deepEqual(out.data.skipped.map((s) => [s.collectionId, s.reason]), [[C[0], 'inactive'], [C[1], 'no_cover'], [C[4], 'over_plan_cap'], [ghost, 'not_found']]);
  assert.match(out.data.skipped[0].message, /'Collection 1' is switched off/);
  assert.match(out.data.skipped[1].message, /'Collection 2' has no cover photo/);
  assert.match(out.data.skipped[2].message, /plan shows up to 2 collections.*'Collection 5'/);
  assert.equal(out.data.planMaxCards, 2);
  assert.deepEqual(out.data.errors, []);
});

test('preview: fewer than 2 usable collections, a switched-off catalogue and an empty audience are errors', async () => {
  db.catalogs[0].settings.enabled = false;
  db.customers = [];
  const out = await preview({ collectionIds: [C[0]] });
  assert.deepEqual(out.data.errors.map((e) => e.code), ['CATALOGUE_DISABLED', 'TOO_FEW_CARDS', 'NO_RECIPIENTS']);
  assert.deepEqual(out.data.languages, []);
  assert.equal(out.data.canSend, false);
});

test('preview: a catalogue with no order action needs the one-button template', async () => {
  db.catalogs[0].settings = { enabled: true, orderAction: null };
  const out = await preview({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.data.orderButton, out.data.buttonCount, out.data.languages[0].name], [false, 1, 'apnabot_catalog_v2_2_en_1']);
});

test('preview: bad requests are 400 / 404', async () => {
  assert.equal((await preview({})).status, 400);
  assert.equal((await preview({ collectionIds: [] })).status, 400);
  assert.equal((await preview({ collectionIds: ['nope'] })).status, 400);
  assert.equal((await preview({ collectionIds: C.slice(0, 2), audienceFilter: 'everyone' })).status, 400);
  assert.equal((await preview({ collectionIds: C.slice(0, 2), audienceFilter: 'customers', audienceParams: { customerIds: [uuid(777)] } })).status, 404);
});

// ---- send: templates ----------------------------------------------------------------------------------------

test('send with no template yet: creates + submits one per language the audience needs, answers 202, queues nothing', async () => {
  const out = await send({ collectionIds: C.slice(0, 3) });
  assert.equal(out.status, 202);
  assert.match(out.message, /Waiting for Meta approval — usually minutes, up to 24h/);
  assert.deepEqual(out.data.templatesPending.map((t) => [t.language, t.name, t.status]), [
    ['en', 'apnabot_catalog_v2_3_en_2', 'pending'], ['hi', 'apnabot_catalog_v2_3_hi_2', 'pending'], ['mr', 'apnabot_catalog_v2_3_mr_2', 'pending']
  ]);
  assert.equal(db.broadcasts.length, 0);
  assert.equal(queued.length, 0);
  assert.equal(uploadedMedia.length, 0, 'no picture goes to Meta before the templates are approved');

  assert.equal(db.message_templates.length, 3);
  for (const row of db.message_templates) {
    assert.deepEqual([row.kind, row.category, row.status, row.send_support, row.header_type, row.variable_count], ['catalog_carousel', 'MARKETING', 'pending', 'unsupported_component', 'NONE', 1]);
    assert.ok(row.meta_template_id);
    assert.equal(row.meta_components[1].cards.length, 3);
  }
  assert.equal(posted.length, 3);
  assert.equal(posted[0].url, 'https://graph.test/waba1/message_templates');
  assert.equal(posted[0].payload.name, 'apnabot_catalog_v2_3_en_2');
  assert.deepEqual(posted[0].payload.components[1].cards.map((c) => c.components[0].example.header_handle[0]), ['handle-1', 'handle-2', 'handle-3']);
  assert.deepEqual(uploadedHandles.slice(0, 3), [url('cover1.jpg'), url('cover2.jpg'), url('cover3.jpg')], 'the samples are this send\'s covers, in card order');
});

test('send again while the templates are pending: nothing is submitted twice', async () => {
  await send({ collectionIds: C.slice(0, 3) });
  posted.length = 0;
  const again = await send({ collectionIds: C.slice(0, 3) });
  assert.equal(again.status, 202);
  assert.equal(posted.length, 0);
  assert.equal(db.message_templates.length, 3);
});

test('send: a rejected template is submitted again; a draft left by a failed submit is reused', async () => {
  db.message_templates.push(template(2, 'en', 2, 'rejected', { rejection_reason: 'X' }));
  db.customers = [customer(1)];
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(out.status, 202);
  assert.equal(db.message_templates.length, 1);
  assert.equal(db.message_templates[0].status, 'pending');
  assert.equal(posted.length, 1);

  db.message_templates = [];
  postFails = 'Template name already exists';
  const failed = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([failed.status, failed.errors.code], [400, 'TEMPLATE_SUBMIT_FAILED']);
  assert.match(failed.message, /Template name already exists/);
  assert.equal(db.message_templates[0].status, 'draft');
  postFails = null;
  const retried = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(retried.status, 202);
  assert.equal(db.message_templates.length, 1, 'the draft was reused, not duplicated');
  assert.equal(db.message_templates[0].status, 'pending');
});

test('send: Meta refusing the wording marks the row rejected with Meta\'s own message, and the next send resubmits it', async () => {
  const reason = 'Params Words Ratio Exceeds Limit - too many variables for its length';
  const realPost = require('axios').post;
  require('axios').post = async () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { error: { code: 100, error_subcode: 2388293, error_user_msg: reason } } } }); };
  try {
    const failed = await send({ collectionIds: C.slice(0, 2), prepareOnly: true });
    assert.deepEqual([failed.status, failed.errors.code], [400, 'TEMPLATE_SUBMIT_FAILED']);
    assert.match(failed.message, /Params Words Ratio/);
  } finally {
    require('axios').post = realPost;
  }
  assert.ok(db.message_templates.length > 0);
  for (const row of db.message_templates) assert.deepEqual([row.status, row.rejection_reason], ['rejected', reason]);

  const retried = await send({ collectionIds: C.slice(0, 2), prepareOnly: true });
  assert.equal(retried.status, 202);
  assert.ok(db.message_templates.every((row) => row.status === 'pending' && row.rejection_reason === null), 'a rejected row is submitted again');
});

test('send: a failure that is not Meta refusing the content (no 400 / code 100) leaves the draft as it is', async () => {
  postFails = 'Network down';
  await send({ collectionIds: C.slice(0, 2), prepareOnly: true });
  assert.ok(db.message_templates.length > 0);
  assert.ok(db.message_templates.every((row) => row.status === 'draft'));
});

test('send: a paused or disabled English template is a 400 TEMPLATE_BLOCKED', async () => {
  db.message_templates.push(template(2, 'en', 2, 'paused'));
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'TEMPLATE_BLOCKED']);
  assert.equal(posted.length, 0);
});

test('send with prepareOnly submits the templates and sends nothing, even when English is approved', async () => {
  approve(2, ['en']);
  const out = await send({ collectionIds: C.slice(0, 2), prepareOnly: true });
  assert.equal(out.status, 202);
  assert.deepEqual(out.data.templatesPending.map((t) => t.language), ['hi', 'mr']);
  assert.equal(db.broadcasts.length, 0);
  assert.equal(queued.length, 0);
});

// ---- send: the broadcast ------------------------------------------------------------------------------------

test('send with the templates approved: 201, a catalog broadcast row, jobs with per-language templates and the broadcast payload suffix', async () => {
  approve(3, ['en', 'hi']);   // mr is missing -> that customer gets English; gu has no wording -> English too
  const out = await send({ collectionIds: C.slice(0, 3), name: 'Diwali' });
  assert.equal(out.status, 201);
  assert.equal(out.message, 'Broadcast is sending');
  const broadcast = db.broadcasts[0];
  assert.deepEqual([out.data.broadcastId, out.data.status, out.data.totalRecipients, out.data.cardCount], [broadcast.id, 'sending', 5, 3]);
  assert.deepEqual(out.data.skippedCollections, []);
  assert.deepEqual(out.data.languageFallbacks, [{ language: 'mr', recipients: 1, status: 'pending' }]);
  assert.deepEqual(out.data.cost, { category: 'marketing', ratePerMessagePaise: 0, estimatedPaise: 0, walletBilling: false });

  assert.deepEqual([broadcast.kind, broadcast.status, broadcast.name, broadcast.total_recipients, broadcast.business_id],
    ['catalog', 'sending', 'Diwali', 5, B]);
  const english = db.message_templates.find((t) => t.name === 'apnabot_catalog_v2_3_en_2');
  assert.equal(broadcast.template_id, english.id, 'template_id is the English variant');
  assert.deepEqual(broadcast.catalog_config.collectionIds, C.slice(0, 3));
  assert.deepEqual([broadcast.catalog_config.cardCount, broadcast.catalog_config.buttons], [3, 2]);
  assert.deepEqual(Object.keys(broadcast.catalog_config.templates).sort(), ['en', 'hi']);
  assert.equal(broadcast.audience_filter, undefined, 'the default audience writes no audience columns');

  assert.deepEqual(uploadedMedia, [url('cover1.jpg'), url('cover2.jpg'), url('cover3.jpg')], 'each cover goes to Meta once for the whole broadcast');
  assert.equal(queued.length, 1);
  const job = queued[0];
  assert.deepEqual([job.broadcastId, job.phoneNumberId, job.billed], [broadcast.id, 'pn1', false]);
  assert.deepEqual(job.recipients.map((r) => [r.customer.name, r.templateLang]), [['Cust 1', 'en'], ['Cust 2', 'en'], ['Cust 3', 'hi'], ['Cust 4', 'en'], ['Cust 5', 'en']]);
  assert.deepEqual(job.catalog.templates, { en: { name: 'apnabot_catalog_v2_3_en_2', language: 'en_US' }, hi: { name: 'apnabot_catalog_v2_3_hi_2', language: 'hi' } });
  assert.deepEqual(job.catalog.cards.map((c) => c.mediaId), ['MEDIA-1', 'MEDIA-2', 'MEDIA-3']);
  assert.deepEqual(job.catalog.cards[0].texts, { en: 'Collection 1 · From Rs 100', hi: 'HI 1 · From Rs 100' });
  const [view, order] = job.catalog.cards[1].payloads;
  assert.deepEqual(parseCatalogTapId(view), { kind: 'page', collectionId: C[1], page: 0, broadcastId: broadcast.id });
  assert.deepEqual(parseCatalogTapId(order), { kind: 'collection_order', collectionId: C[1], broadcastId: broadcast.id });
  assert.equal(db.broadcast_recipients.length, 5, 'a delivery row per recipient');
});

test('send: a one-button catalogue sends one payload per card', async () => {
  db.catalogs[0].settings = { enabled: true, orderAction: null };
  approve(2, ['en'], 1);
  db.customers = [customer(1)];
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(out.status, 201);
  assert.deepEqual(queued[0].catalog.cards.map((c) => c.payloads.length), [1, 1]);
  assert.equal(queued[0].catalog.templates.en.name, 'apnabot_catalog_v2_2_en_1');
});

test('send: recipients are split into jobs of 50', async () => {
  approve(2, ['en']);
  db.customers = Array.from({ length: 120 }, (_, i) => customer(i + 1));
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(out.data.totalRecipients, 120);
  assert.deepEqual(queued.map((j) => j.recipients.length), [50, 50, 20]);
});

test('send: only the first cards up to the plan limit are used, and the rest are reported as skipped', async () => {
  plan = { name: 'basic', display_name: 'Basic', carousel_max_cards: 2 };
  approve(2, ['en']);
  db.customers = [customer(1)];
  const out = await send({ collectionIds: C.slice(0, 4) });
  assert.equal(out.status, 201);
  assert.equal(out.data.cardCount, 2);
  assert.deepEqual(out.data.skippedCollections.map((s) => [s.collectionId, s.reason]), [[C[2], 'over_plan_cap'], [C[3], 'over_plan_cap']]);
  assert.equal(queued[0].catalog.cards.length, 2);
});

test('send: the audience is the marketing rule - an opted-out, blocked or not-opted-in customer is not sent to', async () => {
  approve(2, ['en']);
  db.customers = [customer(1), customer(2, { opted_in: false }), customer(3, { opted_out_at: 'x' }), customer(4, { is_blocked: true }), customer(5, { marketing_blocked_at: 'x' })];
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(out.data.totalRecipients, 1);
  assert.deepEqual(queued[0].recipients.map((r) => r.customer.name), ['Cust 1']);
});

test('send: a customer-group audience is stored on the broadcast', async () => {
  approve(2, ['en']);
  db.customers = [customer(1)];
  const out = await send({ collectionIds: C.slice(0, 2), audienceFilter: 'customers', audienceParams: { customerIds: [db.customers[0].id] } });
  assert.equal(out.status, 201);
  assert.equal(db.broadcasts[0].audience_filter, 'customers');
});

test('send: 400s with a code - WebP cover, too few cards, catalogue off, no recipients, too many recipients, WhatsApp not connected', async () => {
  approve(2, ['en']);
  db.business_media[0].url = url('cover1.webp');
  let out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'WEBP_COVER']);
  assert.match(out.message, /Cover of 'Collection 1' is WebP — choose another cover or re-upload in Catalogue/);
  db.business_media[0].url = url('cover1.jpg');

  out = await send({ collectionIds: [C[0]] });
  assert.deepEqual([out.status, out.errors.code], [400, 'TOO_FEW_CARDS']);
  db.catalog_collections[1].is_active = false;
  out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'TOO_FEW_CARDS']);
  assert.deepEqual(out.errors.skipped.map((s) => s.reason), ['inactive']);
  db.catalog_collections[1].is_active = true;

  db.catalogs[0].settings.enabled = false;
  out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'CATALOGUE_DISABLED']);
  db.catalogs[0].settings.enabled = true;

  db.customers = [];
  out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'NO_RECIPIENTS']);

  db.customers = [customer(1), customer(2)];
  h.cfg.MAX_BROADCAST_RECIPIENTS = 1;
  out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'TOO_MANY_RECIPIENTS']);
  h.cfg.MAX_BROADCAST_RECIPIENTS = 1000;

  business = { ...business, isWhatsappConnected: false };
  out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [400, 'WHATSAPP_NOT_CONNECTED']);
  assert.equal(db.broadcasts.length, 0);
  assert.equal(queued.length, 0);
});

test('send: a picture Meta refuses is a 502 and leaves no broadcast behind', async () => {
  approve(2, ['en']);
  mediaFails = true;
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [502, 'COVER_UPLOAD_FAILED']);
  assert.equal(db.broadcasts.length, 0);
});

test('send: nothing reaches the queue -> the broadcast is marked failed, the wallet refunded, the recipient rows removed', async () => {
  h.cfg.WALLET_BILLING_ENABLED = true;
  rate = 80;
  approve(2, ['en']);
  db.customers = [customer(1), customer(2)];
  queueFails = true;
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.deepEqual([out.status, out.errors.code], [500, 'QUEUE_FAILED']);
  assert.equal(debits.length, 1);
  assert.equal(debits[0][1], 160);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0][1], 160);
  assert.equal(db.broadcasts[0].status, 'failed');
  assert.equal(db.broadcast_recipients.length, 0);
});

test('send with wallet billing on debits recipients x the marketing rate and tells the worker', async () => {
  h.cfg.WALLET_BILLING_ENABLED = true;
  rate = 80;
  approve(2, ['en']);
  db.customers = [customer(1), customer(2), customer(3)];
  const out = await send({ collectionIds: C.slice(0, 2) });
  assert.equal(out.status, 201);
  assert.equal(debits[0][1], 240);
  assert.deepEqual([queued[0].billed, queued[0].ratePerMessage], [true, 80]);
  assert.deepEqual(out.data.cost, { category: 'marketing', ratePerMessagePaise: 80, estimatedPaise: 240, walletBilling: true });
});
