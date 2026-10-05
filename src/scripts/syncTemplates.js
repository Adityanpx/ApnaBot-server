// src/scripts/syncTemplates.js
//
// Pulls one business's message templates from WhatsApp into message_templates
// (services/templateSync.service.js — the same sync as POST
// /api/message-templates/sync, without the cooldown).
//
// Default is a DRY RUN: reads Meta and the table, prints what would change,
// writes nothing. --confirm applies it.
//
// Usage:
//   node src/scripts/syncTemplates.js --business <businessId>
//   node src/scripts/syncTemplates.js --business <businessId> --confirm
//
// Requires .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY (see src/config/env.js).

require('dotenv').config();
const supabase = require('../config/supabase');
const businessService = require('../services/business.service');
const { syncBusinessTemplates } = require('../services/templateSync.service');

const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};

async function main() {
  const businessId = argValue('--business');
  const confirm = process.argv.includes('--confirm');
  if (!businessId) {
    console.error('Usage: node src/scripts/syncTemplates.js --business <businessId> [--confirm]');
    process.exit(1);
  }

  const business = await businessService.getBusinessById(businessId);
  if (!business) {
    console.error(`No business with id ${businessId}`);
    process.exit(1);
  }
  console.log(`Business: ${business.name} (${business.id}) category=${business.businessCategory} wabaId=${business.wabaId}`);
  console.log(confirm ? 'Mode: --confirm (WRITING)\n' : 'Mode: dry run (nothing is written; pass --confirm to apply)\n');

  const { data: sample, error } = await supabase.from('message_templates').select('*').eq('business_id', businessId).limit(1);
  if (error) throw error;
  if (sample && sample.length > 0 && !('source' in sample[0])) {
    console.log('NOTE: migration 20261005100000_message_templates_sync.sql is not applied yet - columns it adds are not compared, and --confirm would fail.\n');
  }

  const { summary, details } = await syncBusinessTemplates(business, { dryRun: !confirm });

  for (const d of details) {
    const extra = d.changes ? ` changes=[${d.changes.join(', ')}]` : d.reason ? ` (${d.reason})` : d.status ? ` status=${d.status} sendSupport=${d.sendSupport}` : '';
    console.log(`${d.action.padEnd(12)} ${d.name} [${d.language}]${extra}`);
  }
  if (details.length === 0) console.log('(nothing to create, update, adopt, delete or skip)');
  console.log('\nSummary:', JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed:', err.response?.data || err);
  process.exit(1);
});
