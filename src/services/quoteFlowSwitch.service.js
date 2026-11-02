// "Enable quotes" / "Disable quotes" for ONE travel business: the per-business travel_quotes override and the quote flow
// (services/quoteFlowInstaller.service.js) moved together, so the owner (or Super Admin) needs one button, not two keys.
//
//   enable   refused for Search cab AI (by id), for a readiness checklist with a blocking item, and for a Round Trip
//            with no priceable route until it is acknowledged. Then: override ON -> installer (restore point in
//            flow_snapshots, additive write, byte-identical check) -> if the install fails, the override goes back to what
//            it was. Already installed and on: nothing is written, the readiness comes back (idempotent).
//   disable  installer rollback (removes exactly the business's own derived-id rows) -> override OFF. If the rollback
//            fails the override is left as it is, so the switch and the flow never disagree. Nothing installed: only the
//            override is set (idempotent).
//
// The "switch is on" readiness item does not block an enable: pressing Enable is what turns it on.
// Every call returns { ok, status, code, message, readiness, blockers?, log? } - the controllers turn it into a response.
const installer = require('./quoteFlowInstaller.service');

const FEATURE = 'travel_quotes';
const PROTECTED_MESSAGE = 'Search cab AI is a live production bot that is managed by hand: the quote flow is never enabled or disabled for it from here.';

const defaultDeps = () => {
  const supabase = require('../config/supabase');
  const categoryFeatureService = require('./categoryFeature.service');
  return {
    findProtectedBusinessIds: () => installer.findProtectedBusinessIds(supabase),
    getReadiness: (businessId, entry) => require('./quoteReadiness.service').getQuoteReadiness(businessId, entry),
    getOverride: (businessId) => categoryFeatureService.getBusinessOverride(businessId, FEATURE),
    setOverride: (businessId, value) => categoryFeatureService.setBusinessOverride(businessId, FEATURE, value),
    // Runs the installer for one business and hands back its exit code and what it printed.
    runInstaller: async (options) => {
      const lines = [];
      const { createSnapshotFromRows } = require('./flowSnapshot.service');
      const { invalidateRulesCache } = require('./chatbot.service');
      const code = await installer.run(options, {
        supabase,
        isQuotesEnabled: (category, id) => categoryFeatureService.isEnabled(category, FEATURE, id),
        listQuotableRoutes: (id, tripType) => require('./travelQuote.service').listQuotableRoutes(id, tripType),
        invalidateCache: invalidateRulesCache,
        saveSnapshot: createSnapshotFromRows,
        findProtectedBusinessIds: () => installer.findProtectedBusinessIds(supabase),
        log: (line) => lines.push(line)
      });
      return { code, lines };
    },
    logger: require('../utils/logger')
  };
};

const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });
const blockersOf = (readiness) => readiness.items.filter((i) => i.status === 'block' && i.key !== 'feature');
// The last REFUSED line of the installer's output: the plain reason it gave.
const refusalOf = (lines) => {
  const hit = [...lines].reverse().find((l) => String(l).includes('REFUSED:'));
  return hit ? String(hit).replace(/^[\s\S]*REFUSED:\s*/, '') : null;
};

const restoreOverride = async (deps, businessId, prior) => {
  if (prior === true) return null; // it was already on before we touched anything
  try {
    await deps.setOverride(businessId, prior);
    return null;
  } catch (error) {
    deps.logger.error(`quote flow: could not restore the travel_quotes override of ${businessId}:`, error);
    return error;
  }
};

/**
 * @param {string} businessId
 * @param {{ keyword?: string, aliases?: string[], acknowledgeRoundTripTeam?: boolean }} [body]
 * @param {Object} [overrides] dependencies, for tests
 */
