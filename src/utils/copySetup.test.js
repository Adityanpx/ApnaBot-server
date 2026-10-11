// Run: node --test src/utils/copySetup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCopySetupRequest,
  checkCopyCompatibility,
  findDanglingEdges,
  transformNodesForCopy,
  findHardcodedNameNodes,
  buildCopyWarnings
} = require('./copySetup');

const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const R2 = 'https://r2.test/';
const isStorageUrl = (u) => u.startsWith(R2);

const node = (over = {}) => ({
  id: 'n1', node_type: 'reply', keyword: 'hi', label: 'Hello', label_translations: null,
  image_url: null, media_id: null, image_removed_at: null, trigger_count: 7,
  latitude: null, longitude: null, location_name: null, address: null, form_fields: null,
  ...over
});

// ---- transformNodesForCopy ----------------------------------------------------------------

test('transform: per-node location override is cleared and counted', () => {
  const input = [
    node({ id: 'a', latitude: 18.5, longitude: 73.8, location_name: 'Hotel One', address: 'FC Road' }),
    node({ id: 'b' })
  ];
  const { nodes, locationsCleared } = transformNodesForCopy(input, { isStorageUrl });
  assert.equal(locationsCleared, 1);
  for (const f of ['latitude', 'longitude', 'location_name', 'address']) assert.equal(nodes[0][f], null);
});

test('transform: trigger_count is reset and the input rows are not mutated', () => {
  const input = [node({ trigger_count: 42, latitude: 1, longitude: 2 })];
  const { nodes } = transformNodesForCopy(input, { isStorageUrl });
  assert.equal(nodes[0].trigger_count, 0);
  assert.equal(input[0].trigger_count, 42);
  assert.equal(input[0].latitude, 1);
});

test('transform: form_fields (per-node service form) and unrelated columns carry over untouched', () => {
  const form = [{ name: 'course', label: 'Course', type: 'dropdown' }];
  const { nodes } = transformNodesForCopy([node({ reply_kind: 'web_form_trigger', form_fields: form, keyword: 'demo', position_x: 5 })], { isStorageUrl });
  assert.deepEqual(nodes[0].form_fields, form);
  assert.equal(nodes[0].reply_kind, 'web_form_trigger');
  assert.equal(nodes[0].keyword, 'demo');
  assert.equal(nodes[0].position_x, 5);
});

test('transform: media_id is always cleared; our own storage image_url is dropped and counted', () => {
  const input = [
    node({ id: 'a', media_id: ID_A, image_url: `${R2}business-media/x.png` }),
    node({ id: 'b', image_url: `${R2}business-media/y.png` }),
    node({ id: 'c', media_id: ID_A, image_url: null }),
    node({ id: 'd' })
  ];
  const { nodes, imagesDropped } = transformNodesForCopy(input, { isStorageUrl });
  assert.equal(imagesDropped, 3);
  for (const n of nodes) { assert.equal(n.media_id, null); assert.equal(n.image_url, null); }
});

test('transform: an external (non-storage) image_url is kept and not counted; image_removed_at is cleared', () => {
  const { nodes, imagesDropped } = transformNodesForCopy(
    [node({ image_url: 'https://example.com/p.png', image_removed_at: '2026-10-01T00:00:00Z' })], { isStorageUrl });
  assert.equal(imagesDropped, 0);
  assert.equal(nodes[0].image_url, 'https://example.com/p.png');
  assert.equal(nodes[0].image_removed_at, null);
});

// ---- findHardcodedNameNodes / buildCopyWarnings -------------------------------------------

test('hard-coded name: case-insensitive match on label and on label_translations values', () => {
  const nodes = [
    node({ id: 'a', label: 'Welcome to SG TRAVELS!' }),
    node({ id: 'b', label: 'Welcome', label_translations: { hi: 'स्वागत है sg travels में' } }),
    node({ id: 'c', label: 'Nothing here' })
  ];
  const hit = findHardcodedNameNodes(nodes, ['sg travels']);
  assert.deepEqual(hit.map(h => h.nodeId), ['a', 'b']);
});

test('hard-coded name: matches either name or display name; short/blank names are ignored', () => {
  const nodes = [node({ id: 'a', label: 'Call Suresh Cabs today' }), node({ id: 'b', label: 'ab cd' })];
  assert.equal(findHardcodedNameNodes(nodes, ['Legal Name Pvt', 'suresh cabs']).length, 1);
  assert.equal(findHardcodedNameNodes(nodes, ['ab', '  ', null, undefined]).length, 0);
});

test('{{businessName}} placeholder is not a hard-coded name', () => {
  assert.equal(findHardcodedNameNodes([node({ label: 'Welcome to {{businessName}}' })], ['SG Travels']).length, 0);
});

const baseWarningArgs = (over = {}) => ({
  include: { flow: true, serviceForm: false },
  sourceType: 'business',
  sourceNodes: [],
  sourceNames: ['SG Travels', null],
  target: { currentNodeCount: 0, hasFlowFields: false, flowFieldsCount: 0 },
  stats: { imagesDropped: 0, locationsCleared: 0 },
  sourceCounts: {},
  ...over
});

test('warnings: replace, images, pins and not-copied counts are all reported', () => {
  const w = buildCopyWarnings(baseWarningArgs({
    target: { currentNodeCount: 12, hasFlowFields: false, flowFieldsCount: 0 },
    stats: { imagesDropped: 3, locationsCleared: 2 },
    sourceCounts: { vehicles: 4, routeFares: 0, courses: 1, botSettings: 1 }
  }));
  assert.ok(w.includes('Target already has 12 nodes — they will be replaced (a restore point is saved first).'));
  assert.ok(w.includes('3 images will not be copied — re-upload them in the target business.'));
  assert.ok(w.includes('2 location pins cleared — target will use its own business address.'));
  assert.ok(w.includes('Source has 4 vehicles — vehicle carousels in the copied flow will be empty until the target adds vehicles.'));
  assert.ok(w.some(m => /^Source has 1 course —/.test(m)));
  assert.ok(w.some(m => /Bot Builder settings/.test(m)));
  assert.ok(!w.some(m => /route fare/.test(m)));
});

