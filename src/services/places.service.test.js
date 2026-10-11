const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const places = require('./places.service');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
let calls;
const realGet = axios.get;
const setup = () => {
  calls = [];
  process.env.GOOGLE_MAPS_API_KEY = 'k';
  delete process.env.PLACES_COUNTRY;
  axios.get = async (url, cfg) => {
    calls.push({ url, params: cfg.params });
    return { data: { status: 'OK', predictions: [], result: { geometry: {}, address_components: [] } } };
  };
};
test.afterEach(() => { axios.get = realGet; });

test('autocomplete defaults to country:in', async () => {
  setup();
  await places.getAutocompletePredictions('pune');
  assert.equal(calls[0].params.components, 'country:in');
});

test('autocomplete joins multiple countries from PLACES_COUNTRY', async () => {
  setup();
  process.env.PLACES_COUNTRY = 'in, AE';
  await places.getAutocompletePredictions('pune');
  assert.equal(calls[0].params.components, 'country:in|country:ae');
});

test('location bias only when coordinates exist (no strictbounds)', async () => {
  setup();
  await places.getAutocompletePredictions('pune', { lat: 18.5, lng: 73.8 });
  assert.equal(calls[0].params.location, '18.5,73.8');
  assert.equal(calls[0].params.radius, 50000);
  assert.ok(!('strictbounds' in calls[0].params));
  await places.getAutocompletePredictions('pune', { lat: null, lng: null });
  await places.getAutocompletePredictions('pune');
  for (const c of calls.slice(1)) {
    assert.ok(!('location' in c.params));
    assert.ok(!('radius' in c.params));
  }
});

test('sessiontoken passed through when valid, dropped when invalid (both calls)', async () => {
  setup();
  await places.getAutocompletePredictions('pune', { sessionToken: UUID });
  await places.getPlaceDetails('pid', { sessionToken: UUID });
  assert.equal(calls[0].params.sessiontoken, UUID);
  assert.equal(calls[1].params.sessiontoken, UUID);
  await places.getAutocompletePredictions('pune', { sessionToken: 'nope' });
  await places.getPlaceDetails('pid', { sessionToken: 42 });
  await places.getPlaceDetails('pid');
  for (const c of calls.slice(2)) assert.ok(!('sessiontoken' in c.params));
});
