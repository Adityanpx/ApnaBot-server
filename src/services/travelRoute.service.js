// The owner's route rate card (/api/travel/routes): a route (travel_routes: display names, region,
// toll override) with its prices (route_fares: one row per trip type + vehicle - the same rows the
// booking engine reads). Every function takes the businessId from the logged-in user.
//
// route_fares rows saved through the older /api/route-fares endpoint have route_id null; they are
// matched to their route by (from_city, to_city), and a pair with fares but no travel_routes row is
// listed as `unlisted: true` (id null) until it is saved here once.
//
// Errors the owner can fix are thrown with .statusCode (errorHandler maps it).
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { validateRouteInput } = require('../utils/travelQuote');

const fail = (statusCode, message, errors = null) => Object.assign(new Error(message), { statusCode, errors });
const pairKey = (from, to) => `${from}>${to}`;
const titleCase = (key) => key.replace(/\b\w/g, c => c.toUpperCase());

const FARE_SELECT = 'id, from_city, to_city, trip_type, vehicle_id, fare, is_active, route_id, vehicle:vehicles(id, custom_name, catalog:vehicle_type_catalog(name, seats))';

const fareToApi = (row) => ({
  id: row.id,
  tripType: row.trip_type,
  vehicleId: row.vehicle_id,
  vehicleName: row.vehicle ? (row.vehicle.custom_name || row.vehicle.catalog?.name || null) : null,
  seats: row.vehicle?.catalog?.seats ?? null,
  fare: Number(row.fare),
  isActive: row.is_active
});

const routeToApi = (route, fareRows) => ({
  ...toCamelCase(route),
  fares: fareRows.map(fareToApi)
});

const loadFares = async (businessId) => {
  const { data, error } = await supabase.from('route_fares').select(FARE_SELECT).eq('business_id', businessId);
  if (error) throw error;
  return data || [];
};

const groupFares = (fareRows) => {
  const byPair = new Map();
  for (const row of fareRows) {
    const key = pairKey(row.from_city, row.to_city);
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(row);
  }
  return byPair;
};

/** Every route with its fares, in owner order (sort_order, then from, then to). */
const listRoutes = async (businessId) => {
  const { data: routes, error } = await supabase.from('travel_routes').select('*').eq('business_id', businessId)
    .order('sort_order', { ascending: true }).order('from_city', { ascending: true }).order('to_city', { ascending: true });
  if (error) throw error;
  const byPair = groupFares(await loadFares(businessId));

  const result = (routes || []).map(route => {
    const key = pairKey(route.from_city, route.to_city);
    const rows = byPair.get(key) || [];
    byPair.delete(key);
    return routeToApi(route, rows);
  });
  for (const [key, rows] of byPair) {
    const [from, to] = key.split('>');
    result.push({
      id: null, unlisted: true, fromCity: from, toCity: to, fromLabel: titleCase(from), toLabel: titleCase(to),
      region: null, tollIncluded: null, sortOrder: 0, isActive: rows.some(r => r.is_active), fares: rows.map(fareToApi)
    });
  }
  return result;
};

