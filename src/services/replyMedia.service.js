const supabase = require('../config/supabase');
const { getActiveSubscription } = require('./subscription.service');
const { getReplyMediaLimits, MAX_REPLY_VIDEO_BYTES } = require('../utils/replyMediaLimits');

// Write-path validation for a reply node's extra media (flow_nodes.gallery_media_ids / video_media_id).
// Photo #1 stays the node's existing media_id / image_url and is resolved by flowGraph.controller.js as before.

const fail = (status, message, errors = null) => ({ error: { status, message, errors } });

const photosLabel = (n) => `${n} photo${n === 1 ? '' : 's'}`;

const isId = (v) => typeof v === 'string' && v.length > 0;

/**
 * Validates and plans the gallery/video part of a reply-node create or update.
 *
 * @param {Object} args
 * @param {string} args.businessId
 * @param {Object|null} args.existing        the current flow_nodes row (snake_case), null on create
 * @param {*} args.galleryMediaIds           request value; undefined = untouched
 * @param {*} args.videoMediaId              request value; undefined = untouched, null = remove
 * @param {boolean} args.mainPhotoAfter      whether photo #1 (media_id/image_url) will exist after this write
 * @param {string|null} [args.mainMediaIdAfter] photo #1's library id after this write (null for a raw url / none)
 * @param {string} args.contentTypeAfter    the node's content_type after this write
 * @returns {Promise<{ updates: Object, error: null } | { error: { status, message, errors } }>}
 *   updates holds only the columns to write (gallery_media_ids and/or video_media_id).
 */
const prepareReplyMediaWrite = async ({ businessId, existing, galleryMediaIds, videoMediaId, mainPhotoAfter, mainMediaIdAfter = null, contentTypeAfter }) => {
  const galleryTouched = galleryMediaIds !== undefined;
  const videoTouched = videoMediaId !== undefined;

  const existingGallery = existing && Array.isArray(existing.gallery_media_ids) ? existing.gallery_media_ids : [];
  const existingVideo = (existing && existing.video_media_id) || null;
  const mainPhotoBefore = !!(existing && (existing.image_url || existing.media_id));

  if (galleryTouched && (!Array.isArray(galleryMediaIds) || !galleryMediaIds.every(isId))) {
    return fail(400, 'galleryMediaIds must be an array of media library ids.');
  }
  if (videoTouched && videoMediaId !== null && !isId(videoMediaId)) {
    return fail(400, 'videoMediaId must be a media library id or null.');
  }

  const finalGallery = galleryTouched ? galleryMediaIds : existingGallery;
  const finalVideo = videoTouched ? videoMediaId : existingVideo;

  // Extra media untouched and photo #1 neither added nor removed: nothing to validate or write.
  const mainPhotoRemoved = mainPhotoBefore && !mainPhotoAfter;
  if (!galleryTouched && !videoTouched && mainPhotoBefore === mainPhotoAfter) {
    return { updates: {}, error: null };
  }

  // Duplicates, photo #1's own library asset included.
  const photoIds = mainMediaIdAfter ? [mainMediaIdAfter, ...finalGallery] : finalGallery;
  if (new Set(photoIds).size !== photoIds.length) {
    return fail(400, 'galleryMediaIds contains the same photo more than once.');
  }

  if ((galleryTouched || videoTouched) && contentTypeAfter === 'list' && (finalGallery.length > 0 || finalVideo)) {
    return fail(400, 'A list reply cannot carry extra photos or a video.');
  }

  // A gallery with no photo #1 would be sent as a bare run of images. Refuse to create or keep that
  // state when this request is what puts it there; an already-existing one (e.g. photo #1 removed by
  // storage cleanup) is left alone.
  if (finalGallery.length > 0 && !mainPhotoAfter && (galleryTouched || mainPhotoRemoved)) {
    return fail(400, 'Add a main photo to this reply before adding more photos.');
  }

  // ---- every id is this business's media row of the right type -------------------------
  const checkIds = [
    ...(galleryTouched ? galleryMediaIds : []),
    ...(videoTouched && videoMediaId ? [videoMediaId] : [])
  ];
  if (checkIds.length > 0) {
    const { data: rows, error } = await supabase
      .from('business_media').select('id, media_type, file_size_bytes').eq('business_id', businessId).in('id', checkIds);
    if (error) throw error;
    const byId = new Map((rows || []).map(r => [r.id, r]));

    for (const id of (galleryTouched ? galleryMediaIds : [])) {
      const media = byId.get(id);
      if (!media) return fail(400, 'galleryMediaIds contains an id that is not a media library asset of this business.');
      if (media.media_type !== 'image') {
        return fail(400, `galleryMediaIds references a ${media.media_type} asset — only image assets can be used here.`);
      }
    }
    if (videoTouched && videoMediaId) {
      const media = byId.get(videoMediaId);
      if (!media) return fail(400, 'videoMediaId does not reference a media library asset belonging to this business.');
      if (media.media_type !== 'video') {
        return fail(400, `videoMediaId references a ${media.media_type} asset — only video assets can be used here.`);
      }
      if (Number(media.file_size_bytes) > MAX_REPLY_VIDEO_BYTES) {
        return fail(400, 'Videos in replies must be 16 MB or smaller.');
      }
    }
  }

  // ---- plan limits: only when the write INCREASES what the reply carries -------------------
  // (an owner who downgraded must still be able to edit text, swap or remove photos)
  const photosBefore = (mainPhotoBefore ? 1 : 0) + existingGallery.length;
  const photosAfter = (mainPhotoAfter ? 1 : 0) + finalGallery.length;
  const photosIncrease = photosAfter > photosBefore;
  const videoIncrease = !!finalVideo && !existingVideo;

  if (photosIncrease || videoIncrease) {
    const subscription = await getActiveSubscription(businessId);
    const plan = subscription && subscription.plan ? subscription.plan : null;
    const limits = getReplyMediaLimits(plan);
    const planName = (plan && (plan.display_name || plan.name)) || 'Basic';

    if (photosIncrease && photosAfter > limits.maxPhotos) {
      return fail(403, `Your ${planName} plan allows up to ${photosLabel(limits.maxPhotos)} per reply.`,
        { code: 'PLAN_LIMIT_PHOTOS', limit: limits.maxPhotos, plan: planName });
    }
    if (videoIncrease && !limits.videoAllowed) {
      return fail(403, 'Video in replies is available on the Business plan.',
        { code: 'PLAN_LIMIT_VIDEO', limit: 0, plan: planName });
    }
  }

  const updates = {};
  if (galleryTouched) updates.gallery_media_ids = galleryMediaIds;
  if (videoTouched) updates.video_media_id = videoMediaId;
  return { updates, error: null };
};

module.exports = { prepareReplyMediaWrite };
