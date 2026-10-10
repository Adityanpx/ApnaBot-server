// Run: node --test src/services/booking.summaryBold.test.js
// The booking summary wraps each customer answer in *bold*; a stray space or
// line break inside the asterisks stops WhatsApp bolding it. Real
// buildBookingSummaryBody (pure) with the connection-opening modules stubbed.
const path = require('path');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(path.join(__dirname, relativePath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
stub('../config/redis', {});
stub('../config/supabase', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('../queues/sessionTimeout.queue', { addToSessionTimeoutQueue: async () => {} });
stub('./socket.service', {});
stub('./payment.service', {});
stub('./distanceMatrix.service', {});

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingSummaryBody } = require('./booking.service');

const fields = [
  { fieldKey: 'name', label: 'Name?', summaryLabel: 'Name' },
  { fieldKey: 'pickup', label: 'Pickup?', summaryLabel: 'Pickup' },
  { fieldKey: 'note', label: 'Note?', summaryLabel: 'Note' }
];

// The pre-change line builder, verbatim, as the oracle for clean answers.
const legacyLines = (collected, orderedFields) => orderedFields
  .map(f => {
    const value = collected[f.fieldKey];
    if (value === undefined || value === null || value === '') return null;
    const label = f.summaryLabel || f.label.replace('?', '');
    if (typeof value === 'object') {
      const displayValue = value.address || `https://maps.google.com/?q=${value.latitude},${value.longitude}`;
      return label + ': *' + displayValue + '*';
    }
    return label + ': *' + value + '*';
  })
  .filter(line => line !== null)
  .join('\n');

test('clean answers: output is byte-identical to the old builder', () => {
  const cases = [
    { name: 'Ravi', pickup: 'Pune Station', note: '2 bags, 1 child seat' },
    { name: 'Ravi Kumar', pickup: { address: 'MG Road, Pune', latitude: 1, longitude: 2 } },
    { name: 'Ravi', pickup: { latitude: 18.5, longitude: 73.8 } },
    { name: 'Ravi', note: 42 },
    { name: '', pickup: undefined, note: null },
    {}
  ];
  for (const collected of cases) {
    assert.equal(buildBookingSummaryBody(collected, fields, false), legacyLines(collected, fields));
  }
});

test('a trailing or leading space inside the bold is removed', () => {
  assert.equal(buildBookingSummaryBody({ name: ' Ravi ' }, fields, false), 'Name: *Ravi*');
});

test('a line break or run of spaces inside an answer becomes one space', () => {
  assert.equal(
    buildBookingSummaryBody({ name: 'Ravi\nKumar', pickup: 'Near  the\ttemple\n' }, fields, false),
    'Name: *Ravi Kumar*\nPickup: *Near the temple*'
  );
});

test('a location address is cleaned too', () => {
  assert.equal(
    buildBookingSummaryBody({ pickup: { address: ' MG Road,\nPune ', latitude: 1, longitude: 2 } }, fields, false),
    'Pickup: *MG Road, Pune*'
  );
});

test('an answer of only spaces is left out, like an empty one', () => {
  assert.equal(buildBookingSummaryBody({ name: 'Ravi', note: '   \n ' }, fields, false), 'Name: *Ravi*');
});
