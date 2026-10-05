// Run: node --test src/services/followup.service.listTemplates.test.js
// The follow-up template picker only offers templates that are approved,
// send_support 'ok' and body-only. Supabase is a query recorder.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
let eqs;
const query = {
  select: () => query,
  eq: (c, v) => { eqs[c] = v; return query; },
  order: async () => ({ data: [{ id: 't', name: 'n', category: 'UTILITY', language: 'en_US', body_text: 'Hi {{1}}', header_type: 'NONE' }], error: null })
};
stub('../config/supabase', { from: () => query });
stub('./followupSweep.service', { countDueCustomers: async () => ({}) });
const { listTemplates } = require('./followup.service');

test('picker query: approved + send_support ok + body-only, for this business', async () => {
  eqs = {};
  const list = await listTemplates('biz');
  assert.deepEqual(eqs, { business_id: 'biz', status: 'approved', send_support: 'ok', header_type: 'NONE' });
  assert.equal(list[0].variableCount, 1);
});
