// src/scripts/seedSgTravelsReportTestData.js
//
// Test-data seed for verifying the reports RPC migration
// (20260927120000_report_aggregate_rpcs.sql) — see
// verifyReportAggregates.js. As of 2026-09-27 no business had any tagged
// customer and SG Travels had zero confirmed/completed bookings, so the
// revenue and revenue-by-tag comparisons were 0 == 0 / [] == [] and proved
// nothing. This gives SG Travels (a test account) enough real-shaped data to
// exercise them:
//   - a customer with 2 tags (full revenue counted under both),
//   - a tagged customer with no qualifying bookings (revenue 0),
//   - a tagged customer whose only qualifying booking has a null fare,
//   - a qualifying booking for an untagged customer (in summary revenue,
//     excluded from revenue-by-tag),
//   - a decimal fare, and qualifying bookings in both the current and the
//     previous rolling week (so revenue growth is non-null).
//
// SG TRAVELS ONLY — every write is filtered by business_id = SG_TRAVELS_ID
// as well as the row id, and preconditions abort if any target row isn't an
// SG Travels row in its expected untouched state (status 'pending' /
// tags []).
//
// Only status/fare_amount (bookings) and tags (customers) are changed.
// updated_at is bumped by the trg_set_updated_at trigger and can't be
// restored through the API. It is recorded in the snapshot for reference
// only. Direct writes bypass app code, so no WhatsApp message is sent and
// customerPipeline.service.js's Converted transition does not fire.
//
// With --confirm, writes a snapshot of every touched row's prior values to
// logs/sgTravelsReportSeed-<timestamp>.json (and prints it), which
// revertSgTravelsReportTestData.js restores from.
//
// Usage:
//   node src/scripts/seedSgTravelsReportTestData.js            (dry run)
//   node src/scripts/seedSgTravelsReportTestData.js --confirm   (executes)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../config/supabase');

const SG_TRAVELS_ID = 'a94aec66-23fb-43e1-afcc-f4e8d518134b';

const BOOKING_CHANGES = [
  // Suresh Gavali (2 tags), 2026-09-24 — current week; decimal fare
  { id: '073a3e24-0028-4383-9cc9-127007da57d9', status: 'completed', fare_amount: 2780.5 },
  // Suresh Gavali (2 tags), 2026-09-19 — previous week
  { id: '4e728754-78a9-4ea8-a014-9ae8b8514b88', status: 'confirmed', fare_amount: 5610 },
  // govind kumbhar (1 tag), 2026-09-16 — previous week
  { id: 'e03ff311-c71f-4b88-9b41-02a11ad4cdb7', status: 'completed', fare_amount: 3690 },
  // OM CARS (untagged), 2026-09-17 — summary revenue only
  { id: '7227c6f2-2829-4eed-9afb-81a79d22dbb0', status: 'confirmed', fare_amount: 210 },
  // Sahyadri Travel Company (1 tag), 2026-09-07 — null fare counts as 0
  { id: 'fbca6277-a6c7-46b1-a2e5-975fa9222f43', status: 'confirmed', fare_amount: null }
];

