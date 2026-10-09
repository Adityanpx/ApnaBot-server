// Run: node --test src/queues/whatsapp.worker.test.js
// The outbound queue worker: after a send it marks the row sent AND saves
// Meta's wamid on it (so delivered / read status webhooks match). BullMQ, Meta
// and Supabase are stand-ins - no Redis, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let processor; let sendImpl; let sends;

const from = () => {
  const filters = []; let op = 'select'; let patch = null; let ids = null;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') {
      const target = match();
      if (patch.meta_message_id !== undefined) {
        const clash = rows.some(r => !target.includes(r) && r.business_id === target[0].business_id && r.meta_message_id === patch.meta_message_id);
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      target.forEach(r => Object.assign(r, patch));
      return { data: target, error: null };
    }
    if (op === 'delete') { rows = rows.filter(r => !ids.includes(r.id)); return { data: null, error: null }; }
    return { data: match().map(r => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    update: (p) => { op = 'update'; patch = p; return q; },
    delete: () => { op = 'delete'; return q; },
    in: (c, vs) => { ids = vs; return q; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test' });
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const sendFn = (name) => async (...args) => { sends.push([name, args]); return sendImpl(name); };
stub('../services/whatsapp.service', {
  sendTextMessage: sendFn('text'), sendImageMessage: sendFn('image'), sendLocationMessage: sendFn('location'),
  sendLocationRequest: sendFn('locationRequest'), sendInteractiveButtons: sendFn('buttons'), sendListMessage: sendFn('list'),
  sendRuleListMessage: sendFn('ruleList'), sendCtaUrlButton: sendFn('cta')
});
require('./whatsapp.worker');

const B = 'b1';
const job = (data, attemptsMade = 0) => ({ data: { businessId: B, phoneNumberId: 'pn', encryptedAccessToken: 'enc', to: '919800000001', message: 'hi', messageId: 'row1', ...data }, attemptsMade });
const response = (id) => ({ messaging_product: 'whatsapp', contacts: [{ wa_id: '919800000001' }], messages: [{ id }] });
const bot = () => ({ id: 'row1', business_id: B, direction: 'outbound', sender_type: 'bot', status: 'sent', meta_message_id: null });

test.beforeEach(() => { rows = [bot()]; sends = []; sendImpl = () => response('wamid.OUT1'); });

test('a text send: row marked sent with Meta\'s wamid saved on it', async () => {
  await processor(job({}));
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', 'wamid.OUT1']);
});

test('every send branch saves the wamid (text, image, buttons, list, rule list, CTA, location, location request)', async () => {
  const cases = [
    [{}, 'text'], [{ imageUrl: 'https://x/y.jpg' }, 'image'], [{ buttons: [{ title: 'A', nextKeyword: 'a' }] }, 'buttons'],
    [{ interactiveButtons: ['A'], step: 's' }, 'buttons'], [{ interactiveList: ['A'], step: 's' }, 'list'],
    [{ listOptions: [{ title: 'A' }] }, 'ruleList'], [{ ctaButton: { buttonText: 'Go', url: 'https://x' } }, 'cta'],
    [{ location: { latitude: 1, longitude: 2, name: 'n', address: 'a' } }, 'location'], [{ locationRequest: true }, 'locationRequest']
  ];
  for (const [data, branch] of cases) {
    rows = [bot()]; sends = [];
    sendImpl = () => response(`wamid.${branch}`);
    await processor(job(data));
    assert.equal(sends[0][0], branch);
    assert.equal(rows[0].meta_message_id, `wamid.${branch}`, branch);
    assert.equal(rows[0].status, 'sent', branch);
  }
});

test('Meta\'s status webhook now finds the row: its lookup key (meta_message_id) matches', async () => {
  await processor(job({}));
  const found = rows.filter(r => r.meta_message_id === 'wamid.OUT1');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'row1');
});

test('an echo row already holds the wamid: the echo is removed, the bot row keeps it, the job still succeeds', async () => {
  rows.push({ id: 'echo1', business_id: B, direction: 'outbound', sender_type: 'phone_app', status: 'sent', meta_message_id: 'wamid.OUT1' });
  const result = await processor(job({}));
  assert.deepEqual(result, { success: true });
  assert.deepEqual(rows.map(r => r.id), ['row1']);
  assert.equal(rows[0].meta_message_id, 'wamid.OUT1');
});

test('a send response without an id still marks the row sent and succeeds', async () => {
  sendImpl = () => ({ messaging_product: 'whatsapp' });
  assert.deepEqual(await processor(job({})), { success: true });
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', null]);
});

test('a job without a messageId (nothing to update) just sends', async () => {
  assert.deepEqual(await processor(job({ messageId: null })), { success: true });
  assert.equal(sends.length, 1);
});

test('a failed send is unchanged: row failed after the last attempt, error rethrown, no wamid', async () => {
  sendImpl = () => { throw new Error('meta down'); };
  await assert.rejects(() => processor(job({}, 2)), /meta down/);
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['failed', null]);
  rows = [bot()];
  await assert.rejects(() => processor(job({}, 0)), /meta down/);
  assert.equal(rows[0].status, 'sent'); // not the last attempt: left for the retry
});

test("the final failure keeps Meta's reason: code, title, details and failed_at", async () => {
  sendImpl = () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { data: { error: { code: 131047, type: 'OAuthException', message: 'Re-engagement message', error_data: { details: 'More than 24 hours' } } } } }); };
  await assert.rejects(() => processor(job({}, 2)), /400/);
  assert.deepEqual([rows[0].status, rows[0].error_code, rows[0].error_title, rows[0].error_details], ['failed', 131047, 'Re-engagement message', 'More than 24 hours']);
  assert.ok(!Number.isNaN(Date.parse(rows[0].failed_at)));
});

test('a final failure that is not a Meta rejection stores just the message, no code', async () => {
  sendImpl = () => { throw new Error('socket hang up'); };
  await assert.rejects(() => processor(job({}, 2)), /socket/);
  assert.deepEqual([rows[0].status, rows[0].error_code, rows[0].error_title], ['failed', null, 'socket hang up']);
});
