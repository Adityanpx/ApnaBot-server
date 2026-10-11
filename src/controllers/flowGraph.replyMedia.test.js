// Run: node --test src/controllers/flowGraph.replyMedia.test.js
// Reply-node gallery + video write path (POST/PUT /api/flow-graph/reply-nodes): ownership and type
// checks, the 16 MB video cap, plan limits (checked only when the write INCREASES what the reply
// carries), and the error codes the dashboard shows. In-memory Supabase (storage test harness).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-support/storageHarness');
h.cfg.ENCRYPTION_KEY = 'x'.repeat(32);
require('../test-support/stubRedis');

let plan = null; // the plans row of the business's active subscription (null = none)
const subPath = require.resolve('../services/subscription.service');
require.cache[subPath] = { id: subPath, filename: subPath, loaded: true, exports: {
  getActiveSubscription: async () => (plan ? { status: 'active', plan } : null)
} };
const controller = require('./flowGraph.controller');

const { B1, B2, uuid, url } = h;
const NODE = uuid(200);
const MAIN = uuid(100);
const P2 = uuid(101); const P3 = uuid(102); const P4 = uuid(103);
const VIDEO = uuid(110); const BIG_VIDEO = uuid(111); const OTHER_BIZ = uuid(120); const DOC = uuid(121);
const MB = 1024 * 1024;

const BASIC = { name: 'basic', display_name: 'Basic', images_per_reply: 1, video_per_reply: false };
const PRO = { name: 'pro', display_name: 'Pro', images_per_reply: 3, video_per_reply: false };
const BUSINESS = { name: 'business', display_name: 'Business', images_per_reply: 10, video_per_reply: true };

let db;
test.beforeEach(() => {
  db = h.reset();
  plan = BUSINESS;
  db.flow_nodes = [{
    id: NODE, business_id: B1, node_type: 'reply', keyword: 'hi', content_type: 'text', label: 'Welcome',
    image_url: url('business-media/main.jpeg'), media_id: MAIN, gallery_media_ids: [], video_media_id: null
  }];
  db.flow_edges = [];
  const img = (id) => ({ id, business_id: B1, url: url(`business-media/${id}.jpeg`), media_type: 'image', file_size_bytes: 1000 });
  db.business_media = [
    img(MAIN), img(P2), img(P3), img(P4),
    { id: VIDEO, business_id: B1, url: url('business-media/v.mp4'), media_type: 'video', file_size_bytes: 5 * MB },
    { id: BIG_VIDEO, business_id: B1, url: url('business-media/big.mp4'), media_type: 'video', file_size_bytes: 16 * MB + 1 },
    { ...img(OTHER_BIZ), business_id: B2 },
    { id: DOC, business_id: B1, url: url('business-media/d.pdf'), media_type: 'document', file_size_bytes: 10 }
  ];
});

const call = async (handler, { params = {}, body = {} } = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (payload) => { out.body = payload; return res; } };
  await handler({ params, body, query: {}, graphBusiness: { businessCategory: 'coaching' }, user: { businessId: B1, userId: 'u1' } }, res, (err) => { throw err; });
  return out;
};
const put = (body) => call(controller.updateReplyNode, { params: { id: NODE }, body });
const node = () => db.flow_nodes.find(n => n.id === NODE);

test('saves an ordered gallery and a video on a Business plan; the response carries them camelCased', async () => {
  const { status, body } = await put({ galleryMediaIds: [P3, P2], videoMediaId: VIDEO });
  assert.equal(status, 200);
  assert.deepEqual(node().gallery_media_ids, [P3, P2]);
  assert.equal(node().video_media_id, VIDEO);
  assert.deepEqual(body.data.galleryMediaIds, [P3, P2]);
  assert.equal(body.data.videoMediaId, VIDEO);
});

test('omitting both keys leaves the extra media untouched (text-only edit)', async () => {
  db.flow_nodes[0].gallery_media_ids = [P2];
  db.flow_nodes[0].video_media_id = VIDEO;
  const { status } = await put({ label: 'Hello' });
  assert.equal(status, 200);
  assert.deepEqual([node().gallery_media_ids, node().video_media_id], [[P2], VIDEO]);
});

test('a media id of another business is refused', async () => {
  const { status, body } = await put({ galleryMediaIds: [OTHER_BIZ] });
  assert.equal(status, 400);
  assert.match(body.message, /not a media library asset of this business/);
  assert.deepEqual(node().gallery_media_ids, []);
  assert.equal((await put({ videoMediaId: OTHER_BIZ })).status, 400);
});

test('wrong media types: a video or document in the gallery, an image as the video', async () => {
  assert.equal((await put({ galleryMediaIds: [VIDEO] })).status, 400);
  assert.equal((await put({ galleryMediaIds: [DOC] })).status, 400);
  const asVideo = await put({ videoMediaId: P2 });
  assert.equal(asVideo.status, 400);
  assert.match(asVideo.body.message, /only video assets/);
});

test('a video over 16 MB is refused; exactly 16 MB is fine', async () => {
  const { status, body } = await put({ videoMediaId: BIG_VIDEO });
  assert.equal(status, 400);
  assert.equal(body.message, 'Videos in replies must be 16 MB or smaller.');
  db.business_media.find(m => m.id === BIG_VIDEO).file_size_bytes = 16 * MB;
  assert.equal((await put({ videoMediaId: BIG_VIDEO })).status, 200);
});

test('duplicates are refused, including a gallery photo equal to photo #1', async () => {
  assert.equal((await put({ galleryMediaIds: [P2, P2] })).status, 400);
  const dupOfMain = await put({ galleryMediaIds: [MAIN] });
  assert.equal(dupOfMain.status, 400);
  assert.match(dupOfMain.body.message, /more than once/);
});

