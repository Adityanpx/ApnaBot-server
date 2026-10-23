// src/scripts/backfillUsagePeriods.js
//
// One-time data step for the per-period message counter (migration 20261029120000_usage_periods.sql).
//
//  1. subscriptions.current_period_start for each business's current (active / trial) row:
//       - autopay row with a real cycle (end_date past the 48-hour placeholder window): end_date minus
//         one month - Razorpay's monthly cycle start. start_date is the checkout time, which can be
//         months ago on a long-running mandate.
//       - every other row: start_date.
//     Rows that already have a current_period_start are left alone.
//  2. usage_periods: this period's outbound_count, counted from messages (direction outbound,
//     sender_type bot / human - never phone_app echoes) since the period start. Existing usage_periods
//     rows are never overwritten (a re-run cannot lower a live count). Broadcast template sends have no
//     messages row, so they are not in the seeded number.
//
// Search cab AI (category 'travels', real WhatsApp customers) is SKIPPED on --confirm unless
// --include-live is passed, and even then it is seeded at 0, whatever the messages say.
//
// Dry-run by default: prints one row per business (plan, limit, old count, new count, OVER-LIMIT) and
// writes nothing. Pass --confirm to execute. Apply the migration first - --confirm stops if the column
// or table is missing (the dry run just notes it).
//
// "Old count" is the legacy usage table's msg_count for this India-time month (it is persisted every
// 10th message, so it can be up to 9 behind the Redis counter, and it counted inbound too).
//
// Usage:
//   node src/scripts/backfillUsagePeriods.js                          (dry run)
//   node src/scripts/backfillUsagePeriods.js --confirm                (executes, live business skipped)
//   node src/scripts/backfillUsagePeriods.js --confirm --include-live (also the live business, seeded 0)

require('dotenv').config();

const supabase = require('../config/supabase');
const { pickCurrentSubscription } = require('../services/currentSubscription.service');
const { resolvePeriod, addMonthsUtc } = require('../utils/usagePeriod');
const { istMonthKey } = require('../utils/ist');

const CONFIRM = process.argv.includes('--confirm');
const INCLUDE_LIVE = process.argv.includes('--include-live');
// subscription.service.js AUTOPAY_PENDING_WINDOW_MS, plus slack: an end_date inside this is the placeholder.
const PLACEHOLDER_WINDOW_MS = 49 * 60 * 60 * 1000;
const LIVE_NAME = /search\s*cab/i;

/** Pure: the current_period_start this row should get. */
const proposedPeriodStart = (sub) => {
  const start = new Date(sub.start_date);
  if (sub.is_autopay) {
    const end = new Date(sub.end_date);
    if (end.getTime() - start.getTime() > PLACEHOLDER_WINDOW_MS) {
      const cycleStart = addMonthsUtc(end, -1);
      return cycleStart.getTime() > start.getTime() ? cycleStart : start;
    }
  }
  return start;
};

const columnExists = async () => {
  const { error } = await supabase.from('subscriptions').select('current_period_start').limit(1);
  return !error;
};
const tableExists = async () => {
  const { error } = await supabase.from('usage_periods').select('business_id').limit(1);
  return !error;
};

const countOutbound = async (businessId, since) => {
  const { count, error } = await supabase.from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('direction', 'outbound')
    .in('sender_type', ['bot', 'human'])
    .gte('created_at', since.toISOString());
  if (error) throw error;
  return count || 0;
};

const pad = (value, width) => String(value).padEnd(width).slice(0, width);

