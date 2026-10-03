// src/scripts/runFollowupSweep.js
//
// Runs ONE follow-up sweep by hand (services/followupSweep.service.js) —
// for testing an automation without waiting for the server's 15-minute
// timer, and without ENABLE_FOLLOWUP_SWEEPER.
//
// Dry-run by default: finds who is due right now and prints who would get
// what (numbers masked) — claims nothing, sends nothing, writes nothing.
// --confirm really sends, and needs --business so a manual run can never
// sweep every business. All of the sweeper's checks still apply (business
// active + connected + subscribed, 'followups' switched on, send hours,
// caps, opt-out / block / pause).
//
// With --confirm this process also runs the WhatsApp send worker until its
// queued messages are sent: free-text follow-ups go through the
// whatsapp-outbound queue under THIS machine's QUEUE_NAMESPACE, which the
// production server's worker never reads.
//
// Usage:
//   node src/scripts/runFollowupSweep.js [--business <id>]            (dry run)
//   node src/scripts/runFollowupSweep.js --business <id> --confirm     (sends)

require('dotenv').config();

const supabase = require('../config/supabase');
const { runSweep } = require('../services/followupSweep.service');
const { maskNumber } = require('../utils/followup');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const businessArgAt = args.indexOf('--business');
const BUSINESS_ID = businessArgAt >= 0 ? args[businessArgAt + 1] : null;
const DRAIN_TIMEOUT_MS = 60 * 1000;

const waitForQueueDrain = async (queue) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DRAIN_TIMEOUT_MS) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
    if (counts.waiting + counts.active + counts.delayed === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
};

async function main() {
  if (businessArgAt >= 0 && !BUSINESS_ID) throw new Error('--business needs a business id');
  if (CONFIRM && !BUSINESS_ID) throw new Error('--confirm needs --business <id> (a manual run never sweeps every business)');

  if (BUSINESS_ID) {
    const { data: business, error } = await supabase.from('businesses')
      .select('id, name, business_category, is_active, is_whatsapp_connected').eq('id', BUSINESS_ID).maybeSingle();
    if (error) throw error;
    if (!business) throw new Error(`No business ${BUSINESS_ID}`);
    console.log(`Business: ${business.name} (${business.business_category}) active=${business.is_active} whatsapp=${business.is_whatsapp_connected}`);
  }
  console.log(CONFIRM ? 'Mode: SEND (--confirm)' : 'Mode: dry run — nothing is claimed or sent');

  // Started before the sweep so its queued text messages go out.
  const worker = CONFIRM ? require('../queues/whatsapp.worker') : null;

  const summary = await runSweep({ businessId: BUSINESS_ID, dryRun: !CONFIRM });

  for (const p of summary.planned) {
    console.log(`  would send [${p.automationName}] via ${p.via} → ${p.customerName || '(no name)'} ${maskNumber(p.customerNumber)}  (${p.triggerKey})`);
  }
  const { planned, ...rest } = summary;
  console.log('Summary:', JSON.stringify(rest, null, 2));

  if (worker) {
    const { whatsappQueue } = require('../queues/whatsapp.queue');
    const drained = await waitForQueueDrain(whatsappQueue);
    console.log(drained ? 'All queued WhatsApp messages processed.' : `Queue not empty after ${DRAIN_TIMEOUT_MS / 1000}s — check the messages' status in the chat.`);
    await worker.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Follow-up sweep failed:', err.message || err); process.exit(1); });
