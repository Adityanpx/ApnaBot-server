// Run: node --test src/utils/locationLabel.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { locationPinLabel } = require('./locationLabel');

test('name and address: "📍 name · address"', () => {
  assert.equal(locationPinLabel({ name: 'SG Travels', address: 'MG Road, Pune' }), '📍 SG Travels · MG Road, Pune');
});

test('only one of them: just that one', () => {
  assert.equal(locationPinLabel({ name: 'SG Travels' }), '📍 SG Travels');
  assert.equal(locationPinLabel({ address: 'MG Road, Pune', name: undefined }), '📍 MG Road, Pune');
});

test('neither (or nothing): "📍 Location"', () => {
  assert.equal(locationPinLabel({ latitude: 1, longitude: 2 }), '📍 Location');
  assert.equal(locationPinLabel({ name: '', address: null }), '📍 Location');
  assert.equal(locationPinLabel(undefined), '📍 Location');
});

test('coordinates never appear in the text', () => {
  assert.equal(locationPinLabel({ latitude: 18.5204, longitude: 73.8567, name: 'Shop' }).includes('18.52'), false);
});
