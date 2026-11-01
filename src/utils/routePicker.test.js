// Run: node --test src/utils/routePicker.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { view, choose, NO_REGION } = require('./routePicker');

const text = {
  more: { en: 'More...', translations: { hi: 'और देखें...', mr: 'आणखी...' } },
  other: { en: 'Other route', translations: { hi: 'अन्य रूट', mr: 'इतर मार्ग' } },
  otherPlaces: { en: 'Other places', translations: { hi: 'अन्य जगहें', mr: 'इतर ठिकाणे' } }
};

// n routes from pune; regionOf(i) gives each one's region
const routes = (n, regionOf = () => 'Area 1', from = 'pune') => Array.from({ length: n }, (_, i) => ({
  id: `r${i}`, fromCity: from, toCity: `city${i}`, fromLabel: null, toLabel: `City ${i}`, region: regionOf(i), sortOrder: i
}));
const values = (rows) => rows.map(r => r.value);
const labels = (rows) => rows.map(r => r.label);

test('up to 9 destinations: one flat list, cities then "Other route"; a single From is skipped', () => {
  for (const n of [1, 5, 9]) {
    const v = view(routes(n), undefined, text);
    assert.equal(v.promptKey, 'routePickerToPrompt');
    assert.equal(v.state.from, 'pune');
    assert.equal(v.rows.length, n + 1);
    assert.equal(v.rows.at(-1).value, 'other');
    assert.equal(values(v.rows).filter(x => x.startsWith('to:')).length, n);
  }
});

test('10 destinations in one region: no region step, 8 cities + More... + Other route', () => {
  const v = view(routes(10), undefined, text);
  assert.equal(v.promptKey, 'routePickerToPrompt');
  assert.equal(v.rows.length, 10);
  assert.deepEqual(values(v.rows).slice(-2), ['more', 'other']);
  const next = choose(routes(10), v.state, 'more', text);
  const page2 = view(routes(10), next.state, text);
  assert.deepEqual(values(page2.rows), ['to:r8', 'to:r9', 'other']);
});

test('10 and 11 destinations in several regions: regions first, then the cities of the chosen region', () => {
  for (const n of [10, 11]) {
    const rs = routes(n, i => (i < 6 ? 'West' : 'North'));
    const v = view(rs, undefined, text);
    assert.equal(v.promptKey, 'routePickerRegionPrompt');
    assert.deepEqual(values(v.rows), ['region:West', 'region:North', 'other']);
    const picked = choose(rs, v.state, 'region:North', text);
    const cities = view(rs, picked.state, text);
    assert.equal(cities.promptKey, 'routePickerToPrompt');
    assert.equal(cities.rows.length, n - 6 + 1);
    assert.ok(cities.rows.every(r => r.value === 'other' || rs.find(x => `to:${x.id}` === r.value).region === 'North'));
  }
});

test('routes with no region are grouped as "Other places"', () => {
  const rs = routes(11, i => (i < 5 ? 'West' : null));
  const v = view(rs, undefined, text);
  assert.deepEqual(labels(v.rows), ['West', 'Other places', 'Other route']);
  assert.equal(v.rows[1].value, `region:${NO_REGION}`);
  assert.deepEqual(v.rows[1].labelTranslations, text.otherPlaces.translations);
  const cities = view(rs, choose(rs, v.state, `region:${NO_REGION}`, text).state, text);
  assert.equal(cities.rows.length, 7);
});

test('more than 9 regions page with More... and every list stays within 10 rows / 24 characters', () => {
  const rs = routes(30, i => `Region ${i % 12}`);
  let v = view(rs, undefined, text);
  assert.equal(v.promptKey, 'routePickerRegionPrompt');
  assert.deepEqual(values(v.rows).slice(-2), ['more', 'other']);
  const seen = [];
  for (let guard = 0; guard < 5; guard++) {
    assert.ok(v.rows.length <= 10);
    assert.ok(v.rows.every(r => r.label.length <= 24));
    seen.push(...values(v.rows).filter(x => x.startsWith('region:')));
    if (!values(v.rows).includes('more')) break;
    v = view(rs, choose(rs, v.state, 'more', text).state, text);
  }
  assert.equal(new Set(seen).size, 12);
});

test('several From cities: asked first; the To list shows only that From\'s routes', () => {
  const rs = [...routes(3, () => 'A', 'pune'), ...routes(2, () => 'A', 'mumbai').map(r => ({ ...r, id: `m${r.id}`, sortOrder: r.sortOrder + 10 }))];
  const v = view(rs, undefined, text);
  assert.equal(v.promptKey, 'routePickerFromPrompt');
  assert.deepEqual(values(v.rows), ['from:pune', 'from:mumbai', 'other']);
  const to = view(rs, choose(rs, v.state, 'from:mumbai', text).state, text);
  assert.deepEqual(values(to.rows), ['to:mr0', 'to:mr1', 'other']);
});

test('choosing a city returns the route; "Other route" is reported; unknown rows are invalid', () => {
  const rs = routes(3);
  const v = view(rs, undefined, text);
  assert.equal(choose(rs, v.state, 'to:r1', text).route.id, 'r1');
  assert.deepEqual(choose(rs, v.state, 'other', text), { other: true });
  assert.deepEqual(choose(rs, v.state, 'to:gone', text), { invalid: true });
  assert.deepEqual(choose(rs, v.state, 'region:West', text), { invalid: true });
});

test('no routes: empty; labels fall back to the city key and are cut at 24 characters', () => {
  assert.equal(view([], undefined, text).empty, true);
  const long = [{ id: 'x', fromCity: 'pune', toCity: 'a very long destination name here', fromLabel: null, toLabel: null, region: null, sortOrder: 0 }];
  const v = view(long, undefined, text);
  assert.equal(v.rows[0].label.length, 24);
  assert.equal(v.rows[0].label, 'A Very Long Destination ');
});

test('row labels use the route label when set, in the routes\' sort order', () => {
  const rs = [
    { id: 'b', fromCity: 'pune', toCity: 'b', fromLabel: null, toLabel: 'Bravo', region: null, sortOrder: 2 },
    { id: 'a', fromCity: 'pune', toCity: 'a', fromLabel: null, toLabel: 'Alpha', region: null, sortOrder: 1 }
  ];
  assert.deepEqual(labels(view(rs, undefined, text).rows), ['Alpha', 'Bravo', 'Other route']);
});
