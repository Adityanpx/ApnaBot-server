// An owner's contact phone (users.phone) → '+91' + 10 digits starting 6-9, the only shape the
// users_phone_format_check constraint accepts. Accepts "9876543210", "+919876543210",
// "09876543210" (and "91…", spaces/dashes) by delegating to utils/phone.js, then rejects anything
// that is not an Indian mobile (a foreign number or a landline passes no CHECK).
//
// Reason codes: empty | invalid (the message table is shared by register and PATCH /me).
const { normalizePhone } = require('./phone');

const OWNER_PHONE_MESSAGES = {
  required: 'Phone number is required',
  invalid: 'Enter a valid 10-digit Indian mobile number'
};

/** @returns {{ phone: string } | { reason: 'empty'|'invalid' }} */
const normalizeOwnerPhone = (raw) => {
  if (raw === null || raw === undefined) return { reason: 'empty' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { reason: 'invalid' };
  const result = normalizePhone(raw);
  if (result.reason === 'empty') return { reason: 'empty' };
  if (result.phone && /^91[6-9]\d{9}$/.test(result.phone)) return { phone: `+${result.phone}` };
  return { reason: 'invalid' };
};

module.exports = { normalizeOwnerPhone, OWNER_PHONE_MESSAGES };
