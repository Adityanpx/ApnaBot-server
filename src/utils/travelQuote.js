// Travel quotes: input validation for the rate card (routes, fares, extras) and the
// pure price / advance maths the quote step uses. No DB access.
const { LIMITS } = require('./flowSpec');
const { isValidLanguageCode } = require('./languageCatalog');

const TRIP_TYPES = ['oneway', 'round_trip'];
const CITY_MAX = 60;
const LABEL_MAX = LIMITS.LIST_ROW_TITLE; // route names are shown as WhatsApp list rows
const ONE_WAY_KM_MAX = 5000;
const ALLOWANCE_BASES = ['day', 'night'];

/** City key as route_fares stores it: trimmed, lowercased, inner spaces collapsed. */
const normalizeCity = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The route_fares columns an explicit on / off writes: false = switched off on purpose (off_reason
 * 'manual', which a route switched off and on again leaves alone), true = switched back on (marker
 * cleared). Nothing when isActive is not given. Shared by Rates -> Routes and Fleet -> Route Fares.
 */
const fareSwitchColumns = (isActive) => {
  if (isActive === undefined) return {};
  return isActive ? { is_active: true, off_reason: null } : { is_active: false, off_reason: 'manual' };
};

// The trip types route_fares accepts (its CHECK constraint). Rates -> Routes edits oneway / round_trip
// (TRIP_TYPES); Fleet -> Route Fares may also hold outstation / local rows.
const ROUTE_FARE_TRIP_TYPES = ['oneway', 'round_trip', 'outstation', 'local'];

/**
 * Checks a body for POST / PUT /api/route-fares (Fleet -> Route Fares) with the same rules as a fare in
 * Rates -> Routes: city keys normalised the same way, from and to different, a fare that is a number
 * above 0, isActive a boolean. `isEdit` only checks (and returns) the keys that were sent.
 * @returns {{ errors:string[], value:{ fromCity?, toCity?, tripType?, vehicleId?, fare?, isActive? } }}
 */
const validateRouteFareInput = (body, { isEdit = false } = {}) => {
  const errors = [];
  const value = {};
  const input = body && typeof body === 'object' ? body : {};
  for (const [key, label] of [['fromCity', 'fromCity'], ['toCity', 'toCity']]) {
    if (isEdit && input[key] === undefined) continue;
    const city = normalizeCity(input[key]);
    if (!city || city.length > CITY_MAX) errors.push(`${label} is required (max ${CITY_MAX} characters)`);
    value[key] = city;
  }
  if (value.fromCity && value.toCity && value.fromCity === value.toCity) errors.push('fromCity and toCity must be different');
  if (!isEdit || input.tripType !== undefined) {
    const tripType = input.tripType === undefined ? 'oneway' : input.tripType;
    if (!ROUTE_FARE_TRIP_TYPES.includes(tripType)) errors.push(`tripType must be one of: ${ROUTE_FARE_TRIP_TYPES.join(', ')}`);
    value.tripType = tripType;
  }
  if (!isEdit || input.vehicleId !== undefined) {
    if (typeof input.vehicleId !== 'string' || !input.vehicleId) errors.push('vehicleId is required');
    value.vehicleId = input.vehicleId;
  }
  if (!isEdit || input.fare !== undefined) {
    if (!(isNumber(input.fare) && input.fare > 0)) errors.push('fare must be a number above 0');
    value.fare = input.fare;
  }
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== 'boolean') errors.push('isActive must be true or false');
    else value.isActive = input.isActive;
  }
  return { errors, value };
};
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
  // Per-language texts of the three above ({ "hi": "..." }); null or {} clears them. English is the label itself.
  for (const [key, column] of [['fromLabelTranslations', 'from_label_translations'], ['toLabelTranslations', 'to_label_translations'], ['regionTranslations', 'region_translations']]) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (v === null) { value[column] = null; continue; }
    const entries = v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v) : null;
    const bad = !entries || entries.some(([lang, text]) => lang === 'en' || !isValidLanguageCode(lang) || (text !== null && !(typeof text === 'string' && text.trim().length <= LABEL_MAX)));
    if (bad) { errors.push(`${key} must be { language code: text of at most ${LABEL_MAX} characters }`); continue; }
    const kept = Object.fromEntries(entries.filter(([, text]) => typeof text === 'string' && text.trim() !== '').map(([lang, text]) => [lang, text.trim()]));
    value[column] = Object.keys(kept).length > 0 ? kept : null;
  }
  if (input.tollIncluded !== undefined) {
    if (input.tollIncluded !== null && typeof input.tollIncluded !== 'boolean') errors.push('tollIncluded must be true, false or null');
    else value.toll_included = input.tollIncluded;
  }
  if (input.oneWayDistanceKm !== undefined) {
    const km = input.oneWayDistanceKm === '' ? null : input.oneWayDistanceKm;
    if (km !== null && !(isNumber(km) && km > 0 && km <= ONE_WAY_KM_MAX)) {
      errors.push(`oneWayDistanceKm must be a number above 0 (at most ${ONE_WAY_KM_MAX}), or empty`);
    } else {
      value.one_way_distance_km = km;
    }
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
        if (f.isActive !== undefined && typeof f.isActive !== 'boolean') errors.push(`${where}.isActive must be true or false`);
        const key = `${f.tripType}|${f.vehicleId}`;
        if (seen.has(key)) errors.push(`${where} repeats a trip type + vehicle`);
        seen.add(key);
        value.fares.push({ tripType: f.tripType, vehicleId: f.vehicleId, fare: f.fare, remove, ...(f.isActive === undefined || remove ? {} : { isActive: f.isActive }) });
      });
    }
  }
  return { errors, value };
};