const main = async () => {
  const hasColumn = await columnExists();
  const hasTable = await tableExists();
  if (CONFIRM && !(hasColumn && hasTable)) {
    console.error('Migration 20261029120000_usage_periods.sql is not applied (column subscriptions.current_period_start / table usage_periods missing). Apply it first.');
    process.exit(1);
  }
  if (!hasColumn || !hasTable) console.log('NOTE: migration 20261029120000_usage_periods.sql is not applied yet - dry run only.\n');

  const { data: businesses, error: bizErr } = await supabase.from('businesses').select('id, name, business_category').order('name');
  if (bizErr) throw bizErr;
  const { data: subs, error: subErr } = await supabase.from('subscriptions')
    .select('*, plan:plans(*)').in('status', ['active', 'trial']);
  if (subErr) throw subErr;
  const month = istMonthKey(new Date());
  const { data: oldRows, error: oldErr } = await supabase.from('usage').select('business_id, msg_count').eq('month', month);
  if (oldErr) throw oldErr;
  const oldCount = new Map((oldRows || []).map(r => [r.business_id, r.msg_count]));

  const now = new Date();
  const plan = [];
  for (const business of businesses) {
    const sub = pickCurrentSubscription((subs || []).filter(s => s.business_id === business.id), business.id);
    if (!sub) continue;
    const alreadySet = !!sub.current_period_start;
    const anchor = alreadySet ? new Date(sub.current_period_start) : proposedPeriodStart(sub);
    const period = resolvePeriod({ ...sub, current_period_start: anchor.toISOString() }, now);
    const isLive = LIVE_NAME.test(business.name || '');
    const counted = await countOutbound(business.id, period.periodStart);
    const limit = sub.plan?.msg_limit ?? null;
    plan.push({
      business, sub, anchor, alreadySet, period, isLive, counted,
      seed: isLive ? 0 : counted,
      limit,
      over: limit !== null && limit !== -1 && counted >= limit,
      old: oldCount.get(business.id) ?? 0
    });
  }

  console.log(`${CONFIRM ? 'CONFIRM' : 'DRY RUN'} - ${plan.length} businesses with an active/trial subscription (India month ${month})\n`);
  console.log([pad('business', 28), pad('plan', 10), pad('status', 6), pad('limit', 6), pad('old', 6), pad('new', 6), pad('period start', 16), pad('period end', 16), 'flags'].join(' '));
  for (const p of plan) {
    const flags = [
      p.over ? 'OVER-LIMIT' : '',
      p.isLive ? (INCLUDE_LIVE ? 'LIVE (seeded 0)' : 'LIVE (skipped on --confirm)') : '',
      p.alreadySet ? 'period start already set' : '',
      p.sub.is_autopay ? 'autopay' : ''
    ].filter(Boolean).join(', ');
    console.log([
      pad(p.business.name, 28), pad(p.sub.plan?.name ?? '?', 10), pad(p.sub.status, 6), pad(p.limit === -1 ? 'unltd' : p.limit ?? '?', 6),
      pad(p.old, 6), pad(p.counted, 6), pad(p.period.periodStart.toISOString().slice(0, 16), 16),
      pad(p.period.periodEnd ? p.period.periodEnd.toISOString().slice(0, 16) : '-', 16), flags
    ].join(' '));
  }

  if (!CONFIRM) {
    console.log('\nDry run - nothing written. Re-run with --confirm to apply.');
    return;
  }

  let written = 0;
  for (const p of plan) {
    if (p.isLive && !INCLUDE_LIVE) {
      console.log(`SKIP ${p.business.name} (live business; pass --include-live to include it, seeded 0)`);
      continue;
    }
    if (!p.alreadySet) {
      const { error } = await supabase.from('subscriptions')
        .update({ current_period_start: p.anchor.toISOString() }).eq('id', p.sub.id).is('current_period_start', null);
      if (error) throw error;
    }
    // ignoreDuplicates: an existing row (a live count) is never overwritten.
    const { error: seedErr } = await supabase.from('usage_periods').upsert({
      business_id: p.business.id,
      period_start: p.period.periodStart.toISOString(),
      period_end: p.period.periodEnd ? p.period.periodEnd.toISOString() : null,
      outbound_count: p.seed
    }, { onConflict: 'business_id,period_start', ignoreDuplicates: true });
    if (seedErr) throw seedErr;
    written += 1;
    console.log(`OK   ${p.business.name}: period ${p.period.periodStart.toISOString()} seeded ${p.seed}`);
  }
  console.log(`\nDone: ${written} businesses written.`);
};

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
}

module.exports = { proposedPeriodStart };
