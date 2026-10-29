// Human-needed alert ("handoff"): one push to the owner per OPEN escalation, an honest reply to the
// customer, an optional bot pause and a "still waiting" reminder. State lives on the customer row
// (customers.needs_human_at / needs_human_reason / handoff_cleared_at / handoff_pause_set_to);
// settings in business_handoff_settings (no row = off, the legacy human_needed push is untouched).
// See supabase/migrations/20261028120000_handoff.sql for the column meanings.
//
//   raise()   open an escalation. One guarded UPDATE decides the winner; only the winner pushes,
//             pauses the bot and plans the reminder, so a repeat trigger sends nothing twice.
//   clear()   close it (Mark done, a staff reply from the dashboard, a reply from the phone app).
//
// Never throws to its callers except where noted: a failure here must not stop the customer's reply.
const supabase = require('../config/supabase');
const notificationService = require('./notification.service');
const { fromRow, toRow, DEFAULTS, effectiveKeywords } = require('../utils/handoffSettings');
const { isClosedNow, nextOpening, formatOpening } = require('../utils/handoffHours');
const { getLocalizedText } = require('../utils/localization');
const { getSystemMessage } = require('../utils/systemMessages');
const { fillPlaceholders } = require('../utils/templateValue');
const logger = require('../utils/logger');

const SETTINGS_TTL_SECONDS = 60;
// After a clear, "unmatched" cannot reopen the escalation for this long (a tap or a keyword can).
const UNMATCHED_COOLDOWN_MS = 30 * 60 * 1000;
const UNMATCHED_COUNTER_TTL_SECONDS = 24 * 60 * 60;

const usable = (text) => typeof text === 'string' && text.trim() !== '';

// Lazy: importing this module (the webhook does) must not open a Redis connection.
const getRedis = () => require('../config/redis');
const settingsKey = (businessId) => `handoff:settings:${businessId}`;
const unmatchedKey = (businessId, customerId) => `handoff:unmatched:${businessId}:${customerId}`;

// ── Settings ─────────────────────────────────────────────────────────────────
/**
 * The business's settings (60s Redis cache, invalidated on PUT), or null when it has no row.
 * Never throws: a read failure counts as "no row", so the legacy behaviour carries on.
 */
const getSettings = async (businessId) => {
  const key = settingsKey(businessId);
  try {
    try {
      const cached = await getRedis().get(key);
      if (cached) return cached === 'none' ? null : JSON.parse(cached);
    } catch (cacheErr) {
      logger.warn(`Handoff settings cache read failed for business ${businessId}: ${cacheErr.message}`);
    }
    let settings = null;
    try {
      const { data, error } = await supabase.from('business_handoff_settings').select('*').eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      settings = data ? fromRow(data) : null;
    } catch (dbErr) {
      logger.error(`Handoff settings read failed for business ${businessId}, treating handoff as off:`, dbErr);
    }
    try {
      await getRedis().set(key, settings ? JSON.stringify(settings) : 'none', 'EX', SETTINGS_TTL_SECONDS);
    } catch (cacheErr) {
      logger.warn(`Handoff settings cache write failed for business ${businessId}: ${cacheErr.message}`);
    }
    return settings;
  } catch (err) {
    logger.error(`Handoff settings read failed for business ${businessId}:`, err);
    return null;
  }
};

/** The settings when handoff is switched on for the business, else null. */
const getActiveSettings = async (businessId) => {
  const settings = await getSettings(businessId);
  return settings && settings.enabled ? settings : null;
};

const invalidateSettings = async (businessId) => {
  try {
    await getRedis().del(settingsKey(businessId));
  } catch (err) {
    logger.error(`Handoff settings cache invalidation failed for business ${businessId}:`, err);
  }
};

/**
 * Merges `patch` onto the stored row (or the defaults when there is none) and writes it.
 * @returns {Promise<object>} the saved settings
 */
const saveSettings = async (businessId, patch) => {
  const { data: existing, error: readErr } = await supabase
    .from('business_handoff_settings').select('*').eq('business_id', businessId).maybeSingle();
  if (readErr) throw readErr;
  const merged = { ...DEFAULTS, ...(existing ? fromRow(existing) : {}), ...patch };
  const { data, error } = await supabase
    .from('business_handoff_settings').upsert({ business_id: businessId, ...toRow(merged) }, { onConflict: 'business_id' }).select().single();
  if (error) throw error;
  await invalidateSettings(businessId);
  return fromRow(data);
};

// ── What the customer is told ────────────────────────────────────────────────
/**
 * The reply for an escalation: the closed text when hours are set and it is closed now, else the
 * reply text; the business's own (in the customer's language) or the built-in one.
 */
