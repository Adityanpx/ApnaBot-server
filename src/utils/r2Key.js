const config = require('../config/env');

// R2 object key of a public URL r2.uploadImage returned, or null when the URL
// is not one of ours (e.g. an external link).
const r2KeyFromUrl = (url) =>
  url && url.startsWith(`${config.R2_PUBLIC_URL}/`) ? url.slice(config.R2_PUBLIC_URL.length + 1) : null;

module.exports = { r2KeyFromUrl };
