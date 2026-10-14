// src/scripts/cleanupBarePriceRazorpayPlanKeys.js
//
// One-time cleanup of plans.razorpay_plan_ids. Before plan ids were keyed by
// Razorpay key mode ("live:19900" / "test:19900"), they were keyed by bare price
// ("19900"). Those entries are never read any more; this removes them so only
// mode-keyed entries remain.
//
// A bare entry is removed only when ALL of these hold:
//   - Razorpay (current key) answers a clear 400 for its plan id. Any other
//     outcome - the id still resolves, a network error, 401, 5xx - means the
//     entry is skipped with the reason printed, never deleted.
//   - no subscriptions / businesses row mentions the plan id.
// Mode-keyed entries are never touched. Subscriptions rows are never touched.
//
// Dry-run by default (prints what it would do, writes nothing). Pass --confirm
// to execute.
//
// Usage:
//   node src/scripts/cleanupBarePriceRazorpayPlanKeys.js            (dry run)
//   node src/scripts/cleanupBarePriceRazorpayPlanKeys.js --confirm   (executes)

require('dotenv').config();

const Razorpay = require('razorpay');
const config = require('../config/env');
const supabase = require('../config/supabase');
const { getKeyMode } = require('../services/razorpaySubscriptions.service');

const CONFIRM = process.argv.includes('--confirm');
const BARE_KEY = /^\d+$/;

const mentions = (rows, planId) => rows.some(r => JSON.stringify(r).includes(planId));

async function main() {
  const mode = getKeyMode();
  console.log(`Razorpay key mode: ${mode}`);
  if (mode === 'unknown') throw new Error('RAZORPAY_KEY_ID must start with rzp_live_ or rzp_test_');

  const razorpay = new Razorpay({ key_id: config.RAZORPAY_KEY_ID, key_secret: config.RAZORPAY_KEY_SECRET });

  const { data: plans, error: planErr } = await supabase
    .from('plans').select('id, name, razorpay_plan_ids');
  if (planErr) throw planErr;
  const { data: subs, error: subErr } = await supabase.from('subscriptions').select('*');
  if (subErr) throw subErr;
  const { data: businesses, error: bizErr } = await supabase.from('businesses').select('*');
  if (bizErr) throw bizErr;

  let toDelete = 0;
  let skipped = 0;
  for (const plan of plans) {
    const ids = plan.razorpay_plan_ids || {};
    const bareKeys = Object.keys(ids).filter(k => BARE_KEY.test(k));
    console.log(`\nPlan "${plan.name}" (${plan.id})`);
    console.log(`  before: ${JSON.stringify(ids)}`);
    if (!bareKeys.length) { console.log('  no bare-price keys - nothing to do'); continue; }

    const remove = [];
    for (const key of bareKeys) {
      const rzpId = ids[key];
      let verdict;
      try {
        await razorpay.plans.fetch(rzpId);
        verdict = 'still resolves in Razorpay for the current key - keeping';
      } catch (err) {
        if (err?.statusCode !== 400) {
          verdict = `could not confirm (status=${err?.statusCode ?? 'none'}, ${err?.error?.description || err?.message}) - keeping`;
        } else if (mentions(subs, rzpId) || mentions(businesses, rzpId)) {
          verdict = 'Razorpay 400, but a subscriptions/businesses row references it - keeping';
        }
      }
      if (verdict) {
        skipped += 1;
        console.log(`  SKIP   ${key} -> ${rzpId}: ${verdict}`);
      } else {
        remove.push(key);
        console.log(`  DELETE ${key} -> ${rzpId}: Razorpay answered 400 (not found), no DB references`);
      }
    }
    if (!remove.length) continue;
    toDelete += remove.length;

    const after = Object.fromEntries(Object.entries(ids).filter(([k]) => !remove.includes(k)));
    console.log(`  after:  ${JSON.stringify(after)}`);
    if (CONFIRM) {
      const { error } = await supabase.from('plans').update({ razorpay_plan_ids: after }).eq('id', plan.id);
      if (error) throw error;
      console.log('  written');
    }
  }

  console.log(`\n${CONFIRM ? 'Deleted' : 'Would delete'} ${toDelete} entr${toDelete === 1 ? 'y' : 'ies'}; skipped ${skipped}.`);
  if (!CONFIRM) console.log('Dry run only - pass --confirm to write.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Cleanup failed:', err); process.exit(1); });
}
