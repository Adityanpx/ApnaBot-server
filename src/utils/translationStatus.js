// translation_status on a business: { "<lang>": { status: 'pending'|'done'|'failed', at: iso } }, written
// while the signup default-flow translation runs. Pure.
//
// A 'pending' older than STATUS_STALE_MS is a run that died with the server: it reads as 'failed' so
// the canvas is never locked for good.
const STATUS_STALE_MS = 10 * 60 * 1000;

const readStatus = (row) => (row && row.translation_status && typeof row.translation_status === 'object' ? row.translation_status : {});

/** { lang: 'pending'|'done'|'failed' } from a raw translation_status value. */
const statusSummary = (raw, now = Date.now()) => {
  const out = {};
  for (const [lang, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!entry || typeof entry !== 'object') continue;
    const stale = entry.status === 'pending' && now - Date.parse(entry.at) > STATUS_STALE_MS;
    out[lang] = stale ? 'failed' : entry.status;
  }
  return out;
};

const isTranslating = (summary) => Object.values(summary).includes('pending');

module.exports = { STATUS_STALE_MS, readStatus, statusSummary, isTranslating };