const CUSTOMER_CHANGES = [
  { id: '62a7ff90-488d-465b-a069-6938e65f5832', tags: ['vip', 'corporate'] }, // Suresh Gavali
  { id: 'f1fe360a-0ebe-4d8c-a014-ef7ab1d17d84', tags: ['corporate'] },        // govind kumbhar
  { id: '32f744f0-6b1a-4f76-97c5-ca519b6056be', tags: ['vip'] },              // sachin — no qualifying bookings
  { id: '9c0c5e73-cdd7-455d-bc8a-3a9633d4e0d5', tags: ['airport'] }           // Sahyadri — null-fare booking
];

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: bookings, error: bookingsErr } = await supabase
    .from('bookings')
    .select('id, business_id, customer_id, status, fare_amount, created_at, updated_at, booking_code')
    .in('id', BOOKING_CHANGES.map(b => b.id));
  if (bookingsErr) throw bookingsErr;

  const { data: customers, error: customersErr } = await supabase
    .from('customers')
    .select('id, business_id, name, tags, updated_at')
    .in('id', CUSTOMER_CHANGES.map(c => c.id));
  if (customersErr) throw customersErr;

  const problems = [];
  const bookingById = Object.fromEntries(bookings.map(b => [b.id, b]));
  const customerById = Object.fromEntries(customers.map(c => [c.id, c]));

  console.log('Bookings (SG Travels):');
  for (const change of BOOKING_CHANGES) {
    const row = bookingById[change.id];
    if (!row) { problems.push(`booking ${change.id} not found`); continue; }
    if (row.business_id !== SG_TRAVELS_ID) problems.push(`booking ${change.id} belongs to ${row.business_id}, not SG Travels`);
    if (row.status !== 'pending') problems.push(`booking ${change.id} status is '${row.status}', expected 'pending'`);
    console.log(`  ${row.booking_code} ${row.id}  created ${row.created_at}  customer ${row.customer_id}`);
    console.log(`      status ${row.status} -> ${change.status}   fare_amount ${row.fare_amount} -> ${change.fare_amount}`);
  }

  console.log('\nCustomers (SG Travels):');
  for (const change of CUSTOMER_CHANGES) {
    const row = customerById[change.id];
    if (!row) { problems.push(`customer ${change.id} not found`); continue; }
    if (row.business_id !== SG_TRAVELS_ID) problems.push(`customer ${change.id} belongs to ${row.business_id}, not SG Travels`);
    if (!Array.isArray(row.tags) || row.tags.length !== 0) problems.push(`customer ${change.id} tags are ${JSON.stringify(row.tags)}, expected []`);
    console.log(`  ${row.id}  "${row.name}"  tags ${JSON.stringify(row.tags)} -> ${JSON.stringify(change.tags)}`);
  }

  if (problems.length > 0) {
    console.error('\nPrecondition failed — aborting without writing:');
    problems.forEach(p => console.error(`  - ${p}`));
    process.exit(1);
  }

  const snapshot = {
    createdAt: new Date().toISOString(),
    businessId: SG_TRAVELS_ID,
    bookings: BOOKING_CHANGES.map(c => {
      const row = bookingById[c.id];
      return { id: row.id, status: row.status, fare_amount: row.fare_amount, updated_at: row.updated_at, seeded: { status: c.status, fare_amount: c.fare_amount } };
    }),
    customers: CUSTOMER_CHANGES.map(c => {
      const row = customerById[c.id];
      return { id: row.id, tags: row.tags, updated_at: row.updated_at, seeded: { tags: c.tags } };
    })
  };

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    console.log(`Would update ${BOOKING_CHANGES.length} booking(s) and ${CUSTOMER_CHANGES.length} customer(s) listed above.`);
    process.exit(0);
  }

  const logsDir = path.join(__dirname, '..', '..', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const snapshotPath = path.join(logsDir, `sgTravelsReportSeed-${snapshot.createdAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nSnapshot of prior values written to ${snapshotPath}:`);
  console.log(JSON.stringify(snapshot, null, 2));

  for (const change of BOOKING_CHANGES) {
    const { error } = await supabase
      .from('bookings')
      .update({ status: change.status, fare_amount: change.fare_amount })
      .eq('id', change.id)
      .eq('business_id', SG_TRAVELS_ID);
    if (error) throw error;
  }
  for (const change of CUSTOMER_CHANGES) {
    const { error } = await supabase
      .from('customers')
      .update({ tags: change.tags })
      .eq('id', change.id)
      .eq('business_id', SG_TRAVELS_ID);
    if (error) throw error;
  }
  console.log(`\nUpdated ${BOOKING_CHANGES.length} booking(s) and ${CUSTOMER_CHANGES.length} customer(s).`);

  console.log('\n=== Verification ===');
  const { data: afterBookings } = await supabase.from('bookings').select('id, status, fare_amount').in('id', BOOKING_CHANGES.map(b => b.id));
  const { data: afterCustomers } = await supabase.from('customers').select('id, tags').in('id', CUSTOMER_CHANGES.map(c => c.id));
  console.log(JSON.stringify({ bookings: afterBookings, customers: afterCustomers }, null, 2));
  console.log(`\nTo revert: node src/scripts/revertSgTravelsReportTestData.js "${snapshotPath}"`);

  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
