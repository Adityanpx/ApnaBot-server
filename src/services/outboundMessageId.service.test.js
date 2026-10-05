// Run: node --test src/services/outboundMessageId.service.test.js
// Saving Meta's wamid on an outbound row, including the race with an echo row
// that already holds it. In-memory messages table with the same unique key as
// the real one (business_id + meta_message_id). No database.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let logs; let failUpdate;

const from = (table) => {
  assert.equal(table, 'messages');
  const filters = []; let op = 'select'; let patch = null; let ids = null;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') {
      if (failUpdate) return { data: null, error: { code: failUpdate, message: 'boom' } };
      const target = match();
      if (patch.meta_message_id !== undefined) {
        const clash = rows.some(r => !target.includes(r) && r.business_id === target[0].business_id && r.meta_message_id === patch.meta_message_id);
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      target.forEach(r => Object.assign(r, patch));
      return { data: target, error: null };
    }
    if (op === 'delete') {
      rows = rows.filter(r => !ids.includes(r.id));
      return { data: null, error: null };
    }
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
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) });
const { extractMetaMessageId, attachMetaMessageId } = require('./outboundMessageId.service');

const B = 'b1';
const W = 'wamid.ABC';
const botRow = (extra = {}) => ({ id: 'bot1', business_id: B, direction: 'outbound', sender_type: 'bot', status: 'queued', meta_message_id: null, ...extra });
const echoRow = (extra = {}) => ({ id: 'echo1', business_id: B, direction: 'outbound', sender_type: 'phone_app', status: 'sent', meta_message_id: W, ...extra });

test.beforeEach(() => { rows = []; logs = []; failUpdate = null; });

test('extractMetaMessageId: the id from Meta\'s send response, null for anything else', () => {
  assert.equal(extractMetaMessageId({ messaging_product: 'whatsapp', contacts: [{ wa_id: '91' }], messages: [{ id: 'wamid.X' }] }), 'wamid.X');
  for (const bad of [undefined, null, {}, { messages: [] }, { messages: [{}] }, { messages: [{ id: '' }] }, { messages: [{ id: 5 }] }]) {
    assert.equal(extractMetaMessageId(bad), null, JSON.stringify(bad));
  }
});

test('the wamid and the extra fields are written together', async () => {
  rows = [botRow()];
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), true);
  assert.deepEqual([rows[0].meta_message_id, rows[0].status], [W, 'sent']);
});

test('no wamid (a response without one): only the extra fields are written', async () => {
  rows = [botRow()];
  assert.equal(await attachMetaMessageId(B, 'bot1', null, { status: 'sent' }), false);
  assert.deepEqual([rows[0].meta_message_id, rows[0].status], [null, 'sent']);
});

test('an echo row already holds the wamid: the echo is deleted, the bot row keeps it, the send is untouched', async () => {
  rows = [botRow(), echoRow()];
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), true);
  assert.deepEqual(rows.map(r => r.id), ['bot1']);
  assert.deepEqual([rows[0].meta_message_id, rows[0].status], [W, 'sent']);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && /echo removed/.test(m)));
});

test('a clash with anything that is NOT an echo row deletes nothing; the status is still written', async () => {
  rows = [botRow(), echoRow({ id: 'other', sender_type: 'bot' })];
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), false);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'sent');
  assert.equal(rows[0].meta_message_id, null);
});

test('an echo row of ANOTHER business with the same wamid is never touched', async () => {
  rows = [botRow(), echoRow({ business_id: 'b2' })];
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), true);
  assert.equal(rows.length, 2);
});

test('a database failure is swallowed (never throws), and the status is still attempted', async () => {
  rows = [botRow()];
  failUpdate = '500';
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), false);
  failUpdate = null;
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), true);
});

test('the same id written twice to the same row is fine', async () => {
  rows = [botRow()];
  await attachMetaMessageId(B, 'bot1', W, { status: 'sent' });
  assert.equal(await attachMetaMessageId(B, 'bot1', W, { status: 'sent' }), true);
  assert.equal(rows.length, 1);
});
