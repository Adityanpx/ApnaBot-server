// scripts/testRazorpayPlansApi.js
//
// Manual REPL check for getOrCreateRazorpayPlan (razorpaySubscriptions.service.js).
// Not wired into npm scripts — run ad-hoc. Prefer Razorpay TEST MODE keys: it
// operates in whichever mode RAZORPAY_KEY_ID is (plan ids are keyed
// "<mode>:<paise>"), and with a rzp_live_ key --confirm creates a real live plan.
//
// Creating a Razorpay Plan is irreversible (Razorpay does not support
// editing or deleting Plans), and this writes to a real `plans` row's
// razorpay_plan_ids column — so this follows the repo's dry-run/--confirm
// pattern (see src/scripts/setAverixGraphEngine.js) rather than the
// original prompt's "fake plan object" sketch, which can't work: the
// persist step is now an RPC call requiring a real plan uuid.
//
// Usage:
//   node scripts/testRazorpayPlansApi.js                              (dry run, first active plan)
//   node scripts/testRazorpayPlansApi.js --planId=<uuid>               (dry run, specific plan)
//   node scripts/testRazorpayPlansApi.js --confirm                     (executes against first active plan)
//   node scripts/testRazorpayPlansApi.js --planId=<uuid> --confirm     (executes against specific plan)
//
// To prove idempotency (same price -> same Razorpay plan id, no duplicate
// created), run this script with --confirm twice in a row against the same
// plan: the first run creates+persists a plan_XXX id; the second run reads
// the now-persisted mapping back from the DB and returns the same id
// without calling Razorpay again.

require('dotenv').config();
const supabase = require('../src/config/supabase');
const razorpaySubscriptionsService = require('../src/services/razorpaySubscriptions.service');

const TEST_PRICE_PAISE = 29900; // ₹299.00
const CONFIRM = process.argv.includes('--confirm');
const PLAN_ID_ARG = process.argv.find(a => a.startsWith('--planId='));
const PLAN_ID = PLAN_ID_ARG ? PLAN_ID_ARG.split('=')[1] : null;

async function main() {
  const query = supabase.from('plans').select('*').eq('is_active', true);
  const { data: plan, error } = PLAN_ID
    ? await query.eq('id', PLAN_ID).maybeSingle()
    : await query.order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  if (!plan) {
    console.error(PLAN_ID
      ? `No active plan found with id ${PLAN_ID}. Aborting.`
      : 'No active plans found in the plans table. Aborting.');
    process.exit(1);
  }

  const mode = razorpaySubscriptionsService.getKeyMode();
  const priceKey = `${mode}:${TEST_PRICE_PAISE}`;
  console.log(`Razorpay key mode: ${mode}`);
  console.log('Target plan:');
  console.log(`  id:                ${plan.id}`);
  console.log(`  name:              ${plan.name}`);
  console.log(`  display_name:      ${plan.display_name}`);
  console.log(`  test price (paise):${TEST_PRICE_PAISE}`);
  console.log(`  razorpay_plan_ids: ${JSON.stringify(plan.razorpay_plan_ids)}`);
  console.log(`  already mapped for this price? ${plan.razorpay_plan_ids?.[priceKey] ? `yes -> ${plan.razorpay_plan_ids[priceKey]}` : 'no'}`);

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to actually call Razorpay + persist.');
    console.log('(If no mapping exists yet, --confirm will create a NEW, PERMANENT Razorpay Plan — Razorpay does not support editing/deleting Plans.)');
    process.exit(0);
  }

  const id = await razorpaySubscriptionsService.getOrCreateRazorpayPlan(plan, TEST_PRICE_PAISE);
  console.log(`\ngetOrCreateRazorpayPlan returned: ${id}`);

  const { data: after, error: afterErr } = await supabase
    .from('plans').select('razorpay_plan_ids').eq('id', plan.id).maybeSingle();
  if (afterErr) throw afterErr;
  console.log('Verification — plan row after call:');
  console.log(`  razorpay_plan_ids: ${JSON.stringify(after.razorpay_plan_ids)}`);
  console.log(after.razorpay_plan_ids?.[priceKey] === id ? 'PASS: persisted mapping matches returned id' : 'FAIL: persisted mapping does not match');

  console.log('\nRun this script again with --confirm to confirm idempotency (should return the same id, no new Razorpay Plan created — check the Razorpay test dashboard).');
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
