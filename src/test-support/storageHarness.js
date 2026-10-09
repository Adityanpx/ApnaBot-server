// Shared setup for the storage cleanup tests: stubs config, logger, Supabase, R2 and the
// bot-flow cache, then loads the real services. Must be required BEFORE them.
//
//   const h = require('../test-support/storageHarness');   // from src/services
//   h.reset();  // fresh database + bucket, per test
const path = require('node:path');
const { createFakeSupabase } = require('./fakeSupabase');

const SERVICES = path.join(__dirname, '..', 'services');
const stubModule = (file, exports) => {
  const p = require.resolve(file);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const state = { fake: null, bucket: new Map(), r2Deleted: [], r2Failures: new Map(), onR2Delete: null, invalidated: [], logs: [] };

const cfg = { R2_PUBLIC_URL: 'https://r2.test', ENABLE_STORAGE_SWEEPER: true };
stubModule(path.join(__dirname, '..', 'config', 'env.js'), cfg);
stubModule(path.join(__dirname, '..', 'utils', 'logger.js'), {
  info: (...a) => state.logs.push(['info', ...a]), warn: (...a) => state.logs.push(['warn', ...a]), error: (...a) => state.logs.push(['error', ...a])
});
stubModule(path.join(__dirname, '..', 'config', 'supabase.js'), {
  from: (t) => state.fake.from(t),
  rpc: (n, a) => state.fake.rpc(n, a)
});
stubModule(path.join(SERVICES, 'r2.service.js'), {
  listObjects: async (prefix) => ({
    objects: [...state.bucket.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size, lastModified: o.lastModified })),
    truncated: false
  }),
  deleteObjects: async (keys) => {
    if (state.onR2Delete) await state.onR2Delete(keys);
    const failed = [];
    for (const key of keys) {
      if (state.r2Failures.has(key)) { failed.push({ key, message: state.r2Failures.get(key) }); continue; }
      state.bucket.delete(key);
      state.r2Deleted.push(key);
    }
    return { failed };
  }
});
stubModule(path.join(SERVICES, 'chatbot.service.js'), {
  invalidateRulesCache: async (businessId) => { state.invalidated.push(businessId); }
});

const B1 = 'b1b1b1b1-0000-4000-8000-000000000001';
const B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);
const url = (key) => `https://r2.test/${key}`;

/** A fresh database, bucket and bookkeeping. rpc claim_storage_cleanup_items is modelled in memory. */
const reset = () => {
  state.bucket = new Map(); state.r2Deleted = []; state.r2Failures = new Map(); state.onR2Delete = null; state.invalidated = []; state.logs = [];
  state.fake = createFakeSupabase({
    uniques: [
      { table: 'storage_cleanup_items', cols: ['run_id', 'r2_key'] },
      { table: 'storage_cleanup_runs', cols: ['automatic_day'], where: r => r.is_automatic }
    ],
    rpc: {
      // Mirrors claim_storage_cleanup_items (migration): due items of open runs, not claimed in the last 15 min, < 5 attempts.
      claim_storage_cleanup_items: ({ p_limit, p_run_id }, db) => {
        const runs = new Map((db.storage_cleanup_runs || []).map(r => [r.id, r]));
        const now = Date.now();
        const due = (db.storage_cleanup_items || []).filter(i => {
          const run = runs.get(i.run_id);
          return run && ['pending', 'purging'].includes(run.status) && (!p_run_id || run.id === p_run_id) &&
            ['pending', 'failed'].includes(i.status) && new Date(i.pending_delete_at).getTime() <= now && (i.attempts || 0) < 5 &&
            (!i.claimed_at || new Date(i.claimed_at).getTime() < now - 15 * 60 * 1000);
        }).slice(0, p_limit);
        due.forEach(i => { i.claimed_at = new Date().toISOString(); i.attempts = (i.attempts || 0) + 1; });
        return JSON.parse(JSON.stringify(due));
      },
      increment_business_storage_used: ({ p_business_id, p_delta_bytes }, db) => {
        const b = (db.businesses || []).find(x => x.id === p_business_id);
        if (b) b.storage_used_bytes = (b.storage_used_bytes || 0) + p_delta_bytes;
        return null;
      }
    }
  });
  return state.fake.db;
};

/** Puts an object in the fake bucket. */
const put = (key, { size = 1000, age = 100 * HOUR } = {}) => {
  state.bucket.set(key, { size, lastModified: ago(age) });
  return key;
};

module.exports = { state, cfg, reset, put, B1, B2, uuid, HOUR, ago, url };
