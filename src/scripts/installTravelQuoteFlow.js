// src/scripts/installTravelQuoteFlow.js
//
// Installs the chat travel-quote flow into ONE travel business's flow, additively (nothing existing is modified or
// deleted), or removes it again. All the logic is services/quoteFlowInstaller.service.js; read its header for what it
// writes, what it refuses and how it verifies. Dry-run by default (prints exactly what it would do, writes nothing);
// --confirm applies. A restore point is saved to the business's Versions tab before anything is written.
//
// Usage:
//   node src/scripts/installTravelQuoteFlow.js --business=<id>                         (dry run)
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --confirm
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --keyword=fare --aliases="get fare,rate"
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --menu-button            (also a first button on the main menu)
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --ack-round-trip-team    (Round Trip has no priceable route:
//                                                                                        those customers go to the owner's team)
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --rollback               (dry run: what would be removed)
//   node src/scripts/installTravelQuoteFlow.js --business=<id> --rollback --confirm
//   --expect-nodes=N --expect-edges=M   abort unless the plan has exactly these counts (copy from the dry run)
// --business is required: there is no default.
require('dotenv').config();

const installer = require('../services/quoteFlowInstaller.service');

const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const intArg = (name) => (argValue(name) === null ? null : Number(argValue(name)));

if (require.main === module) {
  const supabase = require('../config/supabase');
  const categoryFeatureService = require('../services/categoryFeature.service');
  const travelQuoteService = require('../services/travelQuote.service');
  const { createSnapshotFromRows } = require('../services/flowSnapshot.service');
  const { invalidateRulesCache } = require('../services/chatbot.service');

  const businessId = argValue('business');
  const aliases = argValue('aliases');
  installer.run({
    mode: process.argv.includes('--rollback') ? 'rollback' : 'install',
    confirm: process.argv.includes('--confirm'),
    businessId,
    menuButton: process.argv.includes('--menu-button'),
    keyword: argValue('keyword') || undefined,
    aliases: aliases === null ? undefined : aliases.split(',').map((a) => a.trim()).filter(Boolean),
    ackRoundTripToTeam: process.argv.includes('--ack-round-trip-team'),
    expectNodes: intArg('expect-nodes'),
    expectEdges: intArg('expect-edges')
  }, {
    supabase,
    isQuotesEnabled: (category, id) => categoryFeatureService.isEnabled(category, 'travel_quotes', id),
    listQuotableRoutes: (id, tripType) => travelQuoteService.listQuotableRoutes(id, tripType),
    invalidateCache: invalidateRulesCache,
    saveSnapshot: createSnapshotFromRows,
    findProtectedBusinessIds: () => installer.findProtectedBusinessIds(supabase),
    log: (line) => console.log(line)
  }).then((code) => process.exit(code)).catch((err) => {
    console.error('\nFAILED (nothing was partially written - the write is one transaction):', err.message || err);
    process.exit(1);
  });
}
