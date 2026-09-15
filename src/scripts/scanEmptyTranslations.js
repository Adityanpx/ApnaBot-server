// src/scripts/scanEmptyTranslations.js
//
// Read-only diagnostic. No --confirm flag, no writes anywhere in this file —
// it only SELECTs and prints. Written to chase down the Marathi ("mr")
// greeting-send bug: getLocalizedText() (src/utils/localization.js) used to
// return an empty-string translation as-is instead of falling back to the
// untranslated field, and an empty interactive.body.text gets rejected by
// Meta. That function bug is already fixed; this script finds every actual
// row across every business that hit it (or could hit it for any other
// language), so real affected data can be confirmed before anything is
// changed.
//
// Scans every *_translations column that exists in the schema today
// (confirmed via supabase/migrations, not guessed):
//   - flow_nodes.label_translations                (jsonb: {lang: text})
//   - flow_nodes.options[].labelTranslations        (embedded per array entry)
//   - flow_edges.label_translations                 (jsonb: {lang: text})
//   - flow_edges.description_translations           (jsonb: {lang: text})
//   - businesses.welcome_message_translations       (jsonb: {lang: text})
// The legacy `rules`/`business_flows` tables (which also had translation
// jsonb) are fully dropped per PRD.md, not scanned here.
//
// "Empty" = matches the same check the localization.js fix now uses:
// String(value).trim() === '' after excluding null/undefined.
//
// Usage: node src/scripts/scanEmptyTranslations.js

require('dotenv').config();
const supabase = require('../config/supabase');

const PAGE_SIZE = 1000;

const isEmpty = (value) => value !== undefined && value !== null && String(value).trim() === '';

async function fetchAll(table, columns) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

async function main() {
  const businesses = await fetchAll('businesses', 'id, name, welcome_message_translations');
  const businessNameById = new Map(businesses.map(b => [b.id, b.name]));

  const findings = [];

  for (const business of businesses) {
    for (const [lang, value] of Object.entries(business.welcome_message_translations || {})) {
      if (isEmpty(value)) {
        findings.push({
          business: business.name, businessId: business.id,
          table: 'businesses', rowId: business.id,
          field: 'welcome_message_translations', language: lang,
          context: '(business welcome message)'
        });
      }
    }
  }

  const flowNodes = await fetchAll('flow_nodes', 'id, business_id, label, keyword, field_key, label_translations, options');
  for (const node of flowNodes) {
    for (const [lang, value] of Object.entries(node.label_translations || {})) {
      if (isEmpty(value)) {
        findings.push({
          business: businessNameById.get(node.business_id) || '(unknown)', businessId: node.business_id,
          table: 'flow_nodes', rowId: node.id,
          field: 'label_translations', language: lang,
          context: `label="${node.label}" keyword=${node.keyword || '(n/a)'} field_key=${node.field_key || '(n/a)'}`
        });
      }
    }
    (node.options || []).forEach((opt, index) => {
      if (!opt || typeof opt !== 'object') return;
      for (const [lang, value] of Object.entries(opt.labelTranslations || {})) {
        if (isEmpty(value)) {
          findings.push({
            business: businessNameById.get(node.business_id) || '(unknown)', businessId: node.business_id,
            table: 'flow_nodes', rowId: node.id,
            field: `options[${index}].labelTranslations`, language: lang,
            context: `node label="${node.label}" option label="${opt.label}" field_key=${node.field_key || '(n/a)'}`
          });
        }
      }
    });
  }

  const flowEdges = await fetchAll('flow_edges', 'id, business_id, label, description, label_translations, description_translations');
  for (const edge of flowEdges) {
    for (const [lang, value] of Object.entries(edge.label_translations || {})) {
      if (isEmpty(value)) {
        findings.push({
          business: businessNameById.get(edge.business_id) || '(unknown)', businessId: edge.business_id,
          table: 'flow_edges', rowId: edge.id,
          field: 'label_translations', language: lang,
          context: `edge label="${edge.label}"`
        });
      }
    }
    for (const [lang, value] of Object.entries(edge.description_translations || {})) {
      if (isEmpty(value)) {
        findings.push({
          business: businessNameById.get(edge.business_id) || '(unknown)', businessId: edge.business_id,
          table: 'flow_edges', rowId: edge.id,
          field: 'description_translations', language: lang,
          context: `edge description="${edge.description}"`
        });
      }
    }
  }

  console.log(`Scanned ${businesses.length} businesses, ${flowNodes.length} flow_nodes, ${flowEdges.length} flow_edges.\n`);

  if (findings.length === 0) {
    console.log('No empty-string translation values found.');
    process.exit(0);
  }

  console.log(`Found ${findings.length} empty-string translation value(s):\n`);
  findings.forEach((f, i) => {
    console.log(`${i + 1}. business=${f.business} (${f.businessId})`);
    console.log(`   table=${f.table} row=${f.rowId} field=${f.field} language=${f.language}`);
    console.log(`   context: ${f.context}`);
  });

  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