const replyTextFor = (settings, language, now = new Date()) => {
  if (settings.hours && isClosedNow(settings.hours, now)) {
    const opening = nextOpening(settings.hours, now);
    if (opening) {
      const vars = { nextOpening: formatOpening(opening, language) };
      const own = getLocalizedText(settings, 'closedText', language);
      return usable(own) ? fillPlaceholders(own, vars) : getSystemMessage('handoffClosed', language, vars);
    }
  }
  const own = getLocalizedText(settings, 'replyText', language);
  return usable(own) ? own : getSystemMessage('handoffReply', language);
};

/** The business's own media-received text (in the customer's language) or the built-in one. */
const mediaReplyTextFor = (settings, language) => {
  const own = getLocalizedText(settings, 'mediaReplyText', language);
  return usable(own) ? own : getSystemMessage('mediaReceived', language);
};

/** Whether the business chose "Thank them and alert the team" for photos / PDFs / documents. */
const isMediaAlertOn = (settings) => !!settings && settings.mediaReplyMode === 'thank_and_alert';

// ── State on the customer row ────────────────────────────────────────────────
const toNeedsHuman = (customerRow) => {
  const since = customerRow && (customerRow.needsHumanAt || customerRow.needs_human_at);
  if (!since) return null;
  return { since, reason: customerRow.needsHumanReason || customerRow.needs_human_reason || null };
};

const emitNeedsHuman = (businessId, customerId, needsHuman) => {
  try {
    // Lazy: socket.service pulls in auth.service and Redis; importing this module must stay light.
    require('./socket.service').emitToBusiness(String(businessId), 'needs_human', { customerId, needsHuman });
  } catch (err) {
    logger.error('Error emitting needs_human socket event:', err);
  }
};

const resetUnmatched = async (businessId, customerId) => {
  try {
    await getRedis().del(unmatchedKey(businessId, customerId));
  } catch (err) {
    logger.error('Handoff: could not reset the unmatched counter:', err);
  }
};

/** Counts one more unmatched message in a row. 0 when Redis fails, so a failure never escalates. */
const bumpUnmatched = async (businessId, customerId) => {
  try {
    const redis = getRedis();
    const count = await redis.incr(unmatchedKey(businessId, customerId));
    if (count === 1) await redis.expire(unmatchedKey(businessId, customerId), UNMATCHED_COUNTER_TTL_SECONDS);
    return count;
  } catch (err) {
    logger.error('Handoff: could not count the unmatched message:', err);
    return 0;
  }
};

// Pauses the bot for the escalation: never shortens a pause already in force (an owner's "forever"
// included). Remembers what it wrote so clear() can lift only its own pause.
const pauseBotFor = async (businessId, customer, minutes) => {
  const until = Date.now() + minutes * 60 * 1000;
  const current = customer.botPausedUntil ? new Date(customer.botPausedUntil).getTime() : 0;
  if (current >= until) return;
  const untilIso = new Date(until).toISOString();
  const { error } = await supabase.from('customers')
    .update({ bot_paused_until: untilIso, handoff_pause_set_to: untilIso })
    .eq('id', customer.id).eq('business_id', businessId);
  if (error) throw error;
  customer.botPausedUntil = untilIso;
};

/**
 * Opens an escalation for a customer.
 * @param {{businessId: string, customer: object, customerNumber: string, reason: 'tap'|'keyword'|'unmatched'|'media', settings: object}} args
 *   customer is the camelCase row; it is updated in place (needsHumanAt, botPausedUntil)
 * @returns {Promise<{claimed: boolean}>} claimed false = one is already open (or, for 'unmatched', was
 *   cleared under 30 minutes ago): nothing was sent. Throws only if the claim itself fails.
 */
