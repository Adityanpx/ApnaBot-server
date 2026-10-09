const cleanup = require('../services/storageCleanup.service');
const { successResponse } = require('../utils/response');
const logger = require('../utils/logger');

// Every handler: superadmin only (routes/storageCleanup.routes.js). Errors with a
// statusCode (validation, typed-confirmation, 404/409) reach the error middleware as-is.
const wrap = (name, fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (!error.statusCode) logger.error(`Error in storage cleanup ${name}:`, error);
    next(error);
  }
};

const getSummary = wrap('summary', async (req, res) => successResponse(res, 200, await cleanup.summary()));

const preview = wrap('preview', async (req, res) => successResponse(res, 200, await cleanup.preview(req.body || {})));

const createRun = wrap('createRun', async (req, res) => {
  const run = await cleanup.createManualRun(req.body || {}, req.user.userId);
  return successResponse(res, 201, run, 'Cleanup scheduled - files are deleted after the pending period unless you cancel');
});

const listRuns = wrap('listRuns', async (req, res) => successResponse(res, 200, { runs: await cleanup.listRuns({ limit: req.query.limit }) }));

const getRun = wrap('getRun', async (req, res) => successResponse(res, 200,
  await cleanup.getRun(req.params.id, { itemLimit: req.query.itemLimit, status: req.query.status || null })));

const cancelRun = wrap('cancelRun', async (req, res) => {
  const run = await cleanup.cancelRun(req.params.id, req.user.userId);
  logger.info('Storage cleanup run cancelled', { runId: run.id, userId: req.user.userId });
  return successResponse(res, 200, run, 'Cleanup cancelled');
});

const exportRunCsv = wrap('exportRunCsv', async (req, res) => {
  const csv = await cleanup.exportCsv(req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="storage-cleanup-${req.params.id}.csv"`);
  return res.status(200).send(csv);
});

const startOrphanScan = wrap('orphanScan', async (req, res) => {
  const job = await cleanup.startOrphanScan(req.body || {}, req.user.userId);
  return successResponse(res, 202, job, 'Orphan scan started - a pending run appears in Runs when it finds files');
});

const getOrphanScan = wrap('orphanScanStatus', async (req, res) => successResponse(res, 200, { job: cleanup.orphanScanStatus() }));

const getSettings = wrap('getSettings', async (req, res) => successResponse(res, 200, {
  chatMediaRetentionDays: await cleanup.getPlatformRetentionDays(),
  minRetentionDays: cleanup.MIN_RETENTION_DAYS,
  allBusinessesPhrase: cleanup.ALL_BUSINESSES_PHRASE
}));

const updateSettings = wrap('updateSettings', async (req, res) => {
  const body = req.body || {};
  if (!Object.hasOwn(body, 'chatMediaRetentionDays')) {
    return res.status(400).json({ success: false, message: 'chatMediaRetentionDays is required (a number of days, or null for off)', data: null, errors: null });
  }
  await cleanup.setPlatformRetentionDays(body.chatMediaRetentionDays);
  logger.info('Chat media retention changed by superadmin', { days: body.chatMediaRetentionDays, userId: req.user.userId });
  return successResponse(res, 200, { chatMediaRetentionDays: await cleanup.getPlatformRetentionDays() }, 'Retention updated');
});

const setBusinessRetention = wrap('businessRetention', async (req, res) => {
  const body = req.body || {};
  if (!Object.hasOwn(body, 'retention')) {
    return res.status(400).json({ success: false, message: 'retention is required (a number of days, "never", or null to follow the platform)', data: null, errors: null });
  }
  const stored = await cleanup.setBusinessRetention(req.params.id, body.retention);
  logger.info('Business chat media retention changed by superadmin', { businessId: req.params.id, retention: stored, userId: req.user.userId });
  return successResponse(res, 200, { businessId: req.params.id, retention: stored === null ? null : (stored === 'never' ? 'never' : Number(stored)) }, 'Retention updated');
});

module.exports = {
  getSummary, preview, createRun, listRuns, getRun, cancelRun, exportRunCsv,
  startOrphanScan, getOrphanScan, getSettings, updateSettings, setBusinessRetention
};
