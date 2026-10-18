// Run: node --test src/services/flowSnapshot.carousel.test.js
// carousel_cards (nodes) and card_index (edges) survive a snapshot restore and a copy into another
// business; a copy keeps each card's text and buttons but drops the SOURCE business's media ids (a carousel
// arriving without photos then sends its per-card text + buttons, see carouselPayload.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const inserted = {};
const supabasePath = require.resolve('../config/supabase');
require.cache[supabasePath] = {
  exports: { from: (table) => ({ insert: async (rows) => { inserted[table] = rows; return { error: null }; } }) },
  loaded: true, id: supabasePath, filename: supabasePath
};
const { writeBusinessGraphRows } = require('./flowSnapshot.service');
const { transformNodesForCopy } = require('../utils/copySetup');

const CARDS = [
  { media_id: 'm1', media_type: 'image', body: 'Deluxe', body_translations: { hi: 'डीलक्स' } },
  { media_id: 'm2', media_type: 'video', body: 'Suite', body_translations: null }
];
const nodes = [
  { id: 'car', node_type: 'reply', content_type: 'carousel', label: 'Rooms', carousel_cards: CARDS, media_id: null, image_url: null },
  { id: 't', node_type: 'reply', content_type: 'text', label: 'Details' }
];
const edges = [
  { id: 'e1', from_node_id: 'car', to_node_id: 't', label: 'Book', card_index: 0 },
  { id: 'e2', from_node_id: 'car', to_node_id: 't', label: 'Book', card_index: 1 }
];

test('restore (same ids): carousel_cards and card_index are written back verbatim', async () => {
  await writeBusinessGraphRows('biz', nodes, edges, { reuseIds: true, resetTriggerCount: false });
  assert.deepEqual(inserted.flow_nodes[0].carousel_cards, CARDS);
  assert.deepEqual(inserted.flow_edges.map(e => [e.id, e.card_index]), [['e1', 0], ['e2', 1]]);
});

test('copy into another business (fresh ids): cards and card_index survive the id remap', async () => {
  await writeBusinessGraphRows('other', nodes, edges, { reuseIds: false, resetTriggerCount: true });
  const [car] = inserted.flow_nodes;
  assert.deepEqual(car.carousel_cards, CARDS);
  assert.notEqual(car.id, 'car');
  assert.deepEqual(inserted.flow_edges.map(e => [e.card_index, e.from_node_id === car.id]), [[0, true], [1, true]]);
});

test('a row stored before carousel existed (no carousel_cards / card_index keys) writes as-is', async () => {
  await writeBusinessGraphRows('biz', [{ id: 'a', node_type: 'reply' }], [{ id: 'x', from_node_id: 'a', to_node_id: 'a' }], { reuseIds: false, resetTriggerCount: true });
  assert.equal('carousel_cards' in inserted.flow_nodes[0], false);
  assert.equal(inserted.flow_edges[0].card_index, undefined);
});

test('copy transform: card media ids cleared, text / translations / types kept, other nodes untouched', () => {
  const { nodes: out, imagesDropped } = transformNodesForCopy(nodes, { isStorageUrl: () => false });
  assert.deepEqual(out[0].carousel_cards, [
    { media_id: null, media_type: 'image', body: 'Deluxe', body_translations: { hi: 'डीलक्स' } },
    { media_id: null, media_type: 'video', body: 'Suite', body_translations: null }
  ]);
  assert.equal('carousel_cards' in out[1], false);
  assert.equal(imagesDropped, 1);
  assert.equal(nodes[0].carousel_cards[0].media_id, 'm1', 'the input is not mutated');
});
