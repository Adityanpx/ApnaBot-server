// Travel quotes: input validation for the rate card (routes, fares, extras) and the
// pure price / advance maths the quote step uses. No DB access.
const { LIMITS } = require('./flowSpec');

const TRIP_TYPES = ['oneway', 'round_trip'];
const CITY_MAX = 60;
const LABEL_MAX = LIMITS.LIST_ROW_TITLE; // route names are shown as WhatsApp list rows

/** City key as route_fares stores it: trimmed, lowercased, inner spaces collapsed. */
const normalizeCity = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isOptionalText = (v, max) => v === null || (typeof v === 'string' && v.trim().length <= max);
const textOrNull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Checks a route body (create or edit). Returns { errors: string[], value } where value holds only
 * the keys the caller sent (snake_case columns for travel_routes, plus `fares`), so an edit never
 * nulls a field it didn't mention. `isEdit` skips the required from/to check.
 */
const validateRouteInput = (body, { isEdit = false } = {}) => {
  const errors = [];
  const value = {};
  const input = body && typeof body === 'object' ? body : {};

  if (!isEdit || input.fromCity !== undefined) {
    const from = normalizeCity(input.fromCity);
    if (!from || from.length > CITY_MAX) errors.push(`fromCity is required (max ${CITY_MAX} characters)`);
    value.from_city = from;
  }
  if (!isEdit || input.toCity !== undefined) {
    const to = normalizeCity(input.toCity);
    if (!to || to.length > CITY_MAX) errors.push(`toCity is required (max ${CITY_MAX} characters)`);
    value.to_city = to;
  }
  if (value.from_city && value.to_city && value.from_city === value.to_city) {
    errors.push('fromCity and toCity must be different');
  }

  for (const [key, column] of [['fromLabel', 'from_label'], ['toLabel', 'to_label'], ['region', 'region']]) {
    if (input[key] === undefined) continue;
    const v = input[key] === '' ? null : input[key];
    if (!isOptionalText(v, LABEL_MAX)) errors.push(`${key} must be text of at most ${LABEL_MAX} characters`);
    else value[column] = textOrNull(v);
  }
  if (input.tollIncluded !== undefined) {
    if (input.tollIncluded !== null && typeof input.tollIncluded !== 'boolean') errors.push('tollIncluded must be true, false or null');
    else value.toll_included = input.tollIncluded;
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder)) errors.push('sortOrder must be a whole number');
    else value.sort_order = input.sortOrder;
  }
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') errors.push('isActive must be true or false');
    else value.is_active = input.isActive;
  }

  if (input.fares !== undefined) {
    if (!Array.isArray(input.fares) || input.fares.length > 60) {
      errors.push('fares must be a list of at most 60 entries');
    } else {
      const seen = new Set();
      value.fares = [];
      input.fares.forEach((f, i) => {
        const where = `fares[${i}]`;
        if (!f || typeof f !== 'object') { errors.push(`${where} must be an object`); return; }
        if (!TRIP_TYPES.includes(f.tripType)) errors.push(`${where}.tripType must be one of: ${TRIP_TYPES.join(', ')}`);
        if (typeof f.vehicleId !== 'string' || !f.vehicleId) errors.push(`${where}.vehicleId is required`);
        const remove = f.remove === true;
        if (!remove && !(isNumber(f.fare) && f.fare > 0)) errors.push(`${where}.fare must be a number above 0`);
        const key = `${f.tripType}|${f.vehicleId}`;
        if (seen.has(key)) errors.push(`${where} repeats a trip type + vehicle`);
        seen.add(key);
        value.fares.push({ tripType: f.tripType, vehicleId: f.vehicleId, fare: f.fare, remove });
      });
    }
  }
  return { errors, value };
};

const SETTING_FIELDS = {
  nightCharge: { column: 'night_charge', check: (v) => isNumber(v) && v >= 0, message: 'a number, 0 or more' },
  driverAllowancePerDay: { column: 'driver_allowance_per_day', check: (v) => isNumber(v) && v >= 0, message: 'a number, 0 or more' },
  minimumCharge: { column: 'minimum_charge', check: (v) => isNumber(v) && v >= 0, message: 'a number, 0 or more' },
  tollIncluded: { column: 'toll_included', check: (v) => typeof v === 'boolean', message: 'true or false' },
  nightStartMinute: { column: 'night_start_minute', check: (v) => Number.isInteger(v) && v >= 0 && v <= 1439, message: 'a minute of the day, 0-1439' },
  nightEndMinute: { column: 'night_end_minute', check: (v) => Number.isInteger(v) && v >= 0 && v <= 1439, message: 'a minute of the day, 0-1439' },
  validHours: { column: 'valid_hours', check: (v) => Number.isInteger(v) && v >= 1 && v <= 168, message: 'whole hours, 1-168' },
  reminderAfterHours: { column: 'reminder_after_hours', check: (v) => Number.isInteger(v) && v >= 0 && v <= 167, message: 'whole hours, 0-167 (0 = no reminder)' }
};

