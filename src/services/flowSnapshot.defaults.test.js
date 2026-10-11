// writeBusinessGraphRows fills NOT NULL columns a template row omitted
// (supabase-js bulk insert would otherwise send them as NULL).
const test = require('node:test');
const assert = require('node:assert/strict');

const inserted = {};
require.cache[require.resolve('../config/supabase')] = {
  exports: { from: (table) => ({ insert: async (rows) => { inserted[table] = rows; return { error: null }; } }) },
  loaded: true, id: require.resolve('../config/supabase'), filename: require.resolve('../config/supabase')
};
const { writeBusinessGraphRows } = require('./flowSnapshot.service');

test('node and edge rows missing NOT NULL columns get defaults', async () => {
  const nodes = [{ id: 'a', node_type: 'reply' }, { id: 'b', node_type: 'question', options: ['x'], required: true, is_active: false }];
  const edges = [{ id: 'e1', from_node_id: 'a', to_node_id: 'b' }];
  await writeBusinessGraphRows('biz', nodes, edges, { reuseIds: false, resetTriggerCount: true });

  const [n1, n2] = inserted.flow_nodes;
  assert.deepEqual(
    { h: n1.hindi_aliases, o: n1.options, r: n1.required, c: n1.is_computed, a: n1.is_active, t: n1.trigger_count, g: n1.gallery_media_ids },
    { h: [], o: [], r: false, c: false, a: true, t: 0, g: [] }
  );
  assert.deepEqual([n2.options, n2.required, n2.is_active], [['x'], true, false]); // explicit values kept
  assert.equal(inserted.flow_edges[0].display_order, 0);
  assert.equal(inserted.flow_edges[0].from_node_id, n1.id);
});
