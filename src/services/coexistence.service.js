// Webhook handlers for WhatsApp Business app coexistence:
//   smb_message_echoes  - messages the owner sent from the phone
//   history             - chat history sync after onboarding (one-time, chunked)
//   smb_app_state_sync  - phone contacts sync after onboarding (one-time)
//   account_update      - the connection was removed / re-established
//
// None of these ever reach the bot: no flow graph, no auto-reply, no usage or
// billing count (Meta does not charge for app-sent messages), and none of them
// touches customers.last_message_at / total_messages - those drive the 24h
// customer-service window, which only a real inbound customer message may open.
// Payload shapes: utils/coexistencePayload.js.

const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const socketService = require('./socket.service');
const tenantService = require('./tenant.service');
const { toCamelCase } = require('../utils/caseConvert');
const { digits, parseEcho, parseHistoryEntry, parseStateSync, accountUpdateAction } = require('../utils/coexistencePayload');

const COEXISTENCE_FIELDS = new Set(['smb_message_echoes', 'history', 'smb_app_state_sync', 'account_update']);

// Postgres unique_violation: customers (business_id, whatsapp_number) and
// messages (business_id, meta_message_id).
const UNIQUE_VIOLATION = '23505';
const CHUNK = 200;

const chunksOf = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const newCustomerRow = (businessId, number, name) => ({
  business_id: businessId,
  whatsapp_number: number,
  name: name || null,
  first_seen_at: new Date().toISOString(),
  // Never messaged in: no window, no count (see the file header).
  last_message_at: null,
  total_messages: 0
});

/**
 * Find or create one customer without touching last_message_at / total_messages.
 * @returns {Promise<{customer:Object, created:boolean}>} snake_case row
 */
const findOrCreateCustomer = async (businessId, number, name) => {
  const find = async () => {
    const { data, error } = await supabase
      .from('customers').select('*').eq('business_id', businessId).eq('whatsapp_number', number).maybeSingle();
    if (error) throw error;
    return data;
  };
  const existing = await find();
  if (existing) return { customer: existing, created: false };

  const { data, error } = await supabase.from('customers').insert(newCustomerRow(businessId, number, name)).select().single();
  if (error && error.code === UNIQUE_VIOLATION) {
    const raced = await find();
    if (raced) return { customer: raced, created: false };
  }
  if (error) throw error;
  return { customer: data, created: true };
};

/**
 * Customers for many numbers at once (history chunks hold thousands).
 * @param {string} businessId
 * @param {string[]} numbers
 * @returns {Promise<{byNumber:Map<string,Object>, created:number}>}
 */
const ensureCustomers = async (businessId, numbers) => {
  const byNumber = new Map();
  let created = 0;

  for (const chunk of chunksOf(numbers, CHUNK)) {
    const { data, error } = await supabase
      .from('customers').select('id, whatsapp_number, name').eq('business_id', businessId).in('whatsapp_number', chunk);
    if (error) throw error;
    (data || []).forEach((c) => byNumber.set(c.whatsapp_number, c));
  }

  const missing = numbers.filter((n) => !byNumber.has(n));
  for (const chunk of chunksOf(missing, CHUNK)) {
    const { data, error } = await supabase
      .from('customers').insert(chunk.map((n) => newCustomerRow(businessId, n, null))).select('id, whatsapp_number, name');
    if (!error) {
      (data || []).forEach((c) => byNumber.set(c.whatsapp_number, c));
      created += (data || []).length;
      continue;
    }
    // A concurrent writer (a chunk arriving in parallel, a contact import) got
    // some of them first: settle those one at a time.
    for (const n of chunk) {
      const one = await findOrCreateCustomer(businessId, n, null);
      byNumber.set(n, one.customer);
      if (one.created) created += 1;
    }
  }
  return { byNumber, created };
};

/** Insert one message row. @returns {Promise<{row:Object}|{duplicate:true}>} */
const insertOne = async (fields) => {
  const { data, error } = await supabase.from('messages').insert(fields).select().single();
  if (error && error.code === UNIQUE_VIOLATION) return { duplicate: true };
  if (error) throw error;
  return { row: data };
};