const DEFAULT_SETTINGS = {
  nightCharge: 0, nightStartMinute: 1320, nightEndMinute: 360, driverAllowancePerDay: 0,
  tollIncluded: false, minimumCharge: 0, validHours: 24, reminderAfterHours: 3
};

/**
 * Checks a settings body against `current` (the saved or default settings, camelCase) so the
 * cross-field rule (reminder earlier than expiry) holds after the merge. Returns { errors, value }
 * with snake_case columns for the keys sent.
 */
const validateSettingsInput = (body, current = DEFAULT_SETTINGS) => {
  const errors = [];
  const value = {};
  const input = body && typeof body === 'object' ? body : {};
  for (const [key, def] of Object.entries(SETTING_FIELDS)) {
    if (input[key] === undefined) continue;
    if (!def.check(input[key])) errors.push(`${key} must be ${def.message}`);
    else value[def.column] = input[key];
  }
  if (Object.keys(input).length === 0 || (errors.length === 0 && Object.keys(value).length === 0)) {
    errors.push('Nothing to update');
  }
  if (errors.length === 0) {
    const validHours = input.validHours ?? current.validHours;
    const reminder = input.reminderAfterHours ?? current.reminderAfterHours;
    if (reminder >= validHours) errors.push('reminderAfterHours must be less than validHours');
  }
  return { errors, value };
};

/** True when `minute` (0-1439) is inside the night window; the window may wrap midnight. */
const isNightMinute = (minute, startMinute, endMinute) => {
  if (!Number.isInteger(minute) || startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
};

const roundToTen = (n) => Math.round(n / 10) * 10;

/**
 * Prices a quote from the route fare plus the owner's extras.
 *   base          the route_fares fare for the chosen route + trip type + vehicle
 *   night charge  added once when the pickup minute is inside the night window
 *   driver allowance  per day, round trips only (days >= 1)
 *   minimum       raises the total to the minimum charge when below it
 * Toll is reported, never added. The subtotal is rounded to the nearest 10 like the other fare tiers.
 * @returns {{ baseFare:number, extras:{key:string,label:string,amount:number}[], total:number, tollIncluded:boolean }}
 */
const computeQuote = ({ baseFare, tripType, days = null, pickupMinute = null, tollOverride = null, settings = DEFAULT_SETTINGS }) => {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const extras = [];
  if (s.nightCharge > 0 && isNightMinute(pickupMinute, s.nightStartMinute, s.nightEndMinute)) {
    extras.push({ key: 'night_charge', label: 'Night charge', amount: s.nightCharge });
  }
  if (tripType === 'round_trip' && s.driverAllowancePerDay > 0 && Number.isInteger(days) && days >= 1) {
    extras.push({ key: 'driver_allowance', label: `Driver allowance (${days} day${days > 1 ? 's' : ''})`, amount: s.driverAllowancePerDay * days });
  }
  const subtotal = roundToTen(baseFare + extras.reduce((sum, e) => sum + e.amount, 0));
  let total = subtotal;
  if (s.minimumCharge > 0 && subtotal < s.minimumCharge) {
    extras.push({ key: 'minimum_charge', label: 'Minimum charge', amount: s.minimumCharge - subtotal });
    total = s.minimumCharge;
  }
  return {
    baseFare,
    extras,
    total,
    tollIncluded: tollOverride === null || tollOverride === undefined ? !!s.tollIncluded : !!tollOverride
  };
};

/**
 * The advance to ask for, from the business-wide settings (businesses.require_advance_payment /
 * advance_payment_type / advance_payment_value, camelCase as business.service returns them).
 * null = no advance. Percentage keeps paise like createBookingAndConfirmation; a fixed advance is
 * never more than the total.
 */
const computeAdvance = (business, total) => {
  if (!business || !business.requireAdvancePayment) return null;
  const value = Number(business.advancePaymentValue);
  if (!(value > 0) || !(total > 0)) return null;
  if (business.advancePaymentType === 'percentage') return Math.round(total * (value / 100) * 100) / 100;
  if (business.advancePaymentType === 'fixed') return Math.min(value, total);
  return null;
};

module.exports = {
  TRIP_TYPES, DEFAULT_SETTINGS, normalizeCity, validateRouteInput, validateSettingsInput,
  isNightMinute, computeQuote, computeAdvance
};
