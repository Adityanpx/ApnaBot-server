const { uploadBusinessMedia, getStorageStatus } = require('./businessMedia.service');
const logger = require('../utils/logger');

// POST /api/catalog/media: up to 10 photos in one request into the business's media library. Each file goes
// through the same path as POST /api/business/media (type check, plan storage quota, resized to <= 1280px at
// quality 80), with two catalogue-only differences: a 5 MB input cap (the server re-encodes anyway) and WebP
// is converted to JPEG (WhatsApp image headers are JPEG / PNG). Files are handled one at a time (memory on a
// small instance), each with its own result, and once the storage quota is hit the rest are not attempted.

const MAX_FILES = 10;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const codeOf = (error) => {
  if (error.code === 'STORAGE_LIMIT') return 'STORAGE_LIMIT';
  if (error.statusCode === 403) return 'NO_SUBSCRIPTION';
  if (error.statusCode === 400) return 'INVALID_FILE';
  return 'UPLOAD_FAILED';
};

/**
 * @param {string} businessId
 * @param {Array<{ buffer: Buffer, mimetype: string, originalname?: string }>} files  multer memory files
 * @returns {Promise<{ uploaded: number, failed: number, results: Object[], storage: Object }>}
 *   results[i] = { index, filename, ok: true, media } | { index, filename, ok: false, code, error }
 */
const uploadCatalogImages = async (businessId, files) => {
  const results = [];
  let storageFull = false;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const filename = file.originalname || null;
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      results.push({ index, filename, ok: false, code: 'UNSUPPORTED_TYPE', error: 'Only JPEG, PNG and WebP photos can be added to the catalogue.' });
      continue;
    }
    if (file.buffer && file.buffer.length > MAX_INPUT_BYTES) {
      results.push({ index, filename, ok: false, code: 'FILE_TOO_LARGE', error: 'Photos must be 5 MB or smaller.' });
      continue;
    }
    if (storageFull) {
      results.push({ index, filename, ok: false, code: 'STORAGE_LIMIT', error: 'Not uploaded: your storage is full. Delete unused media or upgrade your plan.' });
      continue;
    }
    try {
      const media = await uploadBusinessMedia(businessId, file, { maxImageBytes: MAX_INPUT_BYTES, forceJpeg: true });
      results.push({ index, filename, ok: true, media });
    } catch (error) {
      const code = codeOf(error);
      if (code === 'STORAGE_LIMIT') storageFull = true;
      if (code === 'UPLOAD_FAILED') logger.error('Catalogue batch upload: a file failed', { businessId, filename, message: error.message });
      results.push({ index, filename, ok: false, code, error: code === 'UPLOAD_FAILED' ? 'The photo could not be saved. Please try again.' : error.message });
    }
  }
  const uploaded = results.filter(r => r.ok).length;
  return { uploaded, failed: results.length - uploaded, results, storage: await getStorageStatus(businessId) };
};

module.exports = { uploadCatalogImages, MAX_FILES, MAX_INPUT_BYTES, ALLOWED_TYPES };
