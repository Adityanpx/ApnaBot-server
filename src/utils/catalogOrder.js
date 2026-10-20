// What a catalogue "Order" hands to the booking engine / the web booking form: three named values, so a
// booking made from the catalogue says which collection / design / price it is for. Pure helpers (only
// systemMessages), shared by bookingGraph.service.js (chat booking), webhook.controller.js (web form
// token) and publicServiceForm.controller.js (the form's chips and locked fields).
//
//   prefill = [{ key, value }]  key is one of PREFILL_KEYS; value is plain text (base-language title,
//   the item's design number and price text), saved as-is in bookings.fields[key].
//
// A booking question (or web-form field) whose field_key / name equals one of the keys is not asked: the
// value is already known (bookingGraph.service.js prefilledKeys, publicServiceForm.controller.js lockedFields).
const { getSystemMessage } = require('./systemMessages');

const PREFILL_KEYS = Object.freeze({
  catalogCollection: 'catalogFieldCollection',
  catalogDesignNo: 'catalogFieldDesignNo',
  catalogPrice: 'catalogFieldPrice'
});

const isPrefillKey = (key) => Object.prototype.hasOwnProperty.call(PREFILL_KEYS, key);

const cleanText = (value) => (value === undefined || value === null ? '' : String(value).replace(/\s+/g, ' ').trim());

/**
 * @param {{ collection: { title: string, priceLabel?: string }, item?: { designNo?: string, priceText?: string } }} args
 * @returns {{ key: string, value: string }[]} only entries that have a value
 */
const buildPrefill = ({ collection, item = null }) => {
  const price = item ? cleanText(item.priceText) : cleanText(collection && collection.priceLabel);
  return [
    { key: 'catalogCollection', value: cleanText(collection && collection.title) },
    { key: 'catalogDesignNo', value: item ? cleanText(item.designNo) : '' },
    { key: 'catalogPrice', value: price }
  ].filter(entry => entry.value !== '');
};

/** Keeps only well-formed known entries (a token's stored prefill is data, never trusted blindly). */
const sanitizePrefill = (raw) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || !isPrefillKey(entry.key) || seen.has(entry.key)) continue;
    const value = cleanText(entry.value);
    if (!value) continue;
    seen.add(entry.key);
    out.push({ key: entry.key, value: value.slice(0, 200) });
  }
  return out;
};

/** The field's label in the customer's language (falls back to English). */
const prefillLabel = (key, languageCode = null) => getSystemMessage(PREFILL_KEYS[key], languageCode);

module.exports = { PREFILL_KEYS, isPrefillKey, buildPrefill, sanitizePrefill, prefillLabel };