/**
 * Insert many message rows, skipping ids already stored. There is no bulk
 * ON CONFLICT here (PostgREST cannot target the partial unique index), so ids
 * already present are filtered out first and a chunk that still hits 23505 is
 * settled row by row.
 * @returns {Promise<{inserted:number, duplicates:number, failed:number}>}
 */
const insertMessages = async (businessId, rows) => {
  const out = { inserted: 0, duplicates: 0, failed: 0 };
  const known = new Set();
  for (const chunk of chunksOf(rows.map((r) => r.meta_message_id), CHUNK)) {
    const { data, error } = await supabase
      .from('messages').select('meta_message_id').eq('business_id', businessId).in('meta_message_id', chunk);
    if (error) throw error;
    (data || []).forEach((m) => known.add(m.meta_message_id));
  }
  const fresh = rows.filter((r) => !known.has(r.meta_message_id));
  out.duplicates += rows.length - fresh.length;

  for (const chunk of chunksOf(fresh, CHUNK)) {
    const { error } = await supabase.from('messages').insert(chunk);
    if (!error) { out.inserted += chunk.length; continue; }
    for (const row of chunk) {
      try {
        const res = await insertOne(row);
        if (res.duplicate) out.duplicates += 1; else out.inserted += 1;
      } catch (err) {
        out.failed += 1;
        logger.error('coexistence: failed to store a message', { businessId, metaMessageId: row.meta_message_id, error: err.message });
      }
    }
  }
  return out;
};

/** smb_message_echoes: stored as outbound 'phone_app' messages, shown in the dashboard. */
const handleEchoes = async (tenant, value) => {
  const businessDigits = digits(value.metadata && value.metadata.display_phone_number);
  const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];
  const stats = { received: echoes.length, stored: 0, duplicates: 0, failed: 0, skipped: {} };

  for (const echo of echoes) {
    try {
      const parsed = parseEcho(echo, businessDigits);
      if (parsed.skip) {
        stats.skipped[parsed.skip] = (stats.skipped[parsed.skip] || 0) + 1;
        continue;
      }
      const { row } = parsed;
      const { customer } = await findOrCreateCustomer(tenant.businessId, row.customerNumber, null);
      const res = await insertOne({
        business_id: tenant.businessId,
        customer_id: customer.id,
        customer_number: row.customerNumber,
        direction: 'outbound',
        type: row.type,
        content: row.content,
        meta_message_id: row.metaId,
        status: 'sent',
        sender_type: 'phone_app',
        is_read: true,
        ...(row.createdAt ? { created_at: row.createdAt } : {})
      });
      if (res.duplicate) { stats.duplicates += 1; continue; }
      stats.stored += 1;

      try {
        socketService.emitToBusiness(tenant.businessId.toString(), 'new_message', {
          customer: toCamelCase(customer),
          message: toCamelCase(res.row),
          customerNumber: row.customerNumber
        });
      } catch (socketError) {
        logger.error('Error emitting new_message socket event for an echo:', socketError);
      }
    } catch (err) {
      stats.failed += 1;
      logger.error('smb_message_echoes: failed to store an echo', { businessId: tenant.businessId, error: err.message });
    }
  }

  logger.info(`smb_message_echoes: business ${tenant.businessId} received ${stats.received}, stored ${stats.stored}, duplicates ${stats.duplicates}, failed ${stats.failed}, skipped ${JSON.stringify(stats.skipped)}`);
  return stats;
};

