// Customer groups (contact_groups / contact_group_members,
// 20261004120000_contact_import_groups.sql): owner CRUD + membership for
// contactGroup.controller.js, and the group names shown on the Customers
// list. Imports add members through the import_contacts RPC
// (contactImport.service.js); broadcasts read members in
// broadcastAudience.service.js.

const supabase = require('../config/supabase');

const NAME_MAX_LENGTH = 60;
const MAX_MEMBERS_PER_CALL = 500;
// Ids per `in (...)` filter. The URL has a hard ceiling — measured on the
// hosted project 2026-10-07: 350 UUIDs work, 400 fail ("fetch failed") — so
// this stays well under it (200 ≈ 7.5 KB). A request may carry up to
// MAX_MEMBERS_PER_CALL ids, so its lookups go out in chunks of this size.
const ID_CHUNK = 200;
const PAGE = 1000;    // PostgREST max_rows on the hosted project
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (value) => typeof value === 'string' && UUID_PATTERN.test(value);

/** Validated { name } or { status, error }. */
const validateGroupName = (input) => {
  if (typeof input !== 'string' || !input.trim()) return { status: 400, error: 'Group name is required' };
  const name = input.trim().replace(/\s+/g, ' ');
  if (name.length > NAME_MAX_LENGTH) return { status: 400, error: `Group name must be at most ${NAME_MAX_LENGTH} characters` };
  return { name };
};

/** Validated, de-duplicated customer ids or { status, error }. */
const validateCustomerIds = (input) => {
  if (!Array.isArray(input) || input.length === 0) return { status: 400, error: 'customerIds must be a non-empty array' };
  const ids = [...new Set(input)];
  if (!ids.every(isUuid)) return { status: 400, error: 'customerIds must be customer ids' };
  if (ids.length > MAX_MEMBERS_PER_CALL) return { status: 400, error: `At most ${MAX_MEMBERS_PER_CALL} customers per request` };
  return { ids };
};

const shapeGroup = (row) => ({
  id: row.id,
  name: row.name,
  memberCount: Array.isArray(row.contact_group_members) ? Number(row.contact_group_members[0]?.count || 0) : 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/** The business's group with this id (raw row) or null. */
const findGroup = async (businessId, groupId) => {
  if (!isUuid(groupId)) return null;
  const { data, error } = await supabase
    .from('contact_groups').select('*').eq('id', groupId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

const getWithCount = async (businessId, groupId) => {
  const { data, error } = await supabase
    .from('contact_groups').select('id, name, created_at, updated_at, contact_group_members(count)')
    .eq('id', groupId).eq('business_id', businessId).single();
  if (error) throw error;
  return shapeGroup(data);
};

/** GET / — every group, A→Z, with member counts. */
const list = async (businessId) => {
  const { data, error } = await supabase
    .from('contact_groups').select('id, name, created_at, updated_at, contact_group_members(count)')
    .eq('business_id', businessId).order('name', { ascending: true });
  if (error) throw error;
  return { groups: (data || []).map(shapeGroup) };
};

/** POST / — Body { name }. Names are unique per business (case-insensitive). */
const create = async (businessId, userId, body = {}) => {
  const nameCheck = validateGroupName(body.name);
  if (nameCheck.error) return nameCheck;
  const { data, error } = await supabase.from('contact_groups').insert({
    business_id: businessId,
    name: nameCheck.name,
    created_by: userId || null
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return { status: 409, error: 'A group with this name already exists' };
    throw error;
  }
  return { group: await getWithCount(businessId, data.id) };
};

/** PUT /:id — Body { name }. */
const rename = async (businessId, groupId, body = {}) => {
  if (!(await findGroup(businessId, groupId))) return { status: 404, error: 'Group not found' };
  const nameCheck = validateGroupName(body.name);
  if (nameCheck.error) return nameCheck;
  const { error } = await supabase
    .from('contact_groups').update({ name: nameCheck.name }).eq('id', groupId).eq('business_id', businessId);
  if (error) {
    if (error.code === '23505') return { status: 409, error: 'A group with this name already exists' };
    throw error;
  }
  return { group: await getWithCount(businessId, groupId) };
};

/**
 * DELETE /:id — the group and its memberships (customers stay). A draft
 * broadcast that picked this group simply reaches fewer people.
 */
const remove = async (businessId, groupId) => {
  if (!(await findGroup(businessId, groupId))) return { status: 404, error: 'Group not found' };
  const { error } = await supabase.from('contact_groups').delete().eq('id', groupId).eq('business_id', businessId);
  if (error) throw error;
  return { deleted: true };
};

/** The subset of these ids that are customers of this business. */
const businessCustomerIds = async (businessId, ids) => {
  const found = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('customers').select('id').eq('business_id', businessId).in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    found.push(...(data || []).map(r => r.id));
  }
  return found;
};

/** POST /:id/members — Body { customerIds }. Already-members are skipped. */
const addMembers = async (businessId, groupId, body = {}) => {
  if (!(await findGroup(businessId, groupId))) return { status: 404, error: 'Group not found' };
  const check = validateCustomerIds(body.customerIds);
  if (check.error) return check;
  const ids = await businessCustomerIds(businessId, check.ids);
  if (ids.length !== check.ids.length) return { status: 404, error: 'One or more customers were not found' };
  const { data, error } = await supabase.from('contact_group_members')
    .upsert(ids.map(customerId => ({ group_id: groupId, customer_id: customerId })), { onConflict: 'group_id,customer_id', ignoreDuplicates: true })
    .select('customer_id');
  if (error) throw error;
  return { added: (data || []).length, group: await getWithCount(businessId, groupId) };
};

/** POST /:id/members/remove — Body { customerIds }. */
const removeMembers = async (businessId, groupId, body = {}) => {
  if (!(await findGroup(businessId, groupId))) return { status: 404, error: 'Group not found' };
  const check = validateCustomerIds(body.customerIds);
  if (check.error) return check;
  // One delete per chunk of ids (the id list is in the URL). Each chunk is
  // idempotent, so a failure part-way can simply be retried.
  let removed = 0;
  for (let i = 0; i < check.ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase.from('contact_group_members')
      .delete().eq('group_id', groupId).in('customer_id', check.ids.slice(i, i + ID_CHUNK)).select('customer_id');
    if (error) throw error;
    removed += (data || []).length;
  }
  return { removed, group: await getWithCount(businessId, groupId) };
};

/**
 * customer id → [{ id, name }] (A→Z) for these customers, for the Customers
 * list / detail. Customers in no group get no entry.
 */
const groupsByCustomer = async (businessId, customerIds) => {
  const result = new Map();
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (ids.length === 0) return result;

  const { data: groups, error: groupsErr } = await supabase
    .from('contact_groups').select('id, name').eq('business_id', businessId);
  if (groupsErr) throw groupsErr;
  if (!groups || groups.length === 0) return result;
  const groupById = new Map(groups.map(g => [g.id, { id: g.id, name: g.name }]));

  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('contact_group_members').select('group_id, customer_id').in('customer_id', chunk)
        .order('customer_id', { ascending: true }).order('group_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      for (const row of data || []) {
        const group = groupById.get(row.group_id);
        if (!group) continue;
        if (!result.has(row.customer_id)) result.set(row.customer_id, []);
        result.get(row.customer_id).push(group);
      }
      if (!data || data.length < PAGE) break;
    }
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return result;
};

module.exports = {
  NAME_MAX_LENGTH,
  isUuid,
  validateGroupName,
  findGroup,
  list,
  create,
  rename,
  remove,
  addMembers,
  removeMembers,
  groupsByCustomer
};
