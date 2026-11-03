// Run: node --test src/utils/fetchAllPages.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchAllPages, fetchByIds } = require('./fetchAllPages');

test('fetchAllPages: keeps paging until a short page comes back', async () => {
  const pages = [Array(1000).fill({}), Array(5).fill({})];
  const calls = [];
  const rows = await fetchAllPages(async (a, b) => { calls.push([a, b]); return { data: pages[calls.length - 1], error: null }; });
  assert.equal(rows.length, 1005);
  assert.deepEqual(calls, [[0, 999], [1000, 1999]]);
});

test('fetchAllPages: an empty first page returns no rows', async () => {
  assert.deepEqual(await fetchAllPages(async () => ({ data: [], error: null })), []);
});

test('fetchAllPages: throws the query error', async () => {
  await assert.rejects(fetchAllPages(async () => ({ data: null, error: new Error('boom') })), /boom/);
});

const fakeDb = (seen) => ({
  from: (table) => ({
    select: () => ({
      in: (col, ids) => {
        seen.push({ table, col, ids });
        return { then: (resolve) => resolve({ data: ids.map((id) => ({ id })), error: null }) };
      }
    })
  })
});

test('fetchByIds: splits the ids into chunks of 100 and joins the rows', async () => {
  const seen = [];
  const ids = Array.from({ length: 250 }, (_, i) => `id${i}`);
  const rows = await fetchByIds(fakeDb(seen), 'users', 'id', 'id', ids);
  assert.equal(rows.length, 250);
  assert.deepEqual(seen.map((s) => s.ids.length), [100, 100, 50]);
});

test('fetchByIds: no ids means no request', async () => {
  const seen = [];
  assert.deepEqual(await fetchByIds(fakeDb(seen), 'users', 'id', 'id', []), []);
  assert.equal(seen.length, 0);
});

test('fetchByIds: extend adds filters to each chunk and a query error is thrown', async () => {
  const db = { from: () => ({ select: () => ({ in: () => ({ marker: true }) }) }) };
  const extend = (q) => { assert.equal(q.marker, true); return Promise.resolve({ data: null, error: new Error('bad') }); };
  await assert.rejects(fetchByIds(db, 'users', 'id', 'id', ['a'], extend), /bad/);
});
