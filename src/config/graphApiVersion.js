// The one Meta Graph API version every server call uses (whatsapp.service.js
// builds META_API_BASE from it; everything else imports META_API_BASE).
// Override with GRAPH_API_VERSION on Render — setting it back to an older
// version (e.g. v21.0) is the rollback, no code deploy needed.
//
// Meta defaults calls to an expired version to the next oldest usable one,
// so a stale hardcoded version silently drifts instead of failing — see
// https://developers.facebook.com/docs/graph-api/changelog/versions for
// expiry dates (v25.0 is supported until 2028-07-29).
//
// public/whatsapp-connect.html (FB.init) and apnabot-web's
// use-whatsapp-signup.ts hardcode the same default; graphApiVersion.test.js
// checks the html copy.
const DEFAULT_GRAPH_API_VERSION = 'v25.0';

const VERSION_PATTERN = /^v\d+\.\d+$/;

/**
 * The version to use for a raw GRAPH_API_VERSION value: the default when
 * unset/blank, else the value itself. A malformed value throws so a typo
 * fails at boot instead of breaking every send.
 * @param {string|undefined} raw
 * @returns {string}
 */
const resolveGraphApiVersion = (raw) => {
  const value = (raw || '').trim();
  if (!value) return DEFAULT_GRAPH_API_VERSION;
  if (!VERSION_PATTERN.test(value)) {
    throw new Error(`GRAPH_API_VERSION must look like v25.0, got "${raw}"`);
  }
  return value;
};

module.exports = { DEFAULT_GRAPH_API_VERSION, resolveGraphApiVersion };
