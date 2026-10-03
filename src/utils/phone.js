// Phone numbers from an imported contact list → the customers.whatsapp_number
// format: digits only, country code first, no '+' (what Meta sends as the
// webhook's message.from / wa_id — for India, 91 + 10 digits).
//
// India-first (v1): a number without '+' / '00' must be an Indian mobile —
// 10 digits starting 6-9, optionally with a leading 0 or 91. Any other
// country needs an explicit '+' or '00' prefix (8-15 digits, E.164's max),
// since "971501234567" without it can't be told apart from a typo. Other
// countries' wa_id can differ from the dialled number (Brazil's 9th digit,
// Mexico's 521), which is why v1 doesn't guess further.
//
// Reason codes for a rejected value:
//   empty                nothing in the cell
//   scientific_notation  Excel turned the number into 9.19876E+11 — the
//                        digits are already lost, re-export as text
//   too_short            fewer digits than any valid number
//   landline             Indian landline (10 digits starting 2-5) — not on WhatsApp
//   not_mobile           10 digits starting 0/1 (toll-free, service numbers)
//   invalid              anything else (letters, too long, foreign number
//                        without '+')

const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;
// Spaces (incl. non-breaking), dashes (incl. en/em), dots, brackets, slashes.
const SEPARATORS = /[\s \-‐-―.()/]/g;

/** An Indian national number (10 digits) → { phone } / { reason }. */
const indianMobile = (national) => {
  if (national.length < 10) return { reason: 'too_short' };
  if (national.length > 10) return { reason: 'invalid' };
  if (/^[6-9]/.test(national)) return { phone: `91${national}` };
  if (/^[2-5]/.test(national)) return { reason: 'landline' };
  return { reason: 'not_mobile' };
};

/**
 * @param {*} raw  a cell value (string or number)
 * @returns {{ phone: string } | { reason: string }}
 */
const normalizePhone = (raw) => {
  if (raw === null || raw === undefined) return { reason: 'empty' };
  const text = String(raw).trim();
  if (!text) return { reason: 'empty' };
  if (SCIENTIFIC.test(text.replace(/,/g, ''))) return { reason: 'scientific_notation' };

  let value = text.replace(SEPARATORS, '');
  let international = false;
  if (value.startsWith('+')) {
    international = true;
    value = value.slice(1);
  } else if (value.startsWith('00')) {
    international = true;
    value = value.slice(2);
  }
  if (!value) return { reason: 'empty' };
  if (!/^\d+$/.test(value)) return { reason: 'invalid' };

  if (international) {
    if (value.startsWith('91')) return indianMobile(value.slice(2));
    if (value.length < 8) return { reason: 'too_short' };
    if (value.length > 15) return { reason: 'invalid' };
    return { phone: value };
  }

  if (value.length === 11 && value.startsWith('0')) return indianMobile(value.slice(1));
  if (value.length === 12 && value.startsWith('91')) return indianMobile(value.slice(2));
  if (value.length <= 10) return indianMobile(value);
  return { reason: 'invalid' };
};

const PHONE_REASONS = ['empty', 'scientific_notation', 'too_short', 'landline', 'not_mobile', 'invalid'];

module.exports = { normalizePhone, PHONE_REASONS };
