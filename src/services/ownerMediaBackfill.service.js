// Backfill for the owner_phone_media switch: when Super Admin turns it on, the
// phone-app echoes of the last few days (kept as a label + messages.wa_media_id
// while it was off) can be downloaded after the fact. Meta keeps a media id
// downloadable for ~30 days; we only go back MAX_DAYS. Same type / size caps as
// live echo media (echoMedia.service.js).
//
// preview() only reads our own database - it never calls Meta, so it cannot
// know file sizes (estimatedBytes is null). start() runs in the background in
// this process: state lives in memory, so a restart drops a running job (rows
// not yet done stay candidates; just run it again).
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const { isStorableMime, isOwnerMediaEnabled, fetchAndStoreEchoMedia } = require('./echoMedia.service');

const MAX_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;
const BATCH = 5; // downloads in flight at once

const jobs = new Map(); // businessId -> latest job summary

/** Days: undefined -> MAX_DAYS; otherwise an integer 1..MAX_DAYS, or null when invalid. */
const parseDays = (value) => {
  if (value === undefined || value === null) return MAX_DAYS;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : null;
};

/**
 * Echo rows still waiting for their file: phone_app, media id kept, no media_url,
 * created within `days`. A file that storage cleanup removed (media_removed_at)
 * is never fetched back.
 */
const listCandidates = async (businessId, days, now = new Date()) => {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('messages')
      .select('id, customer_id, type, wa_media_id, wa_media_mime, created_at')
      .eq('business_id', businessId).eq('sender_type', 'phone_app')
      .not('wa_media_id', 'is', null).is('media_url', null).is('media_removed_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false }).order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data || []) if (isStorableMime(r.type, r.wa_media_mime)) out.push(r);
    if (!data || data.length < PAGE) break;
  }
  return out;
};

/** @returns {Promise<{count:number, estimatedBytes:null, days:number}>} */
const preview = async (businessId, days, now = new Date()) => {
  const rows = await listCandidates(businessId, days, now);
  return { count: rows.length, estimatedBytes: null, days };
};

// Meta answers 400 / 404 for a media id that has expired or never existed.
const isExpiredError = (err) => [400, 404].includes(err.response && err.response.status);

const runJob = async (job, tenant, rows) => {
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      await Promise.all(rows.slice(i, i + BATCH).map(async (r) => {
        try {
          const result = await fetchAndStoreEchoMedia(tenant, r, { type: r.type, id: r.wa_media_id, mimeType: r.wa_media_mime });
          if (result.url) job.stored += 1; else job.skipped += 1;
        } catch (err) {
          if (isExpiredError(err)) {
            job.expired += 1;
            logger.info('Owner media backfill: media id expired, skipped', { businessId: job.businessId, messageId: r.id });
          } else {
            job.failed += 1;
            logger.error('Owner media backfill: download failed', { businessId: job.businessId, messageId: r.id, message: err.message });
          }
        }
        job.processed += 1;
      }));
    }
    job.status = 'done';
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    logger.error('Owner media backfill failed', { businessId: job.businessId, message: err.message });
  } finally {
    job.finishedAt = new Date().toISOString();
  }
};

/**
 * Starts the background job. Does not await it.
 * @param {Object} business - snake_case row: id, business_category, access_token, is_whatsapp_connected
 * @returns {Promise<{job:Object}|{error:string, status:number}>}
 */
const start = async (business, days, now = new Date()) => {
  const running = jobs.get(business.id);
  if (running && running.status === 'running') return { status: 409, error: 'A backfill is already running for this business.' };
  const tenant = { businessId: business.id, businessCategory: business.business_category, accessToken: business.access_token };
  if (!(await isOwnerMediaEnabled(tenant))) return { status: 409, error: 'Switch on "Save owner\'s phone-app media" for this business first.' };
  if (!tenant.accessToken || !business.is_whatsapp_connected) return { status: 409, error: 'This business has no connected WhatsApp number.' };

  const rows = await listCandidates(business.id, days, now);
  const job = {
    businessId: business.id, status: 'running', days, total: rows.length,
    processed: 0, stored: 0, skipped: 0, expired: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null
  };
  jobs.set(business.id, job);
  if (rows.length === 0) {
    job.status = 'done';
    job.finishedAt = job.startedAt;
  } else {
    runJob(job, tenant, rows).catch((err) => logger.error('Owner media backfill crashed', { message: err.message }));
  }
  return { job };
};

const status = (businessId) => jobs.get(businessId) || null;

module.exports = { MAX_DAYS, parseDays, listCandidates, preview, start, status };
