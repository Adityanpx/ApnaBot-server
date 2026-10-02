// Run: node --test src/controllers/customer.controller.test.js
// isBroadcastEligible must match broadcastAudience.service.js#resolveAudience.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from: () => { throw new Error('no database in this test'); } });
stub('../services/business.service', {});
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const { isBroadcastEligible } = require('./customer.controller');

const row = (over = {}) => ({ opted_in: true, is_blocked: false, opted_out_at: null, ...over });

test('broadcast eligible: opted in, not blocked, not opted out', () => {
  assert.equal(isBroadcastEligible(row()), true);
  assert.equal(isBroadcastEligible(row({ opted_out_at: undefined })), true); // row from before the column
});

test('not eligible: not opted in, blocked, or sent STOP', () => {
  assert.equal(isBroadcastEligible(row({ opted_in: false })), false);
  assert.equal(isBroadcastEligible(row({ is_blocked: true })), false);
  assert.equal(isBroadcastEligible(row({ opted_out_at: '2026-10-01T10:00:00Z' })), false);
});
