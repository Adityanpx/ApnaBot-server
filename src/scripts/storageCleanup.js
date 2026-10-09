// src/scripts/storageCleanup.js
//
// Storage cleanup (services/storageCleanup*.js), by hand.
//
// Dry-run by default: prints what a sweep would do - the open runs, how many of
// their items are due, and (with --retention) what the daily automatic chat-media
// run would mark - and writes / deletes nothing.
// --confirm really purges: it needs --run <runId>, so a manual run can never
// sweep every run. Only items whose 24h pending window has passed are touched,
// and every check of the sweeper still applies (re-check "in use", protected
// files, database first then R2).
//
// NEVER run --confirm against Search cab AI (a live production business with real
// customers) - check the run's items first (GET /runs/:id/export.csv, or the dry run).
//
// Touches R2 and ApnaBot's database only; never Meta / WhatsApp.
//
// Usage:
//   node src/scripts/storageCleanup.js                       (dry run: open runs + due items)
//   node src/scripts/storageCleanup.js --retention           (dry run: what the daily retention run would mark)
//   node src/scripts/storageCleanup.js --run <runId> --confirm

require('dotenv').config();

const supabase = require('../config/supabase');
const cleanup = require('../services/storageCleanup.service');
const sweeper = require('../services/storageCleanupSweeper.service');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const RUN_ID = argValue('--run');

const mb = (bytes) => `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB`;

async function main() {
  if (args.includes('--run') && !RUN_ID) throw new Error('--run needs a run id');
  if (CONFIRM && !RUN_ID) throw new Error('--confirm needs --run <runId> (a manual run never sweeps every run)');

  console.log(CONFIRM ? `Mode: PURGE (--confirm), run ${RUN_ID}` : 'Mode: dry run - nothing is written or deleted');

  const { data: runs, error } = await supabase.from('storage_cleanup_runs').select('*')
    .in('status', ['pending', 'purging']).order('created_at', { ascending: true });
  if (error) throw error;
  for (const r of runs || []) {
    const { count: due, error: dueErr } = await supabase.from('storage_cleanup_items').select('id', { count: 'exact', head: true })
      .eq('run_id', r.id).in('status', ['pending', 'failed']).lte('pending_delete_at', new Date().toISOString());
    if (dueErr) throw dueErr;
    console.log(`run ${r.id} [${r.status}${r.is_automatic ? ', automatic' : ''}] ${r.file_count} file(s), ${mb(r.total_bytes)}, purge at ${r.pending_delete_at}, due now: ${due}`);
  }
  if (!runs || runs.length === 0) console.log('No open runs.');

  if (args.includes('--retention')) {
    const days = await cleanup.getPlatformRetentionDays();
    console.log(`Platform chat media retention: ${days === null ? 'off' : `${days} days`} (per-business overrides apply)`);
  }

  if (!CONFIRM) {
    console.log('\nDry run only. Pass --run <runId> --confirm to purge that run\'s due items.');
    process.exit(0);
  }

  const summary = await sweeper.runTick({ runId: RUN_ID, retention: false });
  console.log('\nResult:', JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