/** history: old chats stored quietly (no bot, no socket, not counted anywhere). */
const handleHistory = async (tenant, value) => {
  const businessDigits = digits(value.metadata && value.metadata.display_phone_number);
  const entries = Array.isArray(value.history) ? value.history : [];
  const stats = {
    phase: null, chunk: null, progress: null,
    threads: 0, messages: 0, inserted: 0, duplicates: 0, failed: 0, unmatched: 0, customersCreated: 0, errorCodes: []
  };

  for (const entry of entries) {
    try {
      const parsed = parseHistoryEntry(entry, businessDigits);
      if (parsed.meta.phase !== undefined) stats.phase = parsed.meta.phase;
      if (parsed.meta.chunk_order !== undefined) stats.chunk = parsed.meta.chunk_order;
      if (parsed.meta.progress !== undefined) stats.progress = parsed.meta.progress;
      stats.threads += parsed.threads;
      stats.unmatched += parsed.unmatched;
      parsed.errors.forEach((e) => stats.errorCodes.push(e.code));
      if (parsed.messages.length === 0) continue;

      // The same id twice in one chunk counts once.
      const unique = new Map();
      parsed.messages.forEach((m) => { if (!unique.has(m.metaId)) unique.set(m.metaId, m); });
      stats.messages += parsed.messages.length;
      stats.duplicates += parsed.messages.length - unique.size;

      const { byNumber, created } = await ensureCustomers(tenant.businessId, [...new Set([...unique.values()].map((m) => m.customerNumber))]);
      stats.customersCreated += created;

      const rows = [];
      for (const m of unique.values()) {
        const customer = byNumber.get(m.customerNumber);
        if (!customer) { stats.failed += 1; continue; }
        rows.push({
          business_id: tenant.businessId,
          customer_id: customer.id,
          customer_number: m.customerNumber,
          direction: m.direction,
          type: m.type,
          content: m.content,
          meta_message_id: m.metaId,
          status: m.status,
          is_read: true,
          sender_type: m.direction === 'outbound' ? 'phone_app' : 'human',
          is_history_import: true,
          ...(m.createdAt ? { created_at: m.createdAt } : {})
        });
      }
      const result = await insertMessages(tenant.businessId, rows);
      stats.inserted += result.inserted;
      stats.duplicates += result.duplicates;
      stats.failed += result.failed;
    } catch (err) {
      stats.failed += 1;
      logger.error('history: failed to process a chunk', { businessId: tenant.businessId, error: err.message });
    }
  }

  logger.info(`history: business ${tenant.businessId} phase ${stats.phase} chunk ${stats.chunk} progress ${stats.progress}% threads ${stats.threads} messages ${stats.messages} inserted ${stats.inserted} duplicates ${stats.duplicates} failed ${stats.failed} unmatched ${stats.unmatched} customersCreated ${stats.customersCreated}`);
  if (stats.errorCodes.length > 0) {
    // 2593109 = the owner turned history sharing off in the app. Nothing to do.
    logger.warn(`history: business ${tenant.businessId} history sync not delivered (error codes ${stats.errorCodes.join(', ')})`);
  }
  return stats;
};

/** smb_app_state_sync: phone contacts become customers; an existing name is never overwritten. */
const handleStateSync = async (tenant, value) => {
  const parsed = parseStateSync(value.state_sync);
  const stats = { received: Array.isArray(value.state_sync) ? value.state_sync.length : 0, created: 0, existing: 0, namesFilled: 0, removes: parsed.removes, invalid: parsed.invalid, failed: 0 };

  try {
    const numbers = parsed.adds.map((a) => a.phone);
    const existing = new Map();
    for (const chunk of chunksOf(numbers, CHUNK)) {
      const { data, error } = await supabase
        .from('customers').select('id, whatsapp_number, name').eq('business_id', tenant.businessId).in('whatsapp_number', chunk);
      if (error) throw error;
      (data || []).forEach((c) => existing.set(c.whatsapp_number, c));
    }
    stats.existing = existing.size;

    const toCreate = parsed.adds.filter((a) => !existing.has(a.phone));
    for (const chunk of chunksOf(toCreate, CHUNK)) {
      const { data, error } = await supabase
        .from('customers').insert(chunk.map((a) => newCustomerRow(tenant.businessId, a.phone, a.name))).select('id');
      if (!error) { stats.created += (data || []).length; continue; }
      for (const a of chunk) {
        try {
          const one = await findOrCreateCustomer(tenant.businessId, a.phone, a.name);
          if (one.created) stats.created += 1; else stats.existing += 1;
        } catch (err) {
          stats.failed += 1;
          logger.error('smb_app_state_sync: failed to store a contact', { businessId: tenant.businessId, error: err.message });
        }
      }
    }

    // Only ever fills an empty name.
    for (const a of parsed.adds) {
      const current = existing.get(a.phone);
      if (!current || current.name || !a.name) continue;
      const { data, error } = await supabase
        .from('customers').update({ name: a.name }).eq('id', current.id).or('name.is.null,name.eq.').select('id');
      if (error) { stats.failed += 1; continue; }
      stats.namesFilled += (data || []).length;
    }
  } catch (err) {
    stats.failed += 1;
    logger.error('smb_app_state_sync: failed to process contacts', { businessId: tenant.businessId, error: err.message });
  }

  logger.info(`smb_app_state_sync: business ${tenant.businessId} received ${stats.received}, created ${stats.created}, existing ${stats.existing}, namesFilled ${stats.namesFilled}, removed(logged only) ${stats.removes}, invalid ${stats.invalid}, failed ${stats.failed}`);
  return stats;
};

