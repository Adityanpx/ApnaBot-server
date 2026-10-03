// Opt-in links: a wa.me link / QR poster whose prefilled message carries
// "JOIN-<code>". The webhook spots the code and asks the customer for
// marketing consent with Yes/No buttons (webhook.controller.js, Step 11.7).
// Pure helpers only — no database access — so they're unit-testable.

const crypto = require('crypto');

// No 0/O, 1/I/L or U — easy to read off a printed poster.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 4;

// "JOIN-K7Q2" inside the customer's message. Matched on the raw text (not
// chatbotService.normalizeText, which strips the '-'), case-insensitive, and
// tolerant of the customer editing the separator ("join k7q2", "JOIN:k7q2").
// Fixed length + restricted alphabet keep ordinary messages ("join today")
// from matching.
const JOIN_CODE_PATTERN = /\bJOIN[\s\-_:#]*([2-9A-HJKMNP-TV-Z]{4})\b/i;
// Same thing, for stripping a code the owner typed into their greeting —
// with a "Code:" label in front of it, since the server appends its own.
const JOIN_CODE_PATTERN_GLOBAL = /\s*(?:\bcode\s*[:\-]?\s*)?\bJOIN[\s\-_:#]*[A-Z0-9]{4,8}\b/gi;

const DEFAULT_GREETING = 'Hi {{businessName}} 👋';
const GREETING_MAX_LENGTH = 200;

// Reserved button-reply ids. Never collide with flow_edges ids or node ids
// (UUIDs can't start with a letter past 'f'), "{node_id}:{index}" ids, or
// the language picker's "lang_{code}".
const OPT_IN_YES_PREFIX = 'optin_yes:';
const OPT_IN_NO_PREFIX = 'optin_no:';
const SYSTEM_TAP_PREFIXES = ['lang_', 'optin_'];

/** Random code from CODE_ALPHABET. */
const generateCode = () => {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
};

/**
 * The JOIN code in a customer's message, upper-cased, or null.
 * @param {string} text - raw message.text.body
 */
const parseJoinCode = (text) => {
  if (!text) return null;
  const match = String(text).match(JOIN_CODE_PATTERN);
  return match ? match[1].toUpperCase() : null;
};

/**
 * Clean an owner-entered greeting: strips any JOIN-xxxx (the server appends
 * the real code), collapses spaces. Returns { greeting } or { error }.
 * @param {*} input
 */
const normalizeGreeting = (input) => {
  if (typeof input !== 'string') return { error: 'greeting must be text' };
  const greeting = input.replace(JOIN_CODE_PATTERN_GLOBAL, '').replace(/[ \t]+/g, ' ').trim();
  if (greeting.length < 1 || greeting.length > GREETING_MAX_LENGTH) {
    return { error: `greeting must be 1–${GREETING_MAX_LENGTH} characters (without the JOIN code)` };
  }
  return { greeting };
};

/**
 * The message the customer sees prefilled in WhatsApp.
 * @param {string} greeting - opt_in_links.prefill_text ({{businessName}} allowed)
 * @param {string} code
 * @param {string} businessName
 */
const buildPrefillText = (greeting, code, businessName) =>
  `${String(greeting || '').replace(/\{\{businessName\}\}/g, businessName || '').trim()} Code: JOIN-${code}`;

/**
 * https://wa.me/<digits>?text=<prefill>, or null when the business has no
 * WhatsApp number (businesses.whatsapp_number: digits with country code, no '+').
 */
const buildWaMeUrl = (whatsappNumber, prefillText) => {
  const digits = String(whatsappNumber || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(prefillText)}`;
};

/** Whether a button-reply id is one of ours (language picker / opt-in), not a flow id. */
const isSystemTapId = (id) => !!id && SYSTEM_TAP_PREFIXES.some(prefix => id.startsWith(prefix));

/**
 * { answer: 'yes'|'no', linkId } for an opt-in button id, else null.
 * @param {string} id
 */
const parseOptInTapId = (id) => {
  if (!id) return null;
  if (id.startsWith(OPT_IN_YES_PREFIX)) return { answer: 'yes', linkId: id.slice(OPT_IN_YES_PREFIX.length) || null };
  if (id.startsWith(OPT_IN_NO_PREFIX)) return { answer: 'no', linkId: id.slice(OPT_IN_NO_PREFIX.length) || null };
  return null;
};

module.exports = {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_GREETING,
  GREETING_MAX_LENGTH,
  OPT_IN_YES_PREFIX,
  OPT_IN_NO_PREFIX,
  generateCode,
  parseJoinCode,
  normalizeGreeting,
  buildPrefillText,
  buildWaMeUrl,
  isSystemTapId,
  parseOptInTapId
};
