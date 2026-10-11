// Run: node --test src/utils/replyMediaLimits.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getReplyMediaLimits, countPhotos, planReplyMediaSend } = require('./replyMediaLimits');

const BASIC = { images_per_reply: 1, video_per_reply: false };
const PRO = { images_per_reply: 3, video_per_reply: false };
const BUSINESS = { images_per_reply: 10, video_per_reply: true };

test('limits: each plan gets its own photo cap and video flag', () => {
  assert.deepEqual(getReplyMediaLimits(BASIC), { maxPhotos: 1, videoAllowed: false });
  assert.deepEqual(getReplyMediaLimits(PRO), { maxPhotos: 3, videoAllowed: false });
  assert.deepEqual(getReplyMediaLimits(BUSINESS), { maxPhotos: 10, videoAllowed: true });
});

test('limits: no subscription / expired (no plan) -> Basic limits', () => {
  assert.deepEqual(getReplyMediaLimits(null), { maxPhotos: 1, videoAllowed: false });
  assert.deepEqual(getReplyMediaLimits(undefined), { maxPhotos: 1, videoAllowed: false });
});

test('limits: maxPhotos is at least 1; a plan row from before the migration (no columns) is Basic', () => {
  assert.equal(getReplyMediaLimits({ images_per_reply: 0 }).maxPhotos, 1);
  assert.equal(getReplyMediaLimits({ images_per_reply: -4 }).maxPhotos, 1);
  assert.deepEqual(getReplyMediaLimits({ name: 'business' }), { maxPhotos: 1, videoAllowed: false });
  assert.equal(getReplyMediaLimits({ images_per_reply: 5, video_per_reply: 'true' }).videoAllowed, false);
});

test('countPhotos: photo #1 (library asset or raw url) plus the gallery', () => {
  assert.equal(countPhotos({ media_id: null, image_url: null, gallery_media_ids: [] }), 0);
  assert.equal(countPhotos({ media_id: 'm1', image_url: 'https://x/1.jpg', gallery_media_ids: [] }), 1);
  assert.equal(countPhotos({ image_url: 'https://elsewhere/1.jpg', gallery_media_ids: ['a', 'b'] }), 3);
  assert.equal(countPhotos({ media_id: 'm1', gallery_media_ids: ['a'] }), 2);
  assert.equal(countPhotos({ imageUrl: 'u', galleryMediaIds: ['a', 'b'] }), 3, 'camelCase node');
  assert.equal(countPhotos({ gallery_media_ids: ['a'] }), 1, 'gallery without photo #1');
  assert.equal(countPhotos({}), 0);
  assert.equal(countPhotos(null), 0);
});

const node = (over = {}) => ({ id: 'n1', imageUrl: 'https://x/1.jpg', galleryMediaIds: [], videoMediaId: null, contentType: 'text', ...over });

test('send plan: gallery photos fill the slots left after photo #1, in order', () => {
  const n = node({ galleryMediaIds: ['a', 'b', 'c'] });
  assert.deepEqual(planReplyMediaSend(n, { maxPhotos: 10, videoAllowed: true }),
    { photoIds: ['a', 'b', 'c'], videoId: null, skippedPhotos: 0, skippedVideo: false });
  assert.deepEqual(planReplyMediaSend(n, { maxPhotos: 3, videoAllowed: false }).photoIds, ['a', 'b']);
});

test('send plan: after a downgrade, over-limit photos and the video are skipped, not errors', () => {
  const n = node({ galleryMediaIds: ['a', 'b', 'c'], videoMediaId: 'v' });
  assert.deepEqual(planReplyMediaSend(n, { maxPhotos: 1, videoAllowed: false }),
    { photoIds: [], videoId: null, skippedPhotos: 3, skippedVideo: true });
  assert.deepEqual(planReplyMediaSend(n, { maxPhotos: 2, videoAllowed: true }),
    { photoIds: ['a'], videoId: 'v', skippedPhotos: 2, skippedVideo: false });
});

test('send plan: with no photo #1 the gallery may use every slot; duplicates collapse', () => {
  const n = node({ imageUrl: null, galleryMediaIds: ['a', 'a', 'b'] });
  assert.deepEqual(planReplyMediaSend(n, { maxPhotos: 2, videoAllowed: false }).photoIds, ['a', 'b']);
});

test('send plan: a list reply carries no extra media; snake_case rows work too', () => {
  const list = node({ contentType: 'list', galleryMediaIds: ['a'], videoMediaId: 'v' });
  assert.deepEqual(planReplyMediaSend(list, { maxPhotos: 10, videoAllowed: true }),
    { photoIds: [], videoId: null, skippedPhotos: 1, skippedVideo: true });
  const snake = { image_url: 'u', gallery_media_ids: ['a'], video_media_id: 'v', content_type: 'text' };
  assert.deepEqual(planReplyMediaSend(snake, { maxPhotos: 5, videoAllowed: true }),
    { photoIds: ['a'], videoId: 'v', skippedPhotos: 0, skippedVideo: false });
});