const SETTING_FIELDS = {
  nightCharge: { column: 'night_charge', check: (v) => isNumber(v) && v >= 0, message: 'a number, 0 or more' },
  allowanceBasis: { column: 'allowance_basis', check: (v) => ALLOWANCE_BASES.includes(v), message: `one of: ${ALLOWANCE_BASES.join(', ')}` },
  minimumCharge: { column: 'minimum_charge', check: (v) => isNumber(v) && v >= 0, message: 'a number, 0 or more' },
  tollIncluded: { column: 'toll_included', check: (v) => typeof v === 'boolean', message: 'true or false' },
  nightStartMinute: { column: 'night_start_minute', check: (v) => Number.isInteger(v) && v >= 0 && v <= 1439, message: 'a minute of the day, 0-1439' },
  nightEndMinute: { column: 'night_end_minute', check: (v) => Number.isInteger(v) && v >= 0 && v <= 1439, message: 'a minute of the day, 0-1439' },
  validHours: { column: 'valid_hours', check: (v) => Number.isInteger(v) && v >= 1 && v <= 168, message: 'whole hours, 1-168' },
  reminderAfterHours: { column: 'reminder_after_hours', check: (v) => Number.isInteger(v) && v >= 0 && v <= 167, message: 'whole hours, 0-167 (0 = no reminder)' }
};