const enableQuoteFlow = async (businessId, body = {}, overrides = {}) => {
  const deps = { ...defaultDeps(), ...overrides };
  const entry = { keyword: body.keyword, aliases: body.aliases };

  if ((await deps.findProtectedBusinessIds()).includes(businessId)) return fail(403, 'PROTECTED_BUSINESS', PROTECTED_MESSAGE);

  const readiness = await deps.getReadiness(businessId, entry);
  if (readiness.installed.state === 'installed' && readiness.enabled) {
    return { ok: true, status: 200, message: 'Quotes are already enabled.', alreadyEnabled: true, readiness };
  }
  const blockers = blockersOf(readiness);
  if (blockers.length > 0) {
    return fail(409, 'NOT_READY', `Quotes cannot be enabled yet: ${blockers.map((b) => b.title).join(', ')}.`, { readiness, blockers });
  }
  const mustAcknowledge = readiness.acknowledgements.find((a) => a.required && !body.acknowledgeRoundTripTeam);
  if (mustAcknowledge && readiness.installed.state !== 'installed') {
    return fail(409, 'ACKNOWLEDGEMENT_REQUIRED', `Tick "${mustAcknowledge.text}" to continue: no route can be priced for Round Trip yet, so those customers are handed to your team.`, { readiness, blockers: [] });
  }

  const prior = await deps.getOverride(businessId);
  if (prior !== true) await deps.setOverride(businessId, true);

  if (readiness.installed.state === 'installed') {
    return { ok: true, status: 200, message: 'Quotes enabled.', readiness: await deps.getReadiness(businessId, entry) };
  }

  let result;
  try {
    result = await deps.runInstaller({
      mode: 'install', confirm: true, businessId, keyword: body.keyword, aliases: body.aliases, ackRoundTripToTeam: !!body.acknowledgeRoundTripTeam
    });
  } catch (error) {
    deps.logger.error(`quote flow: install failed for ${businessId}:`, error);
    result = { code: 1, lines: [`REFUSED: ${error.message || error}`], threw: true };
  }
  if (result.code !== 0) {
    // 2 = rows were written but the check afterwards disagreed: take them out again rather than leave a flow we could not verify.
    let undone = true;
    if (result.code === 2) {
      try { undone = (await deps.runInstaller({ mode: 'rollback', confirm: true, businessId })).code === 0; } catch (error) { undone = false; }
    }
    const restoreError = await restoreOverride(deps, businessId, prior);
    const reason = refusalOf(result.lines) || 'the flow could not be installed';
    return fail(result.code === 2 ? 500 : 409, 'INSTALL_FAILED',
      `Quotes were not enabled: ${reason}. Nothing was left half done${undone && !restoreError ? '' : ' - except: ' + [!undone && 'the new flow rows could not be removed', restoreError && 'the quotes switch could not be set back'].filter(Boolean).join(' and ') + ', please contact support'}.`,
      { readiness: await deps.getReadiness(businessId, entry).catch(() => readiness), blockers: [], log: result.lines });
  }
  return { ok: true, status: 200, message: 'Quotes enabled.', readiness: await deps.getReadiness(businessId, entry), log: result.lines };
};

/** @param {string} businessId @param {Object} [overrides] dependencies, for tests */
const disableQuoteFlow = async (businessId, overrides = {}) => {
  const deps = { ...defaultDeps(), ...overrides };
  if ((await deps.findProtectedBusinessIds()).includes(businessId)) return fail(403, 'PROTECTED_BUSINESS', PROTECTED_MESSAGE);

  let result;
  try {
    result = await deps.runInstaller({ mode: 'rollback', confirm: true, businessId });
  } catch (error) {
    deps.logger.error(`quote flow: rollback failed for ${businessId}:`, error);
    result = { code: 1, lines: [`REFUSED: ${error.message || error}`] };
  }
  if (result.code !== 0) {
    return fail(409, 'DISABLE_FAILED', `Quotes were not disabled: ${refusalOf(result.lines) || 'the quote flow could not be removed'}. The switch was left on.`, {
      readiness: await deps.getReadiness(businessId, {}).catch(() => null), log: result.lines
    });
  }
  if ((await deps.getOverride(businessId)) !== false) await deps.setOverride(businessId, false);
  return { ok: true, status: 200, message: 'Quotes disabled.', readiness: await deps.getReadiness(businessId, {}), log: result.lines };
};

module.exports = { FEATURE, PROTECTED_MESSAGE, enableQuoteFlow, disableQuoteFlow };
