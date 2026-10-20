// src/scripts/replayUnicodeMatching.js
//
// READ-ONLY. Replays a business's most recent inbound text messages through the legacy and the
// Unicode keyword matcher (chatbot.service.js) and prints where they disagree, so a business can be
// checked before its unicode_matching flag is switched on. Nothing is written: no trigger counts, no
// messages, no flag. Customer phone numbers are never selected or printed; message text is
// truncated to 40 characters (long digit runs masked).
//
// Search cab AI is a LIVE production business and is refused (looked up by name).
//
// Usage:
//   node src/scripts/replayUnicodeMatching.js --business <business id> [--limit 1000]

require('dotenv').config();

// The matcher module pulls in the shared Redis client; stub it (as the tests do) so this script never
// opens a connection to the shared Redis Cloud instance.
require('../test-support/stubRedis');

const supabase = require('../config/supabase');
const { matchNodeInListDetailed, shadowReason } = require('../services/chatbot.service');
const { toCamelCase } = require('../utils/caseConvert');

const LIVE_BUSINESS_NAME = /search\s*cab/i;
const MAX_SAMPLES = 20;

const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};

const sample = (text) => String(text || '').slice(0, 40).replace(/\s+/g, ' ').replace(/\d{7,}/g, '#');

async function main() {
  const businessId = argValue('business');
  const limit = Math.min(Math.max(parseInt(argValue('limit') || '1000', 10) || 1000, 1), 20000);
  if (!businessId) throw new Error('Usage: node src/scripts/replayUnicodeMatching.js --business <id> [--limit 1000]');

  const { data: business, error: bizError } = await supabase
    .from('businesses').select('id, name, display_name').eq('id', businessId).maybeSingle();
  if (bizError) throw bizError;
  if (!business) throw new Error(`No business with id ${businessId}`);
  // Separate read: works before the unicode_matching migration is applied (shown as "not applied").
  const { data: flagRow, error: flagError } = await supabase
    .from('businesses').select('unicode_matching').eq('id', businessId).maybeSingle();
  business.unicode_matching = flagError ? 'column not applied yet' : (flagRow ? flagRow.unicode_matching : null);
  if (LIVE_BUSINESS_NAME.test(`${business.name || ''} ${business.display_name || ''}`)) {
    throw new Error(`Refusing: "${business.name}" is the live Search cab AI business. Replay a test business instead.`);
  }

  const { data: nodeRows, error: nodeError } = await supabase
    .from('flow_nodes').select('*').eq('business_id', businessId).eq('node_type', 'reply').eq('is_active', true);
  if (nodeError) throw nodeError;
  const nodes = (nodeRows || []).map(toCamelCase);

  const messages = [];
  for (let from = 0; messages.length < limit; from += 1000) {
    const pageSize = Math.min(1000, limit - messages.length);
    const { data, error } = await supabase.from('messages')
      .select('content')
      .eq('business_id', businessId).eq('direction', 'inbound').eq('type', 'text')
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    messages.push(...data);
    if (data.length < pageSize) break;
  }

  const flag = business.unicode_matching === null || business.unicode_matching === undefined ? 'NULL (follows global)' : business.unicode_matching;
  console.log(`Business: ${business.name} [${business.id}]  unicode_matching = ${flag}`);
  console.log(`Active reply nodes: ${nodes.length}   inbound text messages replayed: ${messages.length}`);

  const counts = { same: 0, empty: 0, native_only: 0, mixed_fallback: 0, different_node: 0, old_only: 0 };
  const samples = [];
  for (const { content } of messages) {
    if (!content || !String(content).trim()) { counts.empty += 1; continue; }
    const legacy = matchNodeInListDetailed(nodes, content, { unicode: false });
    const modern = matchNodeInListDetailed(nodes, content, { unicode: true });
    // unicodeOn=false: report every difference, as the flag-off shadow log does.
    const reason = shadowReason(content, legacy, modern, false);
    if (!reason) { counts.same += 1; continue; }
    counts[reason] += 1;
    if (samples.length < MAX_SAMPLES) {
      samples.push({
        reason,
        message: sample(content),
        old: legacy.node ? `${legacy.node.keyword} [${legacy.node.id}]` : null,
        new: modern.node ? `${modern.node.keyword} [${modern.node.id}]` : null
      });
    }
  }

  console.log('\nResult per message:');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(15)} ${v}`);
  const differing = counts.native_only + counts.mixed_fallback + counts.different_node + counts.old_only;
  const warn = counts.old_only ? '   (old_only > 0: the Unicode matcher would LOSE a reply legacy gives - review before enabling)' : '';
  console.log(`\nDifferences: ${differing} of ${messages.length}${warn}`);
  if (samples.length) {
    console.log(`\nFirst ${samples.length} difference(s):`);
    for (const s of samples) console.log(`  [${s.reason}] "${s.message}"  old: ${s.old || '-'}  new: ${s.new || '-'}`);
  }
  console.log('\nRead-only: nothing was written.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Replay failed:', err.message); process.exit(1); });
