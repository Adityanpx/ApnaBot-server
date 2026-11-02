// Run: node --test src/utils/quoteFlowIds.test.js
// The ids of the quote flow's rows: derived per business (UUIDv5), nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, version } = require('uuid');
const ids = require('./quoteFlowIds');
const fixture = require('../test-support/travelsDefaultFlowFixture');

const B1 = '00000000-0000-4000-8000-0000000000aa';
const B2 = '00000000-0000-4000-8000-0000000000bb';

test('derived ids: valid UUIDv5, one per slot, deterministic', () => {
  const d = ids.derive(B1);
  assert.equal(d.nodeIds.length, ids.NODE_SLOTS.length);
  assert.equal(d.edgeIds.length, ids.EDGE_SLOTS.length);
  assert.equal(new Set([...d.nodeIds, ...d.edgeIds]).size, d.nodeIds.length + d.edgeIds.length, 'no two slots share an id');
  for (const id of [...d.nodeIds, ...d.edgeIds]) { assert.ok(validate(id)); assert.equal(version(id), 5); }
  assert.deepEqual(ids.derive(B1), d, 'the same business always gets the same ids');
});

test('derived ids are pinned (changing the namespace or a slot name would orphan every installed business)', () => {
  const d = ids.derive(B1);
  assert.equal(d.N.trigger, 'd66c0f6b-5eeb-5c1b-9f13-308ec3f7bca1');
  assert.equal(d.N.quote, '9dc1f5b7-ad3a-5a7e-ad43-ad30a61599e7');
  assert.equal(d.E.rates, '00303d7b-e03f-5b28-8205-ced997378c8a');
  assert.equal(d.E.daysToVehicle, 'fd82c92f-9270-5353-ac23-3130cc8e40c1');
});

test('two businesses never share an id', () => {
  const flat = [ids.derive(B1), ids.derive(B2)].flatMap((x) => [...x.nodeIds, ...x.edgeIds]);
  assert.equal(new Set(flat).size, flat.length);
});

test('"ours" uses the same derivation: a business owns its own ids only', () => {
  const mine = ids.derive(B1);
  for (const id of mine.nodeIds) {
    assert.ok(ids.isOurs(B1, id)); assert.ok(ids.isOurNode(B1, id)); assert.ok(!ids.isOurEdge(B1, id)); assert.ok(!ids.isOurs(B2, id));
  }
  for (const id of mine.edgeIds) {
    assert.ok(ids.isOurs(B1, id)); assert.ok(ids.isOurEdge(B1, id)); assert.ok(!ids.isOurNode(B1, id)); assert.ok(!ids.isOurs(B2, id));
  }
  for (const n of fixture.nodes()) assert.ok(!ids.isOurs(B1, n.id), 'a row of the business\'s own flow is never ours');
});

test('a business id is required', () => {
  assert.throws(() => ids.derive(''), /business id is required/);
  assert.throws(() => ids.derive(undefined), /business id is required/);
  assert.throws(() => ids.isOurs(null, 'x'), /business id is required/);
});

test('the module names no business and no fixed tag', () => {
  const source = require('node:fs').readFileSync(require.resolve('./quoteFlowIds'), 'utf8');
  assert.ok(!/5eed7a01|a94aec66|LEGACY/i.test(source));
});
