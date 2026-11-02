// Run: node --test src/utils/translationSlots.route.test.js
// travel_routes translation slots: what gets translated, fill-missing-only, the machine marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { routeSlots, isMissing, markAuto, autoTranslatedOf } = require('./translationSlots');

const route = (extra) => ({
  id: 'r1', from_city: 'pune', to_city: 'shirdi', from_label: null, to_label: 'Shirdi Sai', region: 'Western Maharashtra',
  from_label_translations: null, to_label_translations: null, region_translations: null, auto_translations: null, ...extra
});

test('routeSlots: the shown name (label, else the title-cased city) and the region, each a 24-character list row', () => {
  const slots = routeSlots(route());
  assert.deepEqual(slots.map((s) => [s.id, s.source, s.max]), [
    ['fromLabel', 'Pune', 24], ['toLabel', 'Shirdi Sai', 24], ['region', 'Western Maharashtra', 24]
  ]);
  assert.deepEqual(routeSlots(route({ region: null })).map((s) => s.id), ['fromLabel', 'toLabel']);
});

test('a slot writes into its own translations column only, and keeps the other languages', () => {
  const r = route({ to_label_translations: { hi: 'शिर्डी' } });
  const to = routeSlots(r).find((s) => s.id === 'toLabel');
  assert.equal(isMissing(to, 'hi'), false); // an existing translation (the owner's) is never refilled
  assert.equal(isMissing(to, 'gu'), true);
  to.set('gu', 'શિરડી');
  assert.deepEqual(r.to_label_translations, { hi: 'शिर्डी', gu: 'શિરડી' });
  assert.equal(r.from_label_translations, null);
});

test('staleTranslationReset: a changed label drops its old translations and machine marks; untouched or re-sent ones stay', () => {
  const { staleTranslationReset } = require('../services/travelRoute.service');
  const existing = route({
    to_label: 'Shirdi', to_label_translations: { mr: 'शिर्डी' }, region_translations: { mr: 'पश्चिम' },
    auto_translations: { toLabel: { mr: 'h1' }, region: { mr: 'h2' } }
  });
  assert.deepEqual(staleTranslationReset(existing, { to_label: 'Shirdi' }), {}, 'same text');
  assert.deepEqual(staleTranslationReset(existing, { is_active: false }), {}, 'label not sent');
  assert.deepEqual(staleTranslationReset(existing, { to_label: 'Sai Nagar' }), { to_label_translations: null, auto_translations: { region: { mr: 'h2' } } });
  assert.deepEqual(staleTranslationReset(existing, { to_label: 'Sai Nagar', to_label_translations: { mr: 'साई नगर' } }), {}, 'new translations sent with it');
  assert.deepEqual(staleTranslationReset(existing, { region: 'North', to_label: 'Shirdi' }), { region_translations: null, auto_translations: { toLabel: { mr: 'h1' } } });
});

test('markAuto badges a machine-filled translation until the owner edits it', () => {
  const r = route();
  const from = routeSlots(r).find((s) => s.id === 'fromLabel');
  from.set('mr', 'पुणे');
  markAuto(r, 'fromLabel', 'mr', 'पुणे');
  assert.deepEqual(autoTranslatedOf(r, routeSlots(r)), { fromLabel: ['mr'] });
  routeSlots(r).find((s) => s.id === 'fromLabel').set('mr', 'पुणे शहर'); // owner edit
  assert.deepEqual(autoTranslatedOf(r, routeSlots(r)), {});
});
