// Live numbers for a broadcast: the stats shown on its detail page, and the
// `broadcast_progress` socket event that keeps them moving while it sends and
// while Meta's delivered / read / failed webhooks arrive.

const supabase = require('../config/supabase');
const socketService = require('./socket.service');
const logger = require('../utils/logger');

// At most one event per broadcast in this window, however many rows moved.
const PROGRESS_INTERVAL_MS = 2000;

/**
 * The counts for a broadcast (broadcast_recipient_stats): queued / sent /
 * delivered / read / failed. They overlap on purpose - sent = Meta accepted it,
 * delivered includes read, failed includes ones that failed after being accepted.
 * A broadcast with no recipient rows (sent before delivery tracking) is
 * `tracked: false` and only has what the old counters knew.
 * @param {string} businessId
 * @param {string} broadcastId
 * @param {Object} broadcastRow - snake_case broadcasts row (sent_count, failed_count, total_recipients)
 * @returns {Promise<{tracked: boolean, total: number, queued: number|null, sent: number, delivered: number|null, read: number|null, failed: number}>}
 */
const getBroadcastStats = async (businessId, broadcastId, broadcastRow) => {
  const untracked = {
    tracked: false,
    total: broadcastRow.total_recipients || 0,
    queued: null,
    sent: broadcastRow.sent_count || 0,
    delivered: null,
    read: null,
    failed: broadcastRow.failed_count || 0
  };
  try {
    const { data, error } = await supabase.rpc('broadcast_recipient_stats', { p_broadcast_id: broadcastId, p_business_id: businessId });
    if (error) throw error;
    if (!data || !data.tracked) return untracked;
    return {
      tracked: true,
      total: data.total, queued: data.queued, sent: data.sent,
      delivered: data.delivered, read: data.read, failed: data.failed
    };
  } catch (err) {
    logger.error(`Broadcast ${broadcastId}: could not load delivery stats`, err);
    return untracked;
  }
};

const pending = new Set(); // broadcast ids with an event already scheduled

/**
 * Tell the business's dashboards a broadcast's numbers changed. Throttled: the
 * first call schedules one event for `delayMs` later (carrying the numbers as
 * they are THEN), further calls in that window add nothing. Never throws.
 */
const notifyBroadcastProgress = (businessId, broadcastId, delayMs = PROGRESS_INTERVAL_MS) => {
  if (!businessId || !broadcastId) return;
  const key = String(broadcastId);
  if (pending.has(key)) return;
  pending.add(key);
  const timer = setTimeout(async () => {
    pending.delete(key);
    try {
      const { data: row, error } = await supabase.from('broadcasts')
        .select('status, total_recipients, sent_count, failed_count')
        .eq('id', broadcastId).eq('business_id', businessId).maybeSingle();
      if (error) throw error;
      if (!row) return;
      const stats = await getBroadcastStats(businessId, broadcastId, row);
      socketService.emitToBusiness(String(businessId), 'broadcast_progress', {
        broadcastId,
        status: row.status,
        totalRecipients: row.total_recipients,
        sentCount: row.sent_count,
        failedCount: row.failed_count,
        stats
      });
    } catch (err) {
      logger.error(`Broadcast ${broadcastId}: could not emit broadcast_progress`, err);
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
};

module.exports = { getBroadcastStats, notifyBroadcastProgress, PROGRESS_INTERVAL_MS };
