// Run: node --test src/utils/webhookLogSummary.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { webhookLogSummary } = require('./webhookLogSummary');

const body = {
  object: 'whatsapp_business_account',
  entry: [{ id: 'W1', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'P1', display_phone_number: '919800000000' },
    contacts: [{ profile: { name: 'CANARY-NAME' }, wa_id: '919811112222' }],
    messages: [
      { id: 'wamid.A', from: '919811112222', type: 'text', text: { body: 'CANARY-TEXT' } },
      { id: 'wamid.B', from: '919811112222', type: 'image', image: { caption: 'CANARY-CAPTION' } }
    ],
    statuses: [{ id: 'wamid.C', status: 'failed', recipient_id: '919811112222', errors: [{ code: 131026, message: 'CANARY-TEXT' }] }]
  } }] }]
};

test('summary keeps object, field, ids, types, status values, counts - and nothing else', () => {
  const line = webhookLogSummary(body);
  const parsed = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(parsed.object, 'whatsapp_business_account');
  assert.equal(parsed.entries[0].waba_id, 'W1');
  const c = parsed.entries[0].changes[0];
  assert.deepEqual([c.field, c.phone_number_id, c.messages], ['messages', 'P1', 2]);
  assert.deepEqual(c.message_ids, ['wamid.A', 'wamid.B']);
  assert.deepEqual(c.message_types, { text: 1, image: 1 });
  assert.deepEqual(c.statuses, { failed: 1 });
  assert.deepEqual(c.error_codes, ['131026']);
  for (const leaked of ['CANARY', '919811112222', '919800000000']) assert.ok(!line.includes(leaked), leaked);
});

test('summary survives malformed bodies', () => {
  for (const b of [undefined, null, {}, { entry: 'x' }, { entry: [null, {}] }, { entry: [{ changes: [null] }] }]) {
    assert.match(webhookLogSummary(b), /^WEBHOOK POST received: /);
  }
});
