// Run: node --test src/controllers/messageTemplate.listSystem.test.js
// GET /api/message-templates leaves out the catalogue broadcast's system templates (kind 'catalog_carousel')
// unless ?includeSystem=true.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const filters = [];
const rows = [
  { id: 't1', business_id: 'b', name: 'promo', kind: 'standard', created_at: '2026-01-01', meta_deleted_at: null },
  { id: 't2', business_id: 'b', name: 'apnabot_catalog_v2_3_en_2', kind: 'catalog_carousel', created_at: '2026-01-02', meta_deleted_at: null }
];
stub('../config/supabase', {
  from: () => {
    const preds = [];
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push(['eq', c, v]); preds.push((r) => r[c] === v); return q; },
      neq: (c, v) => { filters.push(['neq', c, v]); preds.push((r) => r[c] !== v); return q; },
      order: () => q,
      then: (resolve) => resolve({ data: rows.filter((r) => preds.every((p) => p(r))), error: null })
    };
    return q;
  }
});
stub('../config/env', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', {});
stub('../services/r2.service', {});
stub('../services/templateSync.service', {});
stub('../utils/crypto', {});
stub('../services/templateSubmit.service', { submitTemplateToMeta: async () => ({}), TemplateValidationError: class extends Error {} });
const { getMessageTemplates } = require('./messageTemplate.controller');

const call = async (query = {}) => {
  const out = {};
  const res = { status: (code) => { out.status = code; return res; }, json: (body) => { out.body = body; return res; } };
  await getMessageTemplates({ user: { businessId: 'b' }, query }, res, (err) => { throw err; });
  return out;
};

test('the catalogue broadcast templates are hidden by default', async () => {
  const out = await call();
  assert.deepEqual(out.body.data.templates.map((t) => t.id), ['t1']);
  assert.ok(filters.some((f) => f[0] === 'neq' && f[1] === 'kind' && f[2] === 'catalog_carousel'));
});

test('?includeSystem=true lists them too', async () => {
  const out = await call({ includeSystem: 'true' });
  assert.deepEqual(out.body.data.templates.map((t) => t.id).sort(), ['t1', 't2']);
});