/**
 * account_update: the WABA's connection was removed or re-established. The
 * event carries no phone number, so the business is found by WABA id. IDs and
 * the token are kept either way (a reconnect needs them).
 */
const handleAccountUpdate = async (entry, value) => {
  const event = value && value.event;
  const action = accountUpdateAction(event);
  const wabaId = entry && entry.id ? String(entry.id) : '';
  const info = value && value.disconnection_info ? value.disconnection_info : undefined;

  if (action === 'log') {
    logger.info(`account_update: event ${event || '(none)'} for WABA ${wabaId} - no action`, { disconnectionInfo: info });
    return { action };
  }
  if (!wabaId) {
    logger.warn(`account_update: ${event} without an entry id - ignored`);
    return { action: 'ignored' };
  }

  const { data: rows, error } = await supabase
    .from('businesses').select('id, phone_number_id, is_whatsapp_connected, access_token').eq('waba_id', wabaId).limit(2);
  if (error) throw error;
  if (!rows || rows.length === 0) {
    logger.warn(`account_update: ${event} for WABA ${wabaId} matches no business`);
    return { action: 'ignored' };
  }
  if (rows.length > 1) {
    logger.warn(`account_update: ${event} for WABA ${wabaId} matches more than one business - ignored`);
    return { action: 'ignored' };
  }
  const business = rows[0];

  let target = null;
  if (action === 'disconnect') {
    target = false;
  } else if (!business.access_token) {
    logger.warn(`account_update: ${event} for business ${business.id} but no stored token - the owner must reconnect`);
    return { action: 'ignored' };
  } else {
    target = true;
  }

  if (business.is_whatsapp_connected === target) {
    logger.info(`account_update: ${event} for business ${business.id} - already ${target ? 'connected' : 'disconnected'}`);
    return { action: 'unchanged' };
  }

  const { error: updateError } = await supabase.from('businesses').update({ is_whatsapp_connected: target }).eq('id', business.id);
  if (updateError) throw updateError;
  if (business.phone_number_id) await tenantService.invalidateTenantCache(business.phone_number_id);

  logger.warn(`account_update: ${event} - business ${business.id} marked ${target ? 'connected' : 'disconnected'}`, { disconnectionInfo: info });
  return { action: target ? 'connected' : 'disconnected' };
};

/**
 * Entry point for the four fields. Resolves the business (it must be active and
 * connected) and dispatches. Throws only on unexpected failures; the webhook
 * loop logs those and carries on.
 */
const handleChange = async (entry, changes) => {
  const field = changes && changes.field;
  const value = (changes && changes.value) || {};

  if (field === 'account_update') return handleAccountUpdate(entry, value);

  const phoneNumberId = value.metadata && value.metadata.phone_number_id;
  if (!phoneNumberId) {
    logger.warn(`${field}: no phone_number_id in the payload - ignored`);
    return null;
  }
  const tenant = await tenantService.resolveBusinessByPhoneNumberId(phoneNumberId);
  if (!tenant) {
    logger.warn(`${field}: no active, connected business for phoneNumberId ${phoneNumberId} - ignored`);
    return null;
  }

  if (field === 'smb_message_echoes') return handleEchoes(tenant, value);
  if (field === 'history') return handleHistory(tenant, value);
  if (field === 'smb_app_state_sync') return handleStateSync(tenant, value);
  return null;
};

module.exports = {
  COEXISTENCE_FIELDS,
  handleChange,
  handleEchoes,
  handleHistory,
  handleStateSync,
  handleAccountUpdate,
  findOrCreateCustomer,
  ensureCustomers
};
