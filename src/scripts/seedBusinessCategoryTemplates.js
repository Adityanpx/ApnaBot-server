// src/scripts/seedBusinessCategoryTemplates.js
//
// One-off seed for the business_category_templates table (see
// supabase/migrations/20260921120000_business_category_templates.sql).
// NOT auto-run on deploy — run manually when the 3 starter templates below
// need to be (re)seeded.
//
// These are SuperAdmin-owned starter templates for businesses.flow_fields
// (the web-form booking link's field config), applied to a business only
// via POST /api/admin/business-category-templates/:category/apply/:businessId
// — never auto-applied at business creation.
//
// `required` is intentionally omitted on every field below — not specified
// in the source spec, left for each business to set when they customize
// after applying.
//
// Two known gotchas, both intentional / already flagged to the user, not
// bugs to fix here:
//   - 'coaching'.course has options: [] on purpose (business fills in their
//     own course names) — this fails utils/flowFieldsValidation.js's
//     dropdown/radio >=2-option rule until the business edits it in, same
//     as any business that hasn't finished configuring their form yet.
//   - 'travels' fields intentionally carry no role beyond pickup/drop —
//     utils/flowFieldsValidation.js's ROLE_ALLOWED_TYPES has no
//     'travelDate' role, so one was not added here (see the existing
//     hardcoded travels starter template in business.controller.js, which
//     avoids the same role for the same reason).
//
// Usage:
//   node src/scripts/seedBusinessCategoryTemplates.js            (dry run)
//   node src/scripts/seedBusinessCategoryTemplates.js --confirm   (executes)

require('dotenv').config();
const supabase = require('../config/supabase');

const TEMPLATES = [
  {
    business_category: 'travels',
    label: 'Cab / Travel Booking',
    flow_fields: [
      { name: 'tripType', type: 'radio', label: 'Trip Type', options: ['One way', 'Round trip', 'Local rental'] },
      { name: 'pickup', type: 'address_autocomplete', label: 'Pickup Location', role: 'pickup' },
      { name: 'drop', type: 'address_autocomplete', label: 'Drop Location', role: 'drop' },
      { name: 'travelDate', type: 'date', label: 'Travel Date' },
      { name: 'returnDate', type: 'date', label: 'Return Date', visibleWhen: { field: 'tripType', equals: 'Round trip' } },
      { name: 'rentalHours', type: 'dropdown', label: 'Rental Package', options: ['4 hrs / 40 km', '8 hrs / 80 km', '12 hrs / 120 km'], visibleWhen: { field: 'tripType', equals: 'Local rental' } },
      { name: 'notes', type: 'textarea', label: 'Notes' }
    ],
    notes: null
  },
  {
    business_category: 'hotel',
    label: 'Hotel / Lodging',
    flow_fields: [
      { name: 'checkIn', type: 'date', label: 'Check-In Date' },
      { name: 'checkOut', type: 'date', label: 'Check-Out Date' },
      { name: 'roomType', type: 'dropdown', label: 'Room Type', options: ['Standard', 'Deluxe', 'Suite'] },
      { name: 'guests', type: 'dropdown', label: 'Guests', options: ['1', '2', '3', '4+'] },
      { name: 'notes', type: 'textarea', label: 'Notes' }
    ],
    notes: null
  },
  {
    business_category: 'coaching',
    label: 'Coaching / Tuition Classes',
    flow_fields: [
      { name: 'course', type: 'dropdown', label: 'Course', options: [] },
      { name: 'batchTiming', type: 'radio', label: 'Batch Timing', options: ['Morning', 'Evening'] },
      { name: 'studentName', type: 'text', label: 'Student Name' },
      { name: 'preferredDate', type: 'date', label: 'Preferred visit date for enrollment' }
    ],
    notes: null
  }
];

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  const { data: existing, error: existingErr } = await supabase
    .from('business_category_templates')
    .select('business_category, label, flow_fields, updated_at')
    .in('business_category', TEMPLATES.map(t => t.business_category));
  if (existingErr) throw existingErr;

  console.log('Existing rows for these categories:');
  console.log(existing && existing.length ? JSON.stringify(existing, null, 2) : '  (none)');

  console.log('\nWould upsert (by business_category):');
  TEMPLATES.forEach(t => {
    console.log(`  ${t.business_category}: label="${t.label}", ${t.flow_fields.length} fields`);
  });

  if (!CONFIRM) {
    console.log('\nDry run only — pass --confirm to execute.');
    process.exit(0);
  }

  const { data: upserted, error: upsertErr } = await supabase
    .from('business_category_templates')
    .upsert(TEMPLATES, { onConflict: 'business_category' })
    .select('id, business_category, label');
  if (upsertErr) throw upsertErr;

  console.log('\nUpserted:', JSON.stringify(upserted, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Script crashed:', err);
  process.exit(1);
});
