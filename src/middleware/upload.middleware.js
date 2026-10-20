const multer = require('multer');
const { errorResponse } = require('../utils/response');

// Configure multer with memory storage (not disk storage)
const storage = multer.memoryStorage();

// File filter - only allow images
const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and WebP are allowed.'), false);
  }
};

// Configure multer
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// Export single file upload middleware
const uploadSingle = upload.single('image');

// Error handling wrapper
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return errorResponse(res, 400, 'File size exceeds 5MB limit');
    }
    return errorResponse(res, 400, err.message);
  } else if (err) {
    return errorResponse(res, 400, err.message);
  }
  next();
};

// Business media library (image/video/PDF) — a separate multer instance
// from `upload` above since the accepted mimetypes and size ceiling differ
// (that one is image-only, 5MB flat). This filter only rejects unsupported
// mimetypes; the real per-type caps (2MB image / 16MB video / 10MB document)
// are enforced in businessMedia.service.js BEFORE the R2 upload, since
// multer's own limits.fileSize is a single flat number and can't express
// "cap differs by mimetype". The 16MB ceiling here is just a backstop so an
// oversized upload never has to fully buffer into memory before rejection.
const mediaFileFilter = (req, file, cb) => {
  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/pdf'
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPEG/PNG/WebP images, MP4/MOV/WebM video, or PDF.'), false);
  }
};

const mediaUpload = multer({
  storage,
  fileFilter: mediaFileFilter,
  limits: {
    fileSize: 16 * 1024 * 1024 // 16MB backstop — see comment above
  }
});

const uploadMediaSingle = mediaUpload.single('file');

// Contact import (CSV / XLSX). Checked by file extension — browsers send CSV
// under several mimetypes (text/csv, application/vnd.ms-excel, text/plain…).
// Old .xls is refused here with a clear message; contactImport.service.js
// re-checks the type before parsing.
const importFileFilter = (req, file, cb) => {
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.xlsx')) return cb(null, true);
  if (name.endsWith('.xls')) {
    return cb(new Error('Old Excel (.xls) files aren\'t supported. In Excel, use File → Save As → .xlsx or CSV, then upload again.'), false);
  }
  return cb(new Error('Upload a CSV or Excel (.xlsx) file'), false);
};

const importUpload = multer({
  storage,
  fileFilter: importFileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1
  }
});

const uploadImportSingle = importUpload.single('file');

// Catalogue batch upload (POST /api/catalog/media): up to 10 photos, field name 'files', 5MB each. Every file
// type is let through here so a wrong one gets its own per-file error from catalogMedia.service.js instead of
// failing the whole batch; only a file over 5MB or an 11th file aborts the request (multer cannot go on).
const catalogImagesUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }
}).array('files', 10);

const uploadCatalogImages = (req, res, next) => {
  catalogImagesUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return errorResponse(res, 400, 'Each photo must be 5 MB or smaller.', { code: 'FILE_TOO_LARGE' });
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
        return errorResponse(res, 400, 'You can upload up to 10 photos at a time (field name "files").', { code: 'TOO_MANY_FILES' });
      }
    }
    return errorResponse(res, 400, err.message, { code: 'UPLOAD_ERROR' });
  });
};

module.exports = {
  uploadSingle,
  uploadMediaSingle,
  uploadImportSingle,
  uploadCatalogImages,
  handleUploadError,
  upload
};
