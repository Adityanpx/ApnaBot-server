// Run: node --test src/services/followup.service.listTemplates.test.js
// The follow-up template picker offers templates that are approved and
// send_support 'ok' (body-only, media header, header variable, URL / phone
// buttons), re-checked against the stored components. Supabase is a query recorder.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
let eqs; let rows;
const query = {
  select: () => query,
  eq: (c, v) => { eqs[c] = v; return query; },
  order: async () => ({ data: rows, error: null })
};
stub('../config/supabase', { from: () => query });
stub('./followupSweep.service', { countDueCustomers: async () => ({}) });
const { listTemplates } = require('./followup.service');

const row = (over) => ({
  id: 't', name: 'n', category: 'UTILITY', language: 'en_US', status: 'approved', send_support: 'ok',
  body_text: 'Hi {{1}}', header_type: 'NONE', meta_components: null, header_media_url: null, header_image_url: null, ...over
});

test.beforeEach(() => { eqs = {}; rows = [row()]; });

test('picker query: approved + send_support ok for this business — no body-only / header_type filter', async () => {
  const list = await listTemplates('biz');
  assert.deepEqual(eqs, { business_id: 'biz', status: 'approved', send_support: 'ok' });
  assert.equal(list[0].variableCount, 1);
  assert.equal(list[0].headerType, 'NONE');
  assert.equal(list[0].headerVariableCount, 0);
  assert.deepEqual(list[0].buttons, []);
});

test('media-header, header-variable and URL-button templates are offered, with what the wizard must map', async () => {
  rows = [
    row({ id: 'img', header_type: 'IMAGE', header_image_url: 'https://r2/x.jpeg' }),
    row({
      id: 'btn', header_type: 'TEXT',
      meta_components: [
        { type: 'HEADER', format: 'TEXT', text: 'Hello {{1}}' },
        { type: 'BODY', text: 'Pay now' },
        { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' }, { type: 'URL', text: 'Pay', url: 'https://x.com/{{1}}' }] }
      ]
    })
  ];
  const list = await listTemplates('biz');
  assert.deepEqual(list.map(t => t.id), ['img', 'btn']);
  assert.equal(list[0].headerType, 'IMAGE');
  assert.equal(list[1].headerVariableCount, 1);
  assert.deepEqual(list[1].buttons, [
    { index: 0, type: 'PHONE_NUMBER', text: 'Call', dynamic: false },
    { index: 1, type: 'URL', text: 'Pay', dynamic: true }
  ]);
});

test('a template whose stored components are no longer sendable is left out even if send_support still says ok', async () => {
  rows = [
    row({ id: 'noMedia', header_type: 'VIDEO' }),
    row({ id: 'qr', meta_components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }] }),
    row({ id: 'fine' })
  ];
  assert.deepEqual((await listTemplates('biz')).map(t => t.id), ['fine']);
});
