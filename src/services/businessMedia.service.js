const sharp = require('sharp');
const supabase = require('../config/supabase');
const r2 = require('./r2.service');
const { getActiveSubscription } = require('./subscription.service');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

// mimetype -> business_media.media_type, kept in sync with
// upload.middleware.js's mediaFileFilter allow-list.
const MIME_TO_MEDIA_TYPE = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
  'application/pdf': 'document'
};

// Enforced BEFORE the R2 upload — see upload.middleware.js's comment on why
// multer's own limits.fileSize can't express a per-type cap.
const MAX_BYTES_BY_TYPE = {
  image: 2 * 1024 * 1024,
  video: 16 * 1024 * 1024,   // matches WhatsApp Cloud API's own video limit
  document: 10 * 1024 * 1024
};

const IMAGE_MAX_DIMENSION = 1280;
const IMAGE_QUALITY = 80;

/**
 * Resize/re-encode an image buffer: max dimension 1280px, ~80% quality.
 * WebP in, WebP out (keeps transparency); everything else (JPEG, PNG) is
 * re-encoded as JPEG — PNG transparency is flattened in that case, which is
 * an accepted tradeoff of normalizing to two output formats instead of
 * preserving every input format.
 */
const processImage = async (buffer, mimetype) => {
  const image = sharp(buffer).rotate(); // rotate() auto-applies EXIF orientation, then strips it
  const resized = image.resize({
    width: IMAGE_MAX_DIMENSION,
    height: IMAGE_MAX_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true
  });

  const outputMimetype = mimetype === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const output = outputMimetype === 'image/webp'
    ? await resized.webp({ quality: IMAGE_QUALITY }).toBuffer({ resolveWithObject: true })
    : await resized.jpeg({ quality: IMAGE_QUALITY }).toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    mimetype: outputMimetype,
    width: output.info.width,
    height: output.info.height
  };
};

/**
 * POST /api/business/media
 * Upload one file to this business's media library. Enforces per-type size
 * caps and plan storage quota before touching R2.
 */
