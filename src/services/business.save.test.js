// Run: node --test src/services/business.save.test.js
// Business text that ends up in customer messages is trimmed on save:
// names/city collapse inner whitespace, the address keeps its line breaks.
// In-memory Supabase that records writes.
const test = require('node:test');
const assert = require('node:assert/strict');

let inserts; let updates;

const from = (table) => {
  let patch = null;
  const q = {
    select: () => q,
    eq: () => q,
    insert: (row) => { inserts.push({ table, row }); patch = row; return q; },
    update: (row) => { updates.push({ table, row }); patch = row; return q; },
    single: async () => ({ data: { id: 'b1', ...patch }, error: null }),
    then: (resolve) => resolve({ data: null, error: null })
  };
  return q;
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('../utils/crypto', { generateWebhookToken: () => 'x', encrypt: (t) => t });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('./usage.service', { getUsageForBusiness: async () => null });
const { createBusiness, updateBusiness, connectWhatsapp } = require('./business.service');

test.beforeEach(() => { inserts = []; updates = []; });

test('createBusiness trims name, display name, city and address', async () => {
  await createBusiness('u1', { name: ' PrimeCare  Health\nClinic ', displayName: ' PrimeCare ', city: ' Pune ', address: ' 12 MG Road\nNear Park ', businessCategory: 'general' });
  const row = inserts.find((i) => i.table === 'businesses').row;
  assert.equal(row.name, 'PrimeCare Health Clinic');
  assert.equal(row.display_name, 'PrimeCare');
  assert.equal(row.city, 'Pune');
  assert.equal(row.address, '12 MG Road\nNear Park');
});

test('createBusiness: display name defaults to the trimmed name', async () => {
  await createBusiness('u1', { name: 'PrimeCare ', businessCategory: 'general' });
  const row = inserts.find((i) => i.table === 'businesses').row;
  assert.equal(row.display_name, 'PrimeCare');
  assert.equal(row.address, undefined);
});

test('updateBusiness trims the same fields and leaves other values alone', async () => {
  await updateBusiness('b1', {
    name: ' PrimeCare ', displayName: 'Prime\tCare ', city: ' Pune', address: '  Line 1\nLine 2 ',
    fallbackReply: ' keep  as typed ', businessHours: 'Mon-Sat  9-6 ', enableSmartFallback: true
  });
  assert.deepEqual(updates.find((u) => u.table === 'businesses').row, {
    name: 'PrimeCare', display_name: 'Prime Care', city: 'Pune', address: 'Line 1\nLine 2',
    fallback_reply: ' keep  as typed ', business_hours: 'Mon-Sat  9-6 ', enable_smart_fallback: true
  });
});

test('updateBusiness: a null address stays null', async () => {
  await updateBusiness('b1', { address: null });
  assert.deepEqual(updates.find((u) => u.table === 'businesses').row, { address: null });
});

test('connectWhatsapp trims the display name from Meta and ignores a blank one', async () => {
  await connectWhatsapp('b1', { phoneNumberId: 'p', wabaId: 'w', whatsappNumber: '9198', accessToken: 't', displayName: ' SG Travels ' });
  assert.equal(updates[0].row.display_name, 'SG Travels');
  await connectWhatsapp('b1', { phoneNumberId: 'p', wabaId: 'w', whatsappNumber: '9198', accessToken: 't', displayName: '   ' });
  assert.equal('display_name' in updates[1].row, false);
});
