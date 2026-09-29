// src/scripts/applyAiFlow.js
//
// Applies a generated flow (FlowSpec or questionnaire answers) to one
// business through the SAME code path as POST /api/flow-graph/ai/apply
// (aiFlow.service.js prepareApply/executeApply) — for testing on a real
// business without an owner JWT.
//
// Default is a DRY RUN: prints the 409/400 outcome or, if it would proceed,
// what would be created/deleted, the snapshot it would take, and every
// warning. Nothing is written. Pass --confirm to actually apply — that
// REPLACES the business's live WhatsApp flow immediately (snapshot first).
//
// Usage:
//   node src/scripts/applyAiFlow.js --business=<id> --answers=<file.json> [--confirm]
//   node src/scripts/applyAiFlow.js --business=<id> --spec=<file.json> [--confirm]
// Look the business id up fresh from the live businesses table by name —
// test-business ids change on delete/recreate (see PRD.md).

require('dotenv').config();
const fs = require('fs');
const aiFlowService = require('../services/aiFlow.service');
const { requireGraphEngine } = require('../middleware/flowGraph.middleware');

const arg = (name) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const main = async () => {
  const businessId = arg('business');
  const answersPath = arg('answers');
  const specPath = arg('spec');
  const confirm = process.argv.includes('--confirm');
  if (!businessId || (!answersPath === !specPath)) {
    throw new Error('Usage: --business=<id> and exactly one of --answers=<file> / --spec=<file> [--confirm]');
  }
  const body = answersPath
    ? { answers: JSON.parse(fs.readFileSync(answersPath, 'utf8')) }
    : { spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) };

  // Build req.graphBusiness with the real middleware rather than re-deriving it.
  const req = { user: { businessId } };
  let middlewareError = null;
  await new Promise(resolve => requireGraphEngine(req, {
    status: () => ({ json: (j) => { middlewareError = j.message; resolve(); } })
  }, (err) => { if (err) middlewareError = err.message; resolve(); }));
  if (middlewareError) throw new Error(`requireGraphEngine: ${middlewareError}`);

  console.log(`Business: ${businessId} (category "${req.graphBusiness.businessCategory}")`);
  console.log(`Mode: ${confirm ? 'CONFIRM — will replace the live flow' : 'DRY RUN — nothing will be written'}\n`);

  const prepared = await aiFlowService.prepareApply({ businessId, graphBusiness: req.graphBusiness, ...body });
  if (prepared.error) {
    console.log(`Would be refused: ${prepared.status} ${prepared.error}`);
    return 1;
  }

  const { compiled, currentRows } = prepared;
  console.log(`Current flow: ${currentRows.nodes.length} node(s), ${currentRows.edges.length} edge(s) -> ${currentRows.nodes.length > 0 ? 'snapshot "Before AI flow — <date>" first (not active), then all deleted' : 'empty, no snapshot needed'}`);
  console.log(`New flow: ${compiled.replyNodes.length} reply node(s), ${compiled.questionNodes.length} question node(s), ${compiled.edges.length} edge(s)`);
  for (const n of compiled.replyNodes) {
    console.log(`  reply  ${n.id.padEnd(22)} keyword="${n.keyword}" (${n.matchType}) ${n.replyKind}/${n.contentType}`);
  }
  for (const q of compiled.questionNodes) {
    console.log(`  question ${q.fieldKey.padEnd(20)} ${q.contentType}${q.required ? ' required' : ''}`);
  }
  console.log(`\nWarnings (${prepared.warnings.length}):`);
  prepared.warnings.forEach(w => console.log(`  - ${w}`));

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to apply.');
    return 0;
  }

  const result = await aiFlowService.executeApply({ businessId, graphBusiness: req.graphBusiness, prepared });
  if (result.error) {
    console.log(`\nApply REJECTED by saveFullGraph: ${result.status} ${result.error} (pre-apply snapshot removed)`);
    return 1;
  }
  console.log(`\nApplied. Snapshot: ${result.snapshot ? `${result.snapshot.name} (${result.snapshot.id})` : 'none (flow was empty)'}`);
  console.log(`Final warnings (${result.warnings.length}):`);
  result.warnings.forEach(w => console.log(`  - ${w}`));
  return 0;
};

main()
  .then(code => process.exit(code))
  .catch(err => { console.error('applyAiFlow failed:', err); process.exit(2); });
