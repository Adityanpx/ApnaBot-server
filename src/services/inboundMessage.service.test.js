// Run: node --test src/services/inboundMessage.service.test.js
// gateInbound / insertInbound against an in-memory messages table. `uniqueIndex`
// switches on the partial unique index (23505 on a repeated business + wamid).
const test = require('node:test');
const assert = require('node:assert/strict');

let rows = [];
let uniqueIndex = false;
let nextId = 1;

const from = () => {
  const filters = [];
  let mode = 'select';
  let patch = null;
  let inserted = null;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const run = () => {
    if (mode === 'insert') {
      if (uniqueIndex && rows.some(r => r.business_id === inserted.business_id && r.meta_message_id === inserted.meta_message_id)) {
        return { data: null, error: { code: '23505' } };
      }
      const row = { id: `m${nextId++}`, ...inserted };
      rows.push(row);
      return { data: row, error: null };
    }
    if (mode === 'update') {
      const hit = match();
      hit.forEach(r => Object.assign(r, patch));
      return { data: hit.map(r => ({ ...r })), error: null };
    }
    return { data: match().map(r => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    limit: () => q,
    insert: (v) => { mode = 'insert'; inserted = v; return q; },
    update: (v) => { mode = 'update'; patch = v; return q; },
    single: () => { const r = run(); return Promise.resolve({ data: r.data, error: r.error }); },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
const { gateInbound, insertInbound } = require('./inboundMessage.service');

const B = 'biz';
const W = 'wamid.X';
const realFields = { type: 'text', content: 'Hello', status: 'delivered', is_read: false, raw_payload: null };
const weakRow = { business_id: B, customer_id: 'c1', meta_message_id: W, type: 'unsupported', content: '', raw_payload: { type: 'unsupported' } };
const textRow = { business_id: B, customer_id: 'c1', meta_message_id: W, type: 'text', content: 'Hello' };

test.beforeEach(() => { rows = []; uniqueIndex = false; nextId = 1; });

test('gate: first delivery of an id -> insert', async () => {
  assert.deepEqual(await gateInbound(B, W, 'text', realFields), { action: 'insert' });
  assert.deepEqual(await gateInbound(B, W, 'unsupported', realFields), { action: 'insert' });
});

test('gate: real after unsupported -> replaces the row once; a second real is ignored', async () => {
  rows.push({ id: 'w', ...weakRow });
  const first = await gateInbound(B, W, 'text', realFields);
  assert.equal(first.action, 'replace');
  assert.equal(first.message.id, 'w');
  assert.equal(rows[0].type, 'text');
  assert.equal(rows[0].content, 'Hello');
  assert.equal(rows[0].raw_payload, null);
  assert.equal(rows.length, 1);
  assert.equal((await gateInbound(B, W, 'text', realFields)).action, 'ignore'); // exactly once
});

test('gate: unsupported after real / after unsupported -> ignore, no row written', async () => {
  rows.push({ id: 't', ...textRow });
  assert.equal((await gateInbound(B, W, 'unsupported', realFields)).action, 'ignore');
  rows = [{ id: 'w', ...weakRow }];
  assert.equal((await gateInbound(B, W, 'unsupported', realFields)).action, 'ignore');
  assert.equal(rows.length, 1);
});

test('gate: another business\'s row with the same id is not a duplicate', async () => {
  rows.push({ id: 't', ...textRow, business_id: 'other' });
  assert.deepEqual(await gateInbound(B, W, 'text', realFields), { action: 'insert' });
});

test('insert: plain insert returns the row', async () => {
  const r = await insertInbound({ business_id: B, customer_id: 'c1', meta_message_id: W, ...realFields }, realFields);
  assert.equal(r.action, 'inserted');
  assert.equal(rows.length, 1);
});

test('insert with the index: repeat of a real message -> ignore (23505)', async () => {
  uniqueIndex = true;
  rows.push({ id: 't', ...textRow });
  const r = await insertInbound({ business_id: B, customer_id: 'c1', meta_message_id: W, ...realFields }, realFields);
  assert.equal(r.action, 'ignore');
  assert.equal(rows.length, 1);
});

test('insert with the index: unsupported repeat -> ignore; real over unsupported -> replace', async () => {
  uniqueIndex = true;
  rows.push({ id: 'w', ...weakRow });
  const weak = await insertInbound({ business_id: B, customer_id: 'c1', meta_message_id: W, type: 'unsupported' }, realFields);
  assert.equal(weak.action, 'ignore');
  const real = await insertInbound({ business_id: B, customer_id: 'c1', meta_message_id: W, ...realFields }, realFields);
  assert.equal(real.action, 'replace');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'text');
});

test('insert with the index: two concurrent real deliveries over one unsupported -> exactly one wins', async () => {
  uniqueIndex = true;
  rows.push({ id: 'w', ...weakRow });
  const fields = { business_id: B, customer_id: 'c1', meta_message_id: W, ...realFields };
  const results = await Promise.all([insertInbound(fields, realFields), insertInbound(fields, realFields)]);
  assert.deepEqual(results.map(r => r.action).sort(), ['ignore', 'replace']);
});
