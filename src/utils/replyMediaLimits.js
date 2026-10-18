// Per-plan limits on the media one reply node may carry, plus the pure helpers the write path
// (flowGraph.controller.js) and the send path (webhook.controller.js) share.
//
// Photo #1 is the node's existing single image (media_id / image_url); gallery_media_ids holds
// photos #2..N; video_media_id is the (Business plan) video.

const BASIC_LIMITS = Object.freeze({ maxPhotos: 1, videoAllowed: false });

// WhatsApp Cloud API's own video cap, same number as businessMedia.service.js's MAX_BYTES_BY_TYPE.video.
const MAX_REPLY_VIDEO_BYTES = 16 * 1024 * 1024;

/**
 * @param {Object|null} plan a plans row (snake_case, as on tenant.plan / subscription.plan); null when the
 *   business has no active subscription (or it expired) -> Basic limits.
 * @returns {{ maxPhotos: number, videoAllowed: boolean }}
 */
const getReplyMediaLimits = (plan) => {
  if (!plan) return { ...BASIC_LIMITS };
  const perReply = Number.parseInt(plan.images_per_reply, 10);
  return {
    maxPhotos: Number.isFinite(perReply) ? Math.max(1, perReply) : BASIC_LIMITS.maxPhotos,
    videoAllowed: plan.video_per_reply === true
  };
};

// Cards one carousel reply may carry (plans.carousel_max_cards, 2..10). No plan / no active
// subscription -> the Basic default, same as the photo limits above.
const BASIC_CAROUSEL_MAX_CARDS = 3;
const getCarouselMaxCards = (plan) => {
  const max = plan ? Number.parseInt(plan.carousel_max_cards, 10) : NaN;
  return Number.isFinite(max) ? Math.min(10, Math.max(2, max)) : BASIC_CAROUSEL_MAX_CARDS;
};

const galleryOf = (node) => {
  const list = node && (node.gallery_media_ids ?? node.galleryMediaIds);
  return Array.isArray(list) ? list : [];
};

const hasMainPhoto = (node) => !!(node && (node.image_url || node.imageUrl || node.media_id || node.mediaId));

/** Photos a node carries: photo #1 (if any) + the gallery. Accepts a snake_case row or its camelCase form. */
const countPhotos = (node) => (hasMainPhoto(node) ? 1 : 0) + galleryOf(node).length;

/**
 * What the send path should send for a node under the CURRENT plan limits, without touching the database.
 * Stored media beyond the limits (e.g. after a downgrade) is reported as skipped, never an error.
 * A 'list' reply never carries media.
 * @returns {{ photoIds: string[], videoId: string|null, skippedPhotos: number, skippedVideo: boolean }}
 */
const planReplyMediaSend = (node, limits) => {
  const gallery = [...new Set(galleryOf(node))];
  const videoId = (node && (node.video_media_id ?? node.videoMediaId)) || null;
  const contentType = node && (node.content_type ?? node.contentType);

  if (contentType === 'list') {
    return { photoIds: [], videoId: null, skippedPhotos: gallery.length, skippedVideo: !!videoId };
  }

  const slots = Math.max(0, limits.maxPhotos - (hasMainPhoto(node) ? 1 : 0));
  const photoIds = gallery.slice(0, slots);
  const sendVideo = !!videoId && limits.videoAllowed;
  return {
    photoIds,
    videoId: sendVideo ? videoId : null,
    skippedPhotos: gallery.length - photoIds.length,
    skippedVideo: !!videoId && !sendVideo
  };
};

module.exports = {
  BASIC_LIMITS,
  MAX_REPLY_VIDEO_BYTES,
  getReplyMediaLimits,
  getCarouselMaxCards,
  countPhotos,
  planReplyMediaSend
};