const DEFAULT_SETTINGS = {
  nightCharge: 0, nightStartMinute: 1320, nightEndMinute: 360, allowanceBasis: 'day',
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

/** A positive finite number (a numeric column may arrive as a string), else null. */
const positiveNumber = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Checks the Round Trip pricing fields of a vehicle body (create or edit). Returns { errors, value }
 * with only the keys sent, as snake_case columns; null clears a field.
 *   minKmPerDay           above 0 (null = not set: Round Trip on this vehicle is "owner confirms")
 *   driverAllowancePerDay 0 or more (null = 0)
 */
const validateVehicleFareInput = (body) => {
  const errors = [];
  const value = {};
  const input = body && typeof body === 'object' ? body : {};
  for (const [key, column, ok, message] of [
    ['minKmPerDay', 'min_km_per_day', (v) => v > 0, 'a number above 0, or empty'],
    ['driverAllowancePerDay', 'driver_allowance_per_day', (v) => v >= 0, 'a number, 0 or more, or empty']
  ]) {
    if (input[key] === undefined) continue;
    const v = input[key] === '' ? null : input[key];
    if (v !== null && !(isNumber(v) && ok(v))) errors.push(`${key} must be ${message}`);
    else value[column] = v;
  }
  return { errors, value };
};

// Round Trip money maths runs in integers so a half-rupee never depends on float noise:
// distances in tenths of a km, rates in paise per km (distance x rate is then tenth-paise).
const toTenths = (km) => Math.round(km * 10);
const toPaise = (rupees) => Math.round(rupees * 100);
const divideHalfUp = (n, by) => Math.floor((n + by / 2) / by);

/**
 * The Round Trip price from the vehicle's rate, with no fixed package price:
 *   billed_km        = max(2 x one-way distance, days x minimum km per day)
 *   km charge        = billed_km x the vehicle's per-km rate
 *   driver allowance = allowance x days ('day' basis) or x nights = days - 1 ('night' basis; a
 *                      same-day return has 0 nights). A missing allowance counts as 0.
 *   total            = km charge + allowance, to the nearest rupee (half up)
 * Toll and parking are never added. Nothing is guessed: a missing day count, distance, minimum km or
 * rate (null, 0 or negative) returns { ok:false, reason } - the owner then confirms the price.
 * kmCharge is total - allowance, so the lines shown always add up to the total.
 * @returns {{ ok:true, days:number, oneWayKm:number, minKmPerDay:number, billedKm:number, ratePerKm:number,
 *   kmCharge:number, allowance:{ perUnit:number, units:number, basis:string, amount:number }, total:number }
 *   | { ok:false, reason:'missing_days'|'missing_distance'|'missing_min_km'|'missing_rate' }}
 */
const computeRoundTripFare = ({ oneWayKm, days, minKmPerDay, ratePerKm, allowancePerUnit = null, allowanceBasis = 'day' }) => {
  if (!(Number.isInteger(days) && days >= 1)) return { ok: false, reason: 'missing_days' };
  const distance = positiveNumber(oneWayKm);
  if (distance === null) return { ok: false, reason: 'missing_distance' };
  const minKm = positiveNumber(minKmPerDay);
  if (minKm === null) return { ok: false, reason: 'missing_min_km' };
  const rate = positiveNumber(ratePerKm);
  if (rate === null) return { ok: false, reason: 'missing_rate' };

  const basis = allowanceBasis === 'night' ? 'night' : 'day';
  const units = basis === 'night' ? days - 1 : days;
  const perUnit = Number.isFinite(Number(allowancePerUnit)) && Number(allowancePerUnit) > 0 ? Number(allowancePerUnit) : 0;

  const billedTenths = Math.max(2 * toTenths(distance), days * toTenths(minKm));
  const kmChargeTenthPaise = billedTenths * toPaise(rate);
  const allowanceTenthPaise = toPaise(perUnit) * units * 10;
  const total = divideHalfUp(kmChargeTenthPaise + allowanceTenthPaise, 1000);
  const allowanceAmount = divideHalfUp(allowanceTenthPaise, 1000);
  return {
    ok: true,
    days,
    oneWayKm: distance,
    minKmPerDay: minKm,
    billedKm: billedTenths / 10,
    ratePerKm: rate,
    kmCharge: total - allowanceAmount,
    allowance: { perUnit, units, basis, amount: allowanceAmount },
    total
  };
};

/**
 * The one place a vehicle on a route is priced - the carousel card, the tap and the quote all call it
 * with fresh rows, so they cannot disagree.
 *   one way     the route fare row, as entered                            method 'fixed'
 *   round trip  a fixed Round Trip fare for the vehicle (a package price), as entered, for any
 *               number of days                                            method 'package'
 *               else computeRoundTripFare from the route distance and the vehicle's rate
 *                                                                         method 'formula'
 *               else { ok:false, reason } - the owner confirms the price
 * @param {{ tripType:'oneway'|'round_trip', days?:number|null, fare:number|null, oneWayKm?:number|null,
 *   vehicle?:{ perKmRate, minKmPerDay, driverAllowancePerDay }, allowanceBasis?:string }} args
 *   fare = the route_fares fare for this trip type + vehicle (null/absent when the row doesn't exist)
 */
const priceVehicleTrip = ({ tripType, days = null, fare = null, oneWayKm = null, vehicle = {}, allowanceBasis = 'day' }) => {
  const fixed = positiveNumber(fare);
  if (tripType !== 'round_trip') {
    return fixed === null ? { ok: false, reason: 'missing_fare' } : { ok: true, method: 'fixed', baseFare: fixed, total: fixed };
  }
  if (fixed !== null) return { ok: true, method: 'package', baseFare: fixed, total: fixed };
  const computed = computeRoundTripFare({
    oneWayKm, days, minKmPerDay: vehicle.minKmPerDay, ratePerKm: vehicle.perKmRate,
    allowancePerUnit: vehicle.driverAllowancePerDay, allowanceBasis
  });
  return computed.ok ? { ...computed, method: 'formula', baseFare: computed.kmCharge } : computed;
};

const numberOrNull = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The vehicles a route can offer for a Round Trip, from its route_fares rows joined with their vehicle
 * (snake_case, as supabase returns them): the active vehicles with an active One Way or Round Trip fare
 * on the route. `fare` is the vehicle's fixed Round Trip fare (null when it has none). Used by the route
 * list's readiness, the quotable-route filter and the carousel, so all three see the same vehicles.
 * @returns {{ vehicleId:string, fare:number|null, row:Object, vehicle:{ perKmRate, minKmPerDay, driverAllowancePerDay } }[]}
 */
const roundTripCandidates = (fareRows) => {
  const byVehicle = new Map();
  for (const row of fareRows || []) {
    if (!row.is_active || !row.vehicle || row.vehicle.is_active === false) continue;
    if (row.trip_type !== 'oneway' && row.trip_type !== 'round_trip') continue;
    if (!byVehicle.has(row.vehicle_id)) {
      byVehicle.set(row.vehicle_id, {
        vehicleId: row.vehicle_id,
        fare: null,
        row,
        vehicle: {
          perKmRate: numberOrNull(row.vehicle.per_km_rate),
          minKmPerDay: numberOrNull(row.vehicle.min_km_per_day),
          driverAllowancePerDay: numberOrNull(row.vehicle.driver_allowance_per_day)
        }
      });
    }
    if (row.trip_type === 'round_trip') {
      const entry = byVehicle.get(row.vehicle_id);
      entry.fare = numberOrNull(row.fare);
      entry.row = row; // the Round Trip row is the one a package quote is priced from
    }
  }
  return [...byVehicle.values()];
};

/**
 * Whether Round Trip can be priced for a route at all (any day count), and if not, what to add first.
 * A route is offered for Round Trip only when at least one of its vehicles can be priced.
 * @param {{ oneWayKm:number|null, vehicles:{ fare:number|null, vehicle:Object }[] }} args  the route's
 *   candidate vehicles with the Round Trip fare row's fare (null when it has none)
 * @returns {{ ready:boolean, reason:null|'no_vehicle'|'add_distance'|'add_min_km'|'add_rate' }}
 */
const roundTripReadiness = ({ oneWayKm, vehicles }) => {
  if (!vehicles || vehicles.length === 0) return { ready: false, reason: 'no_vehicle' };
  if (vehicles.some(v => priceVehicleTrip({ tripType: 'round_trip', days: 1, fare: v.fare, oneWayKm, vehicle: v.vehicle }).ok)) {
    return { ready: true, reason: null };
  }
  if (positiveNumber(oneWayKm) === null) return { ready: false, reason: 'add_distance' };
  if (!vehicles.some(v => positiveNumber(v.vehicle?.minKmPerDay) !== null)) return { ready: false, reason: 'add_min_km' };
  return { ready: false, reason: 'add_rate' };
};

/**
 * Prices a quote from the route fare plus the owner's extras.
 *   base          the route_fares fare for the chosen route + trip type + vehicle - or, for a Round
 *                 Trip priced by formula (`roundTrip` = computeRoundTripFare's result), the km charge
 *   driver allowance  formula Round Trips only, from the vehicle (the old business-wide
 *                 allowance per day is retired); a fixed package price carries none
 *   night charge  added once when the pickup minute is inside the night window
 *   minimum       raises the total to the minimum charge when below it
 * Toll is reported, never added. One Way is rounded to the nearest 10 like the other fare tiers; a
 * Round Trip (package or formula) is used as entered, to the nearest rupee.
 * @returns {{ baseFare:number, extras:{key:string,label:string,amount:number}[], total:number, tollIncluded:boolean }}
 */
const computeQuote = ({ baseFare, tripType, roundTrip = null, pickupMinute = null, tollOverride = null, settings = DEFAULT_SETTINGS }) => {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const extras = [];
  const base = roundTrip ? roundTrip.kmCharge : baseFare;
  if (roundTrip && roundTrip.allowance.amount > 0) {
    const { units, basis, perUnit } = roundTrip.allowance;
    extras.push({
      key: 'driver_allowance',
      label: `Driver allowance (${units} ${basis}${units === 1 ? '' : 's'} x ${perUnit})`,
      amount: roundTrip.allowance.amount
    });
  }
  if (s.nightCharge > 0 && isNightMinute(pickupMinute, s.nightStartMinute, s.nightEndMinute)) {
    extras.push({ key: 'night_charge', label: 'Night charge', amount: s.nightCharge });
  }
  const sum = base + extras.reduce((acc, e) => acc + e.amount, 0);
  const subtotal = tripType === 'round_trip' ? Math.round(sum) : roundToTen(sum);
  let total = subtotal;
  if (s.minimumCharge > 0 && subtotal < s.minimumCharge) {
    extras.push({ key: 'minimum_charge', label: 'Minimum charge', amount: s.minimumCharge - subtotal });
    total = s.minimumCharge;
  }
  return {
    baseFare: base,
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

/**
 * Seats a vehicle needs for a passenger answer: the band's upper end ("1-4" -> 4, "5-6" -> 6,
 * "7+" -> 7) or a plain number. null = unknown answer, no filtering.
 */
const minSeatsFor = (passengers) => {
  const text = String(passengers ?? '').trim();
  const band = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (band) return Math.max(Number(band[1]), Number(band[2]));
  const open = text.match(/^(\d{1,2})\s*\+$/);
  if (open) return Number(open[1]);
  const plain = text.match(/^\d{1,2}$/);
  return plain ? Number(plain[0]) : null;
};

/**
 * Keeps the vehicle options that seat the party and numbers them again (the index is part of the
 * tap id). A vehicle whose seat count is unknown is kept: it can't be shown to misfit.
 */
const filterOptionsBySeats = (options, passengers) => {
  const needed = minSeatsFor(passengers);
  if (needed === null) return options;
  return options
    .filter((opt) => opt.seats === null || opt.seats === undefined || opt.seats >= needed)
    .map((opt, index) => ({ ...opt, index }));
};

module.exports = {
  minSeatsFor, filterOptionsBySeats,
  TRIP_TYPES, ROUTE_FARE_TRIP_TYPES, fareSwitchColumns, validateRouteFareInput, DEFAULT_SETTINGS, normalizeCity, validateRouteInput, validateSettingsInput, validateVehicleFareInput,
  isNightMinute, computeRoundTripFare, priceVehicleTrip, roundTripCandidates, roundTripReadiness, computeQuote, computeAdvance
};
