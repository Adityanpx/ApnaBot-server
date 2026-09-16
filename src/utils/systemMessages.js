// Catalog of system-authored, customer-facing strings that aren't tied to
// any node/edge (so they can't go through label_translations like
// node-authored copy does). Entries only need the languages they actually
// have translations for — getSystemMessage falls back to 'en', same as
// getLocalizedText falls back to the untranslated column.
const SYSTEM_MESSAGES = {
  webFormPrompt: {
    en: 'Tap below to fill in your request. This link expires in 30 minutes.'
  },
  webFormButtonText: {
    en: 'Fill booking form'
  },
  bookingConfirmFailedFallback: {
    en: 'Sorry, something went wrong confirming your booking — our team will reach out to you shortly.'
  },
  webFormLinkFailedFallback: {
    en: 'Sorry, something went wrong generating your booking link — our team will reach out to you shortly.'
  },
  paymentTriggerDefault: {
    en: 'Please complete your payment.'
  },
  genericFallbackReply: {
    en: 'Thank you for your message. We will get back to you soon.'
  },
  locationNotConfigured: {
    en: 'Sorry, our location is not set up yet.'
  },
  vehicleNoLongerAvailable: {
    en: 'Sorry, that vehicle is no longer available for this route. Here are the current options:'
  }
};

/**
 * Look up a system-authored string by key, falling back to English when
 * languageCode is missing/invalid or has no translation for this key.
 * @param {string} key - a SYSTEM_MESSAGES key
 * @param {string|null|undefined} languageCode
 */
const getSystemMessage = (key, languageCode) => {
  const entry = SYSTEM_MESSAGES[key];
  if (!entry) return undefined;
  if (languageCode) {
    const translated = entry[languageCode];
    if (translated !== undefined && translated !== null && String(translated).trim() !== '') {
      return translated;
    }
  }
  return entry.en;
};

module.exports = { SYSTEM_MESSAGES, getSystemMessage };