const uploadBusinessMedia = async (businessId, file) => {
  const mediaType = MIME_TO_MEDIA_TYPE[file.mimetype];
  if (!mediaType) {
    const err = new Error(`Unsupported file type: ${file.mimetype}`);
    err.statusCode = 400;
    throw err;
  }

  const maxBytes = MAX_BYTES_BY_TYPE[mediaType];
  if (file.buffer.length > maxBytes) {
    const err = new Error(`${mediaType} files must be ${Math.round(maxBytes / (1024 * 1024))}MB or smaller.`);
    err.statusCode = 400;
    throw err;
  }

  let uploadBuffer = file.buffer;
  let uploadMimetype = file.mimetype;
  let width = null;
  let height = null;

  if (mediaType === 'image') {
    const processed = await processImage(file.buffer, file.mimetype);
    uploadBuffer = processed.buffer;
    uploadMimetype = processed.mimetype;
    width = processed.width;
    height = processed.height;
  }

  const finalFileSize = uploadBuffer.length;

  const subscription = await getActiveSubscription(businessId);
  if (!subscription || !subscription.plan) {
    const err = new Error('No active subscription. Please subscribe to continue.');
    err.statusCode = 403;
    throw err;
  }

  const { data: business, error: businessErr } = await supabase
    .from('businesses').select('storage_used_bytes').eq('id', businessId).maybeSingle();
  if (businessErr) throw businessErr;
  if (!business) {
    const err = new Error('Business not found');
    err.statusCode = 404;
    throw err;
  }

  const limitBytes = subscription.plan.storage_limit_mb * 1024 * 1024;
  if (business.storage_used_bytes + finalFileSize > limitBytes) {
    const err = new Error(
      `This upload would exceed your plan's storage limit (${subscription.plan.storage_limit_mb}MB). ` +
      'Delete unused media or upgrade your plan.'
    );
    err.statusCode = 400;
    throw err;
  }

  const publicId = `${businessId}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const { url, key } = await r2.uploadImage(uploadBuffer, 'business-media', publicId, uploadMimetype);

  const { data: mediaRow, error: insertErr } = await supabase.from('business_media').insert({
    business_id: businessId,
    media_type: mediaType,
    url,
    r2_key: key,
    file_size_bytes: finalFileSize,
    original_filename: file.originalname || null,
    width,
    height
  }).select().single();
  if (insertErr) {
    // Insert failed after the R2 write succeeded — clean up the orphaned
    // object rather than leaving it uncounted and undeletable through the API.
    try {
      await r2.deleteImage(key);
    } catch (cleanupErr) {
      logger.error(`Failed to clean up orphaned R2 object ${key} after business_media insert failure:`, cleanupErr);
    }
    throw insertErr;
  }

  const { error: rpcError } = await supabase.rpc('increment_business_storage_used', {
    p_business_id: businessId,
    p_delta_bytes: finalFileSize
  });
  if (rpcError) {
    logger.error(`business_media row ${mediaRow.id} created but storage_used_bytes increment failed for business ${businessId}:`, rpcError);
  }

  return toCamelCase(mediaRow);
};

/**
 * GET /api/business/media
 */
const listBusinessMedia = async (businessId, mediaType) => {
  let query = supabase.from('business_media').select('*').eq('business_id', businessId);
  if (mediaType) {
    query = query.eq('media_type', mediaType);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(toCamelCase);
};

/**
 * DELETE /api/business/media/:id
 * Refuses to delete a media row still referenced by a live flow_nodes row.
 */
const deleteBusinessMedia = async (businessId, mediaId) => {
  const { data: media, error: findErr } = await supabase
    .from('business_media').select('*').eq('id', mediaId).eq('business_id', businessId).maybeSingle();
  if (findErr) throw findErr;
  if (!media) {
    const err = new Error('Media not found');
    err.statusCode = 404;
    throw err;
  }

  const { data: referencingNodes, error: refErr } = await supabase
    .from('flow_nodes').select('label, keyword').eq('media_id', mediaId);
  if (refErr) throw refErr;

  if ((referencingNodes || []).length > 0) {
    const names = referencingNodes.map(n => n.keyword || n.label).join(', ');
    const err = new Error(`Used by: ${names} — remove it from those replies first.`);
    err.statusCode = 400;
    throw err;
  }

  await r2.deleteImage(media.r2_key);

  const { error: deleteErr } = await supabase.from('business_media').delete().eq('id', mediaId);
  if (deleteErr) throw deleteErr;

  const { error: rpcError } = await supabase.rpc('increment_business_storage_used', {
    p_business_id: businessId,
    p_delta_bytes: -media.file_size_bytes
  });
  if (rpcError) {
    logger.error(`business_media row ${mediaId} deleted but storage_used_bytes decrement failed for business ${businessId}:`, rpcError);
  }
};

/**
 * GET /api/business/storage-status
 */
const getStorageStatus = async (businessId) => {
  const { data: business, error: businessErr } = await supabase
    .from('businesses').select('storage_used_bytes').eq('id', businessId).maybeSingle();
  if (businessErr) throw businessErr;
  if (!business) {
    const err = new Error('Business not found');
    err.statusCode = 404;
    throw err;
  }

  const subscription = await getActiveSubscription(businessId);
  const limitMb = subscription && subscription.plan ? subscription.plan.storage_limit_mb : 0;
  const limitBytes = limitMb * 1024 * 1024;

  return {
    usedBytes: business.storage_used_bytes,
    limitBytes,
    usedMb: Math.round((business.storage_used_bytes / (1024 * 1024)) * 100) / 100,
    limitMb
  };
};

module.exports = {
  uploadBusinessMedia,
  listBusinessMedia,
  deleteBusinessMedia,
  getStorageStatus
};
