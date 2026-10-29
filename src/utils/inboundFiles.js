// Which customer files the bot stores, and what they are stored as. Used by the booking "file"
// question (webhook.controller.js -> bookingFile.service.js) and by the "thank them and alert the
// team" media setting (documents saved to the chat). Pure: no I/O.
//
// The extension comes from a fixed MIME -> extension map; when the MIME is not on it (Meta sends
// application/octet-stream for some Excel / CSV files) the original filename's extension is used
// if it is on the list. Anything else is not stored.
const MB = 1024 * 1024;
const MAX_FILE_BYTES = 16 * MB;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
};

// What the stored object is served as, by extension.
const EXT_TO_MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const ALLOWED_EXTENSIONS = Object.keys(EXT_TO_MIME);

const normalizeMime = (mimeType) => String(mimeType || '').split(';')[0].trim().toLowerCase();

/** Lower-case extension of a filename ('Quote.PDF' -> 'pdf'), jpeg folded into jpg, or null. */
const filenameExtension = (filename) => {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(filename || '').trim());
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
};

/**
 * @param {string|null} mimeType - from Meta (message payload or the media download)
 * @param {string|null} [filename] - the document's original filename, when it has one
 * @returns {{ext: string, contentType: string}|null} null when the file is not on the allow-list
 */
const resolveStorableFile = (mimeType, filename = null) => {
  const fromMime = MIME_TO_EXT[normalizeMime(mimeType)];
  const fromName = filenameExtension(filename);
  const ext = fromMime || (fromName && EXT_TO_MIME[fromName] ? fromName : null);
  return ext ? { ext, contentType: EXT_TO_MIME[ext] } : null;
};

module.exports = { MAX_FILE_BYTES, MIME_TO_EXT, EXT_TO_MIME, ALLOWED_EXTENSIONS, resolveStorableFile, filenameExtension };
