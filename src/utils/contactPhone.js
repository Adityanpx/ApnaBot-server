// A phone number typed by a person (signup "call me on", Super Admin support number) →
// digits only with the country code, no '+' (the form wa.me links and WhatsApp ids use).
//
// A 10-digit number is Indian and gets 91 in front; 11-15 digits are taken as already carrying a
// country code. Spaces, dashes, dots and brackets, and a leading '+', are dropped. Unlike
// utils/phone.js (contact-list import, which judges mobile vs landline) this only checks the shape.
//
// Reason codes for a rejected value:
//   empty         nothing given
//   invalid_chars anything other than digits and the separators above
//   bad_length    fewer than 10 or more than 15 digits

/** @returns {{ phone: string } | { reason: 'empty'|'invalid_chars'|'bad_length' }} */
const normalizeContactPhone = (raw) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { reason: 'empty' };
  const text = String(raw).trim();
  if (!text) return { reason: 'empty' };
  if (!/^\+?[\d\s\-().]+$/.test(text)) return { reason: 'invalid_chars' };
  const digits = text.replace(/\D/g, '');
  if (digits.length === 10) return { phone: `91${digits}` };
  if (digits.length >= 11 && digits.length <= 15) return { phone: digits };
  return { reason: 'bad_length' };
};

module.exports = { normalizeContactPhone };
