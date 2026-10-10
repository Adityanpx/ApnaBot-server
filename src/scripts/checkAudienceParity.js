// src/scripts/checkAudienceParity.js
//
// Read-only check that the SQL function broadcast_audience (migration
// 20261007120000_broadcast_audience_builder.sql) selects exactly the customers
// broadcastAudience.service.js#resolveAudience (the real send path) does, for
// every audience type, on ONE real business, under both rules: MARKETING
// (opted-in only) and UTILITY (opted_in not required — migration
// 20261012120000_broadcast_audience_utility_optin.sql).
//
// For each audience case it prints how many customers the audience selects, how
// many will receive the broadcast and why the rest are skipped, then compares:
//   JS  = resolveAudience(...)                          (what a send reaches)
//   SQL = broadcast_audience rows with skip_reason NULL  (what the summary counts)
// and the summary function's counts against the SQL rows. Any difference lists
// the first few customer ids (numbers masked) and the script exits 1.
//
// customers.marketing_blocked_at (migration 20261014130000_customers_marketing_blocked.sql,
// the 'marketing_stopped' skip reason): the MARKETING cases only exercise that rule
// once some customer of the business has the column set. On a business where nobody
// does, every case passes vacuously for it - a pass proves nothing about that rule
// there. supabase/verification/verify_marketing_blocked.sql checks the rule itself on
// made-up rows.
//
// NEVER WRITES. There is no --confirm: it only reads customers, bookings,
// contact_groups and the two RPCs, so it is safe against any business — the
// live Search cab AI included — but it reads that business's customers, so run
// it on purpose. Apply the migration first; the script stops if the functions
// are missing.
//
// Cases are built from the business's real data: all customers; up to 300 of
// its customers picked by id (plus one id that doesn't exist); segments from
// the pipeline stages, last-message ages and tags it actually has; each of its
// groups and all of them; coaching demo/admission requests. Segment ages use
// "now", so a customer messaging in the middle of the run can show as a
// one-off difference — run it again before treating it as a bug.
//
// Usage:
//   node src/scripts/checkAudienceParity.js --business <businessId>
//
// Exit code: 0 all cases match, 1 a difference, 2 couldn't run (bad usage, the
// functions aren't there yet, a database error).

require('dotenv').config();

const supabase = require('../config/supabase');
const { resolveAudience, normalizeAudience, maskNumber, requiresMarketingOptIn, SKIP_REASONS } = require('../services/broadcastAudience.service');

// The template categories each case is checked under.
const CATEGORIES = ['MARKETING', 'UTILITY'];

const PAGE = 1000;
const PICKED_CUSTOMERS = 300;
const EXAMPLES = 5;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const usage = (message) => {
  if (message) console.error(`${message}\n`);
  console.error('Usage: node src/scripts/checkAudienceParity.js --business <businessId>\n(read-only; there is no --confirm)');
  process.exit(2);
};

const fetchAll = async (build) => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
};

const sqlRows = async (businessId, filter, params, category) => fetchAll(() => supabase
  .rpc('broadcast_audience', { p_business_id: businessId, p_filter: filter, p_params: params || {}, p_require_opt_in: requiresMarketingOptIn(category) })
  .order('customer_id', { ascending: true }));

const sqlSummary = async (businessId, filter, params, category) => {
  const { data, error } = await supabase.rpc('broadcast_audience_summary', { p_business_id: businessId, p_filter: filter, p_params: params || {}, p_require_opt_in: requiresMarketingOptIn(category) });
  if (error) throw error;
  return data;
};

/** The audience cases to compare, from this business's own data. */
const buildCases = async (businessId) => {
  const cases = [{ name: 'all_customers', filter: 'all_customers', params: null }];

  const customers = await fetchAll(() => supabase.from('customers')
    .select('id, pipeline_stage, tags, last_message_at').eq('business_id', businessId).order('id', { ascending: true }));
  console.log(`Business has ${customers.length} customers.`);

  const picked = customers.slice(0, PICKED_CUSTOMERS).map(c => c.id);
  if (picked.length > 0) {
    cases.push({ name: `customers (first ${picked.length} by id)`, filter: 'customers', params: { customerIds: picked } });
    cases.push({ name: 'customers (a few + an id that does not exist)', filter: 'customers', params: { customerIds: [...picked.slice(0, 5), MISSING_ID] } });
  }

  const stages = [...new Set(customers.map(c => c.pipeline_stage).filter(Boolean))].sort();
  for (const stage of stages) cases.push({ name: `segment pipelineStages [${stage}]`, filter: 'segment', params: { pipelineStages: [stage] } });
  if (stages.length > 1) cases.push({ name: `segment pipelineStages [${stages.join(', ')}]`, filter: 'segment', params: { pipelineStages: stages } });
  cases.push({ name: 'segment neverMessaged', filter: 'segment', params: { neverMessaged: true } });
  for (const days of [7, 30, 365]) cases.push({ name: `segment activeWithinDays ${days}`, filter: 'segment', params: { activeWithinDays: days } });

  const tagCounts = new Map();
  for (const c of customers) for (const t of Array.isArray(c.tags) ? c.tags : []) if (typeof t === 'string' && t.trim()) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  for (const t of topTags) cases.push({ name: `segment tags [${t}]`, filter: 'segment', params: { tags: [t] } });
  if (topTags.length > 1) cases.push({ name: `segment tags [${topTags.join(', ')}] (any)`, filter: 'segment', params: { tags: topTags } });
  if (topTags.length > 0 && stages.length > 0) {
    cases.push({ name: `segment tags [${topTags[0]}] + pipelineStages [${stages[0]}] + activeWithinDays 365`, filter: 'segment',
      params: { tags: [topTags[0]], pipelineStages: [stages[0]], activeWithinDays: 365 } });
  }
  if (topTags.length === 0) console.log('No customer has a tag, so no tag case: the tag filter is not exercised on this business.');

  const { data: groups, error: groupsErr } = await supabase.from('contact_groups').select('id, name').eq('business_id', businessId).order('name', { ascending: true }).limit(20);
  if (groupsErr) throw groupsErr;
  for (const g of groups || []) cases.push({ name: `groups [${g.name}]`, filter: 'groups', params: { groupIds: [g.id] } });
  if ((groups || []).length > 1) cases.push({ name: `groups [all ${groups.length}]`, filter: 'groups', params: { groupIds: groups.map(g => g.id) } });
  if ((groups || []).length === 0) console.log('No customer groups, so no groups case.');

  cases.push({ name: 'coaching_requests any (skip closed)', filter: 'coaching_requests', params: { form: 'any', course: null, skipClosed: true } });
  cases.push({ name: 'coaching_requests demo (keep closed)', filter: 'coaching_requests', params: { form: 'demo', course: null, skipClosed: false } });
  cases.push({ name: 'coaching_requests admission (skip closed)', filter: 'coaching_requests', params: { form: 'admission', course: null, skipClosed: true } });
  return cases;
};

