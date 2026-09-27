// src/scripts/backfillInboundInteractiveLabels.js
//
// One-time data fix for inbound 'interactive' messages saved before
// webhook.controller.js started storing the tapped TITLE (2026-09-28): their
// messages.content holds the reply id instead, which the inbox shows
// verbatim ("lang_mr", "401f8a86-…"). Rewrites content to the label the
// customer saw, in their preferred language where a translation exists:
//
//   lang_<code>            → LANGUAGE_CATALOG[code].name ("मराठी")
//   <flow_edges.id>        → the edge's label / label_translations
//                            (rule buttons + list rows, sendInteractiveButtons)
//   <flow_nodes.id>:<n>    → option n of that question node's options
//                            (booking-field buttons/lists, "{step}:{index}")
//   <flow_nodes.id>:other  → "Other"
//
// Labels come from the CURRENT flow data, so an edge/option renamed since the
// tap shows its new label; ids whose edge/node no longer exists, and
// computed-option nodes (vehicle carousel etc., options aren't stored), are
// left untouched and counted as "unresolved". Scoped to direction='inbound'
// AND type='interactive' only — never touches outbound or text messages.
//
// Dry-run by default (prints counts + sample rewrites, writes nothing). Pass
// --confirm to execute.
//
// Usage:
//   node src/scripts/backfillInboundInteractiveLabels.js            (dry run)
//   node src/scripts/backfillInboundInteractiveLabels.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');
const { LANGUAGE_CATALOG } = require('../utils/languageCatalog');

const CONFIRM = process.argv.includes('--confirm');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fetchAll = async (build) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
};

const fetchByIds = async (table, columns, ids) => {
  const rows = [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await supabase.from(table).select(columns).in('id', list.slice(i, i + 200));
    if (error) throw error;
    rows.push(...data);
  }
  return new Map(rows.map((r) => [r.id, r]));
};

const translated = (label, translations, lang) => {
  const t = lang && translations ? translations[lang] : null;
  return t && String(t).trim() ? t : label;
};

async function main() {
  const messages = await fetchAll(() =>
    supabase.from('messages')
      .select('id, content, customer_id')
      .eq('direction', 'inbound')
      .eq('type', 'interactive')
      .order('created_at'));

  const edgeIds = new Set();
  const nodeIds = new Set();
  for (const m of messages) {
    const c = m.content || '';
    if (UUID.test(c)) edgeIds.add(c);
    const step = c.match(/^([0-9a-f-]{36}):(\d+|other)$/i);
    if (step) nodeIds.add(step[1]);
  }

  const edges = await fetchByIds('flow_edges', 'id, label, label_translations', edgeIds);
  const nodes = await fetchByIds('flow_nodes', 'id, options, is_computed', nodeIds);
  const customers = await fetchByIds('customers', 'id, preferred_language', new Set(messages.map((m) => m.customer_id)));

  const updates = [];
  const counts = { lang: 0, edge: 0, option: 0, unresolved: 0, alreadyReadable: 0 };

  for (const m of messages) {
    const c = m.content || '';
    const lang = customers.get(m.customer_id)?.preferred_language || null;
    let label = null;

    const langMatch = c.match(/^lang_([a-z]{2})$/);
    const step = c.match(/^([0-9a-f-]{36}):(\d+|other)$/i);
    if (langMatch) {
      label = LANGUAGE_CATALOG[langMatch[1]]?.name || null;
      if (label) counts.lang++;
    } else if (UUID.test(c)) {
      const edge = edges.get(c);
      if (edge?.label) { label = translated(edge.label, edge.label_translations, lang); counts.edge++; }
    } else if (step) {
      const node = nodes.get(step[1]);
      if (step[2].toLowerCase() === 'other') {
        label = 'Other'; counts.option++;
      } else if (node && !node.is_computed && Array.isArray(node.options)) {
        const opt = node.options[Number(step[2])];
        if (typeof opt === 'string') label = opt;
        else if (opt) label = translated(opt.label ?? opt.value, opt.labelTranslations, lang);
        if (label) counts.option++;
      }
    } else {
      counts.alreadyReadable++;
      continue;
    }

    if (label && label !== c) updates.push({ id: m.id, from: c, to: label });
    else if (!label) counts.unresolved++;
  }

  console.log(`Inbound interactive messages scanned: ${messages.length}`);
  console.log(`  language buttons: ${counts.lang}, flow buttons/list rows: ${counts.edge}, booking options: ${counts.option}`);
  console.log(`  unresolved (edge/node deleted or computed options): ${counts.unresolved}`);
  console.log(`  already readable / empty: ${counts.alreadyReadable}`);
  console.log(`Rows to update: ${updates.length}`);
  for (const u of updates.slice(0, 12)) console.log(`  ${u.from}  →  ${u.to}`);

  if (!CONFIRM) {
    console.log('\nDry run — nothing written. Re-run with --confirm to apply.');
    return;
  }

  let done = 0;
  for (const u of updates) {
    const { error } = await supabase.from('messages').update({ content: u.to }).eq('id', u.id).eq('content', u.from);
    if (error) throw error;
    done++;
  }
  console.log(`\nUpdated ${done} messages.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