const loadRoute = async (businessId, id) => {
  const { data, error } = await supabase.from('travel_routes').select('*').eq('id', id).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

const routeWithFares = async (route) => {
  const { data, error } = await supabase.from('route_fares').select(FARE_SELECT)
    .eq('business_id', route.business_id).eq('from_city', route.from_city).eq('to_city', route.to_city);
  if (error) throw error;
  return routeToApi(route, data || []);
};

const assertVehiclesBelong = async (businessId, fares) => {
  const ids = [...new Set(fares.filter(f => !f.remove).map(f => f.vehicleId))];
  if (ids.length === 0) return;
  const { data, error } = await supabase.from('vehicles').select('id').eq('business_id', businessId).in('id', ids);
  if (error) throw error;
  const found = new Set((data || []).map(v => v.id));
  const missing = ids.filter(id => !found.has(id));
  if (missing.length > 0) throw fail(404, 'Vehicle not found', { vehicleIds: missing });
};

/** Upserts the listed fares (or deletes the ones marked remove) for a route. */
const applyFares = async (route, fares) => {
  const toSave = fares.filter(f => !f.remove).map(f => ({
    business_id: route.business_id,
    from_city: route.from_city,
    to_city: route.to_city,
    trip_type: f.tripType,
    vehicle_id: f.vehicleId,
    fare: f.fare,
    route_id: route.id,
    is_active: route.is_active
  }));
  if (toSave.length > 0) {
    const { error } = await supabase.from('route_fares')
      .upsert(toSave, { onConflict: 'business_id,from_city,to_city,trip_type,vehicle_id' });
    if (error) throw error;
  }
  for (const f of fares.filter(x => x.remove)) {
    const { error } = await supabase.from('route_fares').delete()
      .eq('business_id', route.business_id).eq('from_city', route.from_city).eq('to_city', route.to_city)
      .eq('trip_type', f.tripType).eq('vehicle_id', f.vehicleId);
    if (error) throw error;
  }
};

/**
 * Creates a route, or - when the owner already has this from/to pair - updates it (the same
 * upsert behaviour as POST /api/route-fares). Only the fields sent are written.
 */
const createRoute = async (businessId, body) => {
  const { errors, value } = validateRouteInput(body);
  if (errors.length > 0) throw fail(400, errors[0], errors);
  const { fares = [], ...columns } = value;
  await assertVehiclesBelong(businessId, fares);

  const { data: route, error } = await supabase.from('travel_routes')
    .upsert({ business_id: businessId, ...columns }, { onConflict: 'business_id,from_city,to_city' })
    .select().single();
  if (error) throw error;
  await applyFares(route, fares);
  return routeWithFares(route);
};

/**
 * Edits a route by id. The from/to cities can't change (the fares are keyed on them): delete and
 * re-create to rename. Turning isActive off or on carries to all its fares.
 */
const updateRoute = async (businessId, id, body) => {
  const existing = await loadRoute(businessId, id);
  if (!existing) throw fail(404, 'Route not found');
  const { errors, value } = validateRouteInput(body, { isEdit: true });
  if (errors.length > 0) throw fail(400, errors[0], errors);
  if ((value.from_city !== undefined && value.from_city !== existing.from_city) ||
      (value.to_city !== undefined && value.to_city !== existing.to_city)) {
    throw fail(400, 'The cities of a route cannot be changed. Delete it and add a new route.');
  }
  const { fares = [], ...columns } = value;
  delete columns.from_city;
  delete columns.to_city;
  await assertVehiclesBelong(businessId, fares);

  const wasActive = existing.is_active;
  let route = existing;
  if (Object.keys(columns).length > 0) {
    const { data, error } = await supabase.from('travel_routes').update(columns).eq('id', id).select().single();
    if (error) throw error;
    route = data;
  }
  if (columns.is_active !== undefined && columns.is_active !== wasActive) {
    const { error } = await supabase.from('route_fares').update({ is_active: columns.is_active })
      .eq('business_id', businessId).eq('from_city', route.from_city).eq('to_city', route.to_city);
    if (error) throw error;
  }
  await applyFares(route, fares);
  return routeWithFares(route);
};

/** Deletes a route and all its fares. */
const deleteRoute = async (businessId, id) => {
  const existing = await loadRoute(businessId, id);
  if (!existing) throw fail(404, 'Route not found');
  const { error: fareErr } = await supabase.from('route_fares').delete()
    .eq('business_id', businessId).eq('from_city', existing.from_city).eq('to_city', existing.to_city);
  if (fareErr) throw fareErr;
  const { error } = await supabase.from('travel_routes').delete().eq('id', id);
  if (error) throw error;
};

module.exports = { listRoutes, createRoute, updateRoute, deleteRoute };