const diff = (a, b) => [...a].filter(x => !b.has(x));

const runCase = async (businessId, testCase, numberById, category) => {
  const normalized = testCase.filter === 'customers' ? { filter: testCase.filter, params: testCase.params } : normalizeAudience(testCase.filter, testCase.params);
  if (normalized.error) throw new Error(`${testCase.name}: ${normalized.error}`);

  const js = new Set((await resolveAudience(businessId, normalized.filter, normalized.params, { category })).map(c => c.id));
  const rows = await sqlRows(businessId, normalized.filter, normalized.params, category);
  const sql = new Set(rows.filter(r => !r.skip_reason).map(r => r.customer_id));
  const counts = { selected: rows.length, willReceive: sql.size, skipped: Object.fromEntries(SKIP_REASONS.map(r => [r, rows.filter(x => x.skip_reason === r).length])) };
  const summary = await sqlSummary(businessId, normalized.filter, normalized.params, category);

  const problems = [];
  const onlyJs = diff(js, sql);
  const onlySql = diff(sql, js);
  const show = (ids) => ids.slice(0, EXAMPLES).map(id => `${id} (${maskNumber(numberById.get(id) || '')})`).join(', ');
  if (onlyJs.length > 0) problems.push(`${onlyJs.length} in resolveAudience but not SQL: ${show(onlyJs)}`);
  if (onlySql.length > 0) problems.push(`${onlySql.length} in SQL but not resolveAudience: ${show(onlySql)}`);
  const summaryOk = Number(summary.selected) === counts.selected && Number(summary.willReceive) === counts.willReceive
    && SKIP_REASONS.every(r => Number(summary.skipped[r]) === counts.skipped[r]);
  if (!summaryOk) problems.push(`summary function ${JSON.stringify(summary)} disagrees with the rows ${JSON.stringify(counts)}`);
  if (!requiresMarketingOptIn(category) && counts.skipped.not_opted_in !== 0) problems.push('a UTILITY audience skipped someone as not_opted_in');
  if (counts.selected !== counts.willReceive + Object.values(counts.skipped).reduce((x, y) => x + y, 0)) problems.push('selected != willReceive + skipped');

  const line = `selected ${counts.selected}, will receive ${counts.willReceive} (JS ${js.size}), skipped ${SKIP_REASONS.map(r => `${r} ${counts.skipped[r]}`).join(', ')}`;
  return { ok: problems.length === 0, line, problems };
};

const main = async () => {
  if (args.includes('--confirm')) usage('This script never writes, so it has no --confirm.');
  const businessId = argValue('--business');
  if (!businessId || businessId.startsWith('--')) usage('--business <businessId> is required.');

  const { data: business, error: businessErr } = await supabase.from('businesses').select('id, name, business_category').eq('id', businessId).maybeSingle();
  if (businessErr) throw businessErr;
  if (!business) usage(`No business with id ${businessId}.`);
  console.log(`Audience parity for ${business.name} (${business.business_category}) — read-only.\n`);

  const probe = await supabase.rpc('broadcast_audience_summary', { p_business_id: businessId, p_filter: 'all_customers', p_params: {}, p_require_opt_in: false });
  if (probe.error) {
    console.error(`Can't call broadcast_audience_summary: ${probe.error.message}\nApply supabase/migrations/20261007120000_broadcast_audience_builder.sql and 20261012120000_broadcast_audience_utility_optin.sql first.`);
    process.exit(2);
  }

  const numberRows = await fetchAll(() => supabase.from('customers').select('id, whatsapp_number').eq('business_id', businessId).order('id', { ascending: true }));
  const numberById = new Map(numberRows.map(r => [r.id, r.whatsapp_number]));

  const cases = await buildCases(businessId);
  let failed = 0;
  for (const category of CATEGORIES) {
    for (const testCase of cases) {
      const result = await runCase(businessId, testCase, numberById, category);
      console.log(`${result.ok ? 'OK  ' : 'FAIL'} [${category}] ${testCase.name}\n       ${result.line}`);
      for (const p of result.problems) console.log(`       ! ${p}`);
      if (!result.ok) failed += 1;
    }
  }
  const total = cases.length * CATEGORIES.length;
  console.log(`\n${total - failed} of ${total} cases match${failed > 0 ? `; ${failed} DIFFER` : ''}. Nothing was written.`);
  process.exit(failed > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error('Parity check failed:', error && error.message ? error.message : error);
  process.exit(2);
});