test('warnings: nothing to report gives an empty list', () => {
  assert.deepEqual(buildCopyWarnings(baseWarningArgs()), []);
});

test('warnings: hard-coded names list at most 10 labels and say how many more', () => {
  const nodes = Array.from({ length: 13 }, (_, i) => node({ id: `n${i}`, label: `SG Travels offer ${i}` }));
  const w = buildCopyWarnings(baseWarningArgs({ sourceNodes: nodes }));
  const line = w.find(m => /hard-coded/.test(m));
  assert.match(line, /13 node labels/);
  assert.equal((line.match(/"SG Travels offer/g) || []).length, 10);
  assert.match(line, /and 3 more/);
});

test('warnings: a template source never gets the name scan or the not-copied rows', () => {
  const w = buildCopyWarnings(baseWarningArgs({
    sourceType: 'template', sourceNodes: [node({ label: 'SG Travels' })], sourceNames: ['SG Travels'], sourceCounts: { vehicles: 9 }
  }));
  assert.deepEqual(w, []);
});

test('warnings: service form skipped for a template; replacing/emptying a service form is called out', () => {
  const skipped = buildCopyWarnings(baseWarningArgs({
    sourceType: 'template', include: { flow: true, serviceForm: false }, serviceFormSkipped: true
  }));
  assert.deepEqual(skipped, ['Service form was not copied: templates hold no service form fields.']);

  const replaced = buildCopyWarnings(baseWarningArgs({
    include: { flow: false, serviceForm: true },
    target: { currentNodeCount: 0, hasFlowFields: true, flowFieldsCount: 5 },
    sourceFormFields: 0
  }));
  assert.equal(replaced.length, 2);
  assert.match(replaced[0], /existing service form \(5 fields\) will be replaced/);
  assert.match(replaced[1], /Source has no service form fields/);
});

// ---- validation ---------------------------------------------------------------------------

const target = { id: ID_A, business_category: 'travels' };

test('validation: same source and target is rejected', () => {
  const r = checkCopyCompatibility({ sourceType: 'business', sourceRow: { id: ID_A, business_category: 'travels' }, target });
  assert.equal(r.status, 400);
  assert.match(r.message, /same business/);
});

test('validation: category mismatch is rejected for a business and for a template', () => {
  const b = checkCopyCompatibility({ sourceType: 'business', sourceRow: { id: ID_B, business_category: 'coaching' }, target });
  assert.equal(b.status, 400);
  assert.match(b.message, /Category mismatch/);
  const t = checkCopyCompatibility({
    sourceType: 'template', sourceRow: { id: ID_B, is_category_template: true, is_active: true, category: 'coaching' }, target
  });
  assert.equal(t.status, 400);
  assert.match(t.message, /Category mismatch/);
});

test('validation: inactive template is a 400, a non-template or missing source is a 404, a match passes', () => {
  const inactive = checkCopyCompatibility({
    sourceType: 'template', sourceRow: { id: ID_B, is_category_template: true, is_active: false, category: 'travels' }, target
  });
  assert.equal(inactive.status, 400);
  assert.match(inactive.message, /not active/);

  assert.equal(checkCopyCompatibility({ sourceType: 'template', sourceRow: null, target }).status, 404);
  assert.equal(checkCopyCompatibility({
    sourceType: 'template', sourceRow: { id: ID_B, is_category_template: false, is_active: true, category: null }, target
  }).status, 404);
  assert.equal(checkCopyCompatibility({ sourceType: 'business', sourceRow: null, target }).status, 404);

  assert.equal(checkCopyCompatibility({ sourceType: 'business', sourceRow: { id: ID_B, business_category: 'travels' }, target }), null);
  assert.equal(checkCopyCompatibility({
    sourceType: 'template', sourceRow: { id: ID_B, is_category_template: true, is_active: true, category: 'travels' }, target
  }), null);
});

test('request parsing: shape errors, at-least-one include, dryRun defaults to true', () => {
  const ok = { source: { type: 'business', id: ID_B }, include: { flow: true } };
  assert.equal(parseCopySetupRequest({ ...ok, include: { flow: false, serviceForm: false } }).error.status, 400);
  assert.equal(parseCopySetupRequest({ ...ok, source: { type: 'user', id: ID_B } }).error.status, 400);
  assert.equal(parseCopySetupRequest({ ...ok, source: { type: 'business', id: 'nope' } }).error.status, 400);
  assert.equal(parseCopySetupRequest({ ...ok, dryRun: 'yes' }).error.status, 400);
  assert.equal(parseCopySetupRequest(undefined).error.status, 400);

  const v = parseCopySetupRequest(ok).value;
  assert.equal(v.dryRun, true);
  assert.deepEqual(v.include, { flow: true, serviceForm: false });
  assert.equal(parseCopySetupRequest({ ...ok, dryRun: false }).value.dryRun, false);
});

test('findDanglingEdges: flags edges whose endpoints are not in the node list', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  assert.equal(findDanglingEdges(nodes, [{ from_node_id: 'a', to_node_id: 'b' }]).length, 0);
  assert.equal(findDanglingEdges(nodes, [{ from_node_id: 'a', to_node_id: 'zzz' }]).length, 1);
});
