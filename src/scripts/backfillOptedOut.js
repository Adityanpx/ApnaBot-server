// src/scripts/backfillOptedOut.js
//
// One-time data fix for customers.opted_out_at (migration
// 20261003120000_followup_automations.sql). Until then STOP / UNSUBSCRIBE
// only paused the bot for 24 hours, so customers who sent it earlier have no
// lasting opt-out and would still get broadcasts and follow-ups.
//
// A customer counts as opted out when their LATEST inbound 'stop' or
// 'unsubscribe' has no inbound 'start' after it; opted_out_at is set to that
// message's time. Matching mirrors webhook.controller.js's STOP_KEYWORDS /
// START_KEYWORDS: plain text messages only (type 'text' — a button or list
// tap never counts), content trimmed and lowercased, exact match.
// Customers who already have opted_out_at are skipped, and the write only
// lands while it is still null (a STOP/START arriving meanwhile wins).
//
// Dry-run by default (prints per business the count and the customers, with
// the middle of each number masked; writes nothing). Pass --confirm to
// execute. Apply the migration first — the script stops if the column is
// missing.
//
// Usage:
//   node src/scripts/backfillOptedOut.js            (dry run)
//   node src/scripts/backfillOptedOut.js --confirm   (executes)

require('dotenv').config();

const supabase = require('../config/supabase');

const CONFIRM = process.argv.includes('--confirm');
const STOP_WORDS = new Set(['stop', 'unsubscribe']);
const START_WORDS = new Set(['start']);
const PAGE = 1000;
const ID_CHUNK = 500;

const maskNumber = (n) => {
  const s = String(n || '');
  return s.length <= 6 ? s.replace(/\d(?=\d{2})/g, '*') : `${s.slice(0, 4)}${'*'.repeat(s.length - 7)}${s.slice(-3)}`;
};

/** Inbound plain-text messages that might be STOP / UNSUBSCRIBE / START, oldest first. */
const fetchKeywordMessages = async () => {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('messages')
      .select('id, business_id, customer_id, content, created_at')
      .eq('direction', 'inbound')
      .eq('type', 'text')
      .or('content.ilike.%stop%,content.ilike.%unsubscribe%,content.ilike.%start%')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  // The ilike above is only a coarse pre-filter; this is the real match.
  return rows
    .map(r => ({ ...r, word: (r.content || '').trim().toLowerCase() }))
    .filter(r => STOP_WORDS.has(r.word) || START_WORDS.has(r.word));
};

/** customer_id → time of their latest STOP with no START after it. */
const findOptedOut = (messages) => {
  const latest = new Map(); // customer_id → { stopAt, startAfter }
  for (const m of messages) { // oldest first
    const entry = latest.get(m.customer_id) || { stopAt: null, startAfter: false };
    if (STOP_WORDS.has(m.word)) {
      entry.stopAt = m.created_at;
      entry.startAfter = false;
    } else if (entry.stopAt) {
      entry.startAfter = true;
    }
    latest.set(m.customer_id, entry);
  }
  const result = new Map();
  for (const [customerId, e] of latest) {
    if (e.stopAt && !e.startAfter) result.set(customerId, e.stopAt);
  }
  return result;
};

const fetchCustomers = async (ids) => {
  const customers = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabase.from('customers')
      .select('id, business_id, whatsapp_number, opted_out_at')
      .in('id', ids.slice(i, i + ID_CHUNK));
    if (error) throw error;
    customers.push(...data);
  }
  return customers;
};

async function main() {
  const { error: columnErr } = await supabase.from('customers').select('opted_out_at').limit(1);
  if (columnErr) {
    throw new Error(`customers.opted_out_at not readable — apply 20261003120000_followup_automations.sql first (${columnErr.message})`);
  }

  const messages = await fetchKeywordMessages();
  const optedOut = findOptedOut(messages);
  console.log(`Inbound STOP/UNSUBSCRIBE/START text messages: ${messages.length}; customers whose latest STOP has no START after it: ${optedOut.size}`);

  const customers = await fetchCustomers([...optedOut.keys()]);
  const alreadySet = customers.filter(c => c.opted_out_at);
  const todo = customers.filter(c => !c.opted_out_at);
  if (alreadySet.length) console.log(`Skipping ${alreadySet.length} customer(s) that already have opted_out_at.`);

  const { data: businesses, error: bizErr } = await supabase.from('businesses').select('id, name');
  if (bizErr) throw bizErr;
  const nameOf = new Map((businesses || []).map(b => [b.id, b.name]));

  const byBusiness = new Map();
  for (const c of todo) {
    if (!byBusiness.has(c.business_id)) byBusiness.set(c.business_id, []);
    byBusiness.get(c.business_id).push(c);
  }
  for (const [businessId, list] of byBusiness) {
    console.log(`\n${nameOf.get(businessId) || '(unknown business)'} [${businessId}]: ${list.length}`);
    for (const c of list) {
      console.log(`  ${c.id}  ${maskNumber(c.whatsapp_number)}  opted_out_at → ${optedOut.get(c.id)}`);
    }
  }
  console.log(`\nTotal to set: ${todo.length}`);

  if (!CONFIRM) {
    console.log('Dry run — nothing written. Re-run with --confirm to apply.');
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const c of todo) {
    const { data, error } = await supabase.from('customers')
      .update({ opted_out_at: optedOut.get(c.id) })
      .eq('id', c.id)
      .is('opted_out_at', null)
      .select('id');
    if (error) throw error;
    if (data && data.length) written += 1; else skipped += 1;
  }
  console.log(`Wrote opted_out_at for ${written} customer(s)${skipped ? `; ${skipped} changed meanwhile and were left alone` : ''}.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Backfill failed:', err); process.exit(1); });
}

module.exports = { findOptedOut, maskNumber };