const raise = async ({ businessId, customer, customerNumber, reason, settings }) => {
  const now = new Date();
  let claim = supabase.from('customers')
    .update({ needs_human_at: now.toISOString(), needs_human_reason: reason })
    .eq('id', customer.id).eq('business_id', businessId).is('needs_human_at', null);
  if (reason === 'unmatched') {
    claim = claim.or(`handoff_cleared_at.is.null,handoff_cleared_at.lt.${new Date(now.getTime() - UNMATCHED_COOLDOWN_MS).toISOString()}`);
  }
  const { data, error } = await claim.select('id');
  if (error) throw error;
  if (!data || data.length === 0) return { claimed: false };

  customer.needsHumanAt = now.toISOString();
  customer.needsHumanReason = reason;
  await resetUnmatched(businessId, customer.id);

  if (settings.pauseBotMinutes > 0) {
    try {
      await pauseBotFor(businessId, customer, settings.pauseBotMinutes);
    } catch (err) {
      logger.error(`Handoff: could not pause the bot for customer ${customer.id}:`, err);
    }
  }

  // Fire and forget; notify never throws.
  notificationService.notify(businessId, 'human_needed', {
    customerId: customer.id, customerName: customer.name, customerNumber
  });

  if (settings.reminderMinutes > 0) {
    try {
      const { scheduleHandoffReminder } = require('../queues/handoffReminder.queue');
      await scheduleHandoffReminder({
        businessId, customerId: customer.id, needsHumanAt: customer.needsHumanAt
      }, settings.reminderMinutes * 60 * 1000);
    } catch (err) {
      logger.error(`Handoff: could not plan the reminder for customer ${customer.id}:`, err);
    }
  }

  emitNeedsHuman(businessId, customer.id, { since: customer.needsHumanAt, reason });
  return { claimed: true };
};

/**
 * Closes the customer's open escalation, if any: stamps handoff_cleared_at, cancels the reminder,
 * and (when the business has auto-resume on) lifts the bot pause the handoff itself set.
 * @returns {Promise<{found: boolean, wasOpen: boolean, clearedAt: string|null}>} found false = no such customer in this business
 */
const clear = async ({ businessId, customerId }) => {
  const { data: row, error } = await supabase.from('customers')
    .select('id, needs_human_at, bot_paused_until, handoff_pause_set_to')
    .eq('id', customerId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  if (!row) return { found: false, wasOpen: false, clearedAt: null };
  if (!row.needs_human_at) return { found: true, wasOpen: false, clearedAt: null };

  const openedAt = row.needs_human_at;
  const clearedAt = new Date().toISOString();
  const update = { needs_human_at: null, needs_human_reason: null, handoff_cleared_at: clearedAt, handoff_pause_set_to: null };
  const settings = await getSettings(businessId);
  const pauseIsOurs = row.handoff_pause_set_to && row.bot_paused_until
    && new Date(row.handoff_pause_set_to).getTime() === new Date(row.bot_paused_until).getTime();
  if (settings && settings.autoResumeBot && pauseIsOurs) update.bot_paused_until = null;

  const { data: updated, error: updateErr } = await supabase.from('customers')
    .update(update).eq('id', customerId).eq('business_id', businessId).not('needs_human_at', 'is', null).select('id');
  if (updateErr) throw updateErr;
  if (!updated || updated.length === 0) return { found: true, wasOpen: false, clearedAt: null }; // cleared by someone else first

  try {
    const { cancelHandoffReminder } = require('../queues/handoffReminder.queue');
    await cancelHandoffReminder(customerId, openedAt);
  } catch (err) {
    // Harmless: the reminder re-checks needs_human_at before sending.
    logger.error(`Handoff: could not cancel the reminder for customer ${customerId}:`, err);
  }
  emitNeedsHuman(businessId, customerId, null);
  return { found: true, wasOpen: true, clearedAt };
};

/** clear() for the automatic paths (a staff reply): never throws. */
const clearQuietly = async (args) => {
  try {
    return await clear(args);
  } catch (err) {
    logger.error(`Handoff: could not clear for customer ${args.customerId}:`, err);
    return { found: false, wasOpen: false, clearedAt: null };
  }
};

/**
 * Runs when the reminder job fires: pushes "still waiting" only if that same escalation is still open.
 * @returns {Promise<'notified'|'cleared'|'error'>}
 */
const runReminder = async ({ businessId, customerId, needsHumanAt }) => {
  try {
    const { data: row, error } = await supabase.from('customers')
      .select('needs_human_at, name, whatsapp_number').eq('id', customerId).eq('business_id', businessId).maybeSingle();
    if (error) throw error;
    if (!row || !row.needs_human_at || new Date(row.needs_human_at).getTime() !== new Date(needsHumanAt).getTime()) return 'cleared';
    await notificationService.notify(businessId, 'human_needed', {
      customerId, customerName: row.name, customerNumber: row.whatsapp_number, reminder: true
    });
    return 'notified';
  } catch (err) {
    logger.error(`Handoff: reminder for customer ${customerId} failed:`, err);
    return 'error';
  }
};

module.exports = {
  UNMATCHED_COOLDOWN_MS,
  getSettings,
  getActiveSettings,
  invalidateSettings,
  saveSettings,
  effectiveKeywords,
  replyTextFor,
  mediaReplyTextFor,
  isMediaAlertOn,
  toNeedsHuman,
  bumpUnmatched,
  resetUnmatched,
  raise,
  clear,
  clearQuietly,
  runReminder
};