test('malformed values are refused', async () => {
  assert.equal((await put({ galleryMediaIds: 'nope' })).status, 400);
  assert.equal((await put({ galleryMediaIds: [1] })).status, 400);
  assert.equal((await put({ videoMediaId: 5 })).status, 400);
});

test('a gallery needs photo #1 (not auto-promoted): 400, nothing written', async () => {
  Object.assign(db.flow_nodes[0], { image_url: null, media_id: null });
  const { status, body } = await put({ galleryMediaIds: [P2] });
  assert.equal(status, 400);
  assert.equal(body.message, 'Add a main photo to this reply before adding more photos.');
  assert.deepEqual(node().gallery_media_ids, []);
  // ...but giving it photo #1 in the same request is fine
  assert.equal((await put({ mediaId: MAIN, galleryMediaIds: [P2] })).status, 200);
});

test('removing photo #1 while a gallery exists is refused until the gallery is cleared too', async () => {
  db.flow_nodes[0].gallery_media_ids = [P2];
  assert.equal((await put({ mediaId: null })).status, 400);
  assert.equal((await put({ mediaId: null, galleryMediaIds: [] })).status, 200);
});

test('a list reply cannot carry extra media', async () => {
  const { status } = await put({ contentType: 'list', galleryMediaIds: [P2] });
  assert.equal(status, 400);
});

test('Basic plan: a 2nd photo is a 403 PLAN_LIMIT_PHOTOS with limit, plan and message', async () => {
  plan = BASIC;
  const { status, body } = await put({ galleryMediaIds: [P2] });
  assert.equal(status, 403);
  assert.equal(body.message, 'Your Basic plan allows up to 1 photo per reply.');
  assert.deepEqual(body.errors, { code: 'PLAN_LIMIT_PHOTOS', limit: 1, plan: 'Basic' });
  assert.deepEqual(node().gallery_media_ids, []);
});

test('Pro plan: 3 photos total (photo #1 + 2 extra) pass, a 4th is refused', async () => {
  plan = PRO;
  assert.equal((await put({ galleryMediaIds: [P2, P3] })).status, 200);
  const over = await put({ galleryMediaIds: [P2, P3, P4] });
  assert.equal(over.status, 403);
  assert.equal(over.body.message, 'Your Pro plan allows up to 3 photos per reply.');
  assert.equal(over.body.errors.limit, 3);
});

test('no subscription is treated as Basic', async () => {
  plan = null;
  const { status, body } = await put({ galleryMediaIds: [P2] });
  assert.equal(status, 403);
  assert.deepEqual(body.errors, { code: 'PLAN_LIMIT_PHOTOS', limit: 1, plan: 'Basic' });
});

test('video on a plan without it: 403 PLAN_LIMIT_VIDEO', async () => {
  plan = PRO;
  const { status, body } = await put({ videoMediaId: VIDEO });
  assert.equal(status, 403);
  assert.equal(body.message, 'Video in replies is available on the Business plan.');
  assert.equal(body.errors.code, 'PLAN_LIMIT_VIDEO');
  assert.equal(node().video_media_id, null);
});

test('downgraded owner: text edits, photo swaps and removals still work; only an increase is blocked', async () => {
  Object.assign(db.flow_nodes[0], { gallery_media_ids: [P2, P3, P4], video_media_id: VIDEO });
  plan = BASIC; // stored: 4 photos + a video, allowed: 1 photo, no video
  assert.equal((await put({ label: 'New text' })).status, 200);
  assert.equal((await put({ galleryMediaIds: [P2, P3, P4] })).status, 200, 'same count re-saved');
  assert.equal((await put({ galleryMediaIds: [P4, P3, P2] })).status, 200, 'reorder');
  assert.equal((await put({ videoMediaId: VIDEO })).status, 200, 'same video re-saved');
  assert.equal((await put({ galleryMediaIds: [P3, P4] })).status, 200, 'removing one');
  assert.equal((await put({ mediaId: P2 })).status, 200, 'swapping photo #1');
  assert.equal((await put({ galleryMediaIds: [P3, P4, P2] })).status, 400, 'P2 is already photo #1');
  assert.equal((await put({ videoMediaId: null })).status, 200, 'removing the video');
  assert.equal((await put({ galleryMediaIds: [] })).status, 200, 'clearing the gallery');
  assert.deepEqual([node().gallery_media_ids, node().video_media_id], [[], null]);
  assert.equal((await put({ galleryMediaIds: [P3] })).status, 403, 'adding one back is an increase');
});

test('create: gallery and video are stored; plan limits apply the same way', async () => {
  const ok = await call(controller.createReplyNode, {
    body: { keyword: 'menu', label: 'Menu', mediaId: MAIN, galleryMediaIds: [P2], videoMediaId: VIDEO }
  });
  assert.equal(ok.status, 201);
  const row = db.flow_nodes.find(n => n.keyword === 'menu');
  assert.deepEqual([row.gallery_media_ids, row.video_media_id], [[P2], VIDEO]);

  plan = BASIC;
  const blocked = await call(controller.createReplyNode, {
    body: { keyword: 'menu2', label: 'Menu', mediaId: MAIN, galleryMediaIds: [P2] }
  });
  assert.equal(blocked.status, 403);
  assert.equal(db.flow_nodes.some(n => n.keyword === 'menu2'), false);
});

test('create without extra media is unaffected: no plan lookup, columns left to their DB defaults', async () => {
  plan = null;
  const { status } = await call(controller.createReplyNode, { body: { keyword: 'plain', label: 'Hi', mediaId: MAIN } });
  assert.equal(status, 201);
  const row = db.flow_nodes.find(n => n.keyword === 'plain');
  assert.equal('gallery_media_ids' in row, false);
});
