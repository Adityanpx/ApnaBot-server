// src/scripts/revertSgTravelsReportTestData.js
//
// Undoes seedSgTravelsReportTestData.js from the snapshot file it wrote:
// restores each touched booking's status/fare_amount and each touched
// customer's tags to their exact prior values. SG Travels only — every
// write is filtered by the snapshot's business_id (asserted to be SG
// Travels) as well as the row id.
//
// Precondition-checked: aborts without writing unless every row still holds
// exactly the values the seed set, so a row edited since seeding (via the
// app or by hand) is never silently clobbered. updated_at can't be restored
// (the trg_set_updated_at trigger overrides it) — it is left bumped.
//
// Usage:
//   node src/scripts/revertSgTravelsReportTestData.js <snapshot.json>            (dry run)
//   node src/scripts/revertSgTravelsReportTestData.js <snapshot.json> --confirm   (executes)

require('dotenv').config();
const fs = require('fs');
const supabase = require('../config/supabase');

const SG_TRAVELS_ID = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';

const CONFIRM = process.argv.includes('--confirm');
const snapshotPath = process.argv.slice(2).find(arg => arg !== '--confirm');

const sameFare = (a, b) => (a === null || b === null ? a === b : Number(a) === Number(b));
const sameTags = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  if (!snapshotPath) {
    console.error('Usage: node src/scripts/revertSgTravelsReportTestData.js <snapshot.json> [--confirm]');
    process.exit(1);
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (snapshot.businessId !== SG_TRAVELS_ID) {
    console.error(`Snapshot business ${snapshot.businessId} is not SG Travels — aborting.`);
    process.exit(1);
  }

  const { data: bookings, error: bookingsErr } = await supabase
    .from('bookings')
    .select('id, business_id, status, fare_amount')
    .in('id', snapshot.bookings.map(b => b.id));
  if (bookingsErr) throw bookingsErr;
  const { data: customers, error: customersErr } = await supabase
    .from('customers')
    .select('id, business_id, name, tags')
    .in('id', snapshot.customers.map(c => c.id));
  if (customersErr) throw customersErr;

  const problems = [];
  const bookingById = Object.fromEntries(bookings.map(b => [b.id, b]));
  const customerById = Object.fromEntries(customers.map(c => [c.id, c]));

  console.log(`Snapshot ${snapshotPath} (seeded ${snapshot.createdAt})\n\nBookings:`);
  for (const entry of snapshot.bookings) {
    const row = bookingById[entry.id];
    if (!row) { problems.push(`booking ${entry.id} not found`); continue; }
    if (row.business_id !== SG_TRAVELS_ID) problems.push(`booking ${entry.id} belongs to ${row.business_id}`);
    if (row.status !== entry.seeded.status || !sameFare(row.fare_amount, entry.seeded.fare_amount)) {
      problems.push(`booking ${entry.id} is now status=${row.status} fare=${row.fare_amount}, not the seeded status=${entry.seeded.status} fare=${entry.seeded.fare_amount}`);
    }
    console.log(`  ${entry.id}  status ${row.status} -> ${entry.status}   fare_amount ${row.fare_amount} -> ${entry.fare_amount}`);
  }
  console.log('\nCustomers:');
  for (const entry of snapshot.customers) {
    const row = customerById[entry.id];
    if (!row) { problems.push(`customer ${entry.id} not found`); continue; }
    if (row.business_id !== SG_TRAVELS_ID) problems.push(`customer ${entry.id} belongs to ${row.business_id}`);
    if (!sameTags(row.tags, entry.seeded.tags)) {
      problems.push(`customer ${entry.id} tags are now ${JSON.stringify(row.tags)}, not the seeded ${JSON.stringify(entry.seeded.tags)}`);
    }
    console.log(`  ${entry.id}  "${row.name}"  tags ${JSON.stringify(row.tags)} -> ${JSON.stringify(entry.tags)}`);
  }

  if (problems.length > 0) {
    console.error('\nPrecondition failed — rows changed since seeding; aborting without writing:');
    problems.forEach(p => console.error(`  - ${p}`));
    process.exit(1);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  for (const entry of snapshot.bookings) {
    const { error } = await supabase
      .from('bookings')
      .update({ status: entry.status, fare_amount: entry.fare_amount })
      .eq('id', entry.id)
      .eq('business_id', SG_TRAVELS_ID);
    if (error) throw error;
  }
  for (const entry of snapshot.customers) {
    const { error } = await supabase
      .from('customers')
      .update({ tags: entry.tags })
      .eq('id', entry.id)
      .eq('business_id', SG_TRAVELS_ID);
    if (error) throw error;
  }
  console.log(`\nRestored ${snapshot.bookings.length} booking(s) and ${snapshot.customers.length} customer(s).`);

  console.log('\n=== Verification ===');
  const { data: afterBookings } = await supabase.from('bookings').select('id, status, fare_amount').in('id', snapshot.bookings.map(b => b.id));
  const { data: afterCustomers } = await supabase.from('customers').select('id, tags').in('id', snapshot.customers.map(c => c.id));
  console.log(JSON.stringify({ bookings: afterBookings, customers: afterCustomers }, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
