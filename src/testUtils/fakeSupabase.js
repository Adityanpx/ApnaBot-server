// Minimal in-memory Supabase for tests. Supports the chained filters the
// subscription code uses (eq/neq/in/gt/gte/lt/limit/order), insert/update,
// single/maybeSingle (which, like PostgREST, error on 0/2+ rows for single and
// on 2+ rows for maybeSingle) and the `plan:plans(*)` embed.
let idCounter = 0;

const createFakeSupabase = (initial = {}) => {
  const db = {};
  for (const [table, rows] of Object.entries(initial)) db[table] = rows.map(r => ({ ...r }));
  const calls = [];

  const from = (table) => {
    db[table] = db[table] || [];
    const filters = [];
    let op = 'select';
    let patch = null;
    let selectStr = '*';
    let limitN = null;
    let order = null;
    let wantSelect = false;

    const matches = (row) => filters.every(f => f(row));
    const embed = (row) => {
      if (!/plan:plans/.test(selectStr)) return { ...row };
      const plan = (db.plans || []).find(p => p.id === row.plan_id) || null;
      return { ...row, plan };
    };
    const run = () => {
      if (op === 'insert') {
        const row = { id: `gen-${++idCounter}`, created_at: new Date().toISOString(), ...patch };
        db[table].push(row);
        calls.push({ table, op, row });
        return [embed(row)];
      }
      if (op === 'update') {
        const hit = db[table].filter(matches);
        hit.forEach(r => Object.assign(r, patch));
        calls.push({ table, op, patch, ids: hit.map(r => r.id) });
        return hit.map(embed);
      }
      let rows = db[table].filter(matches);
      if (order) {
        rows = [...rows].sort((a, b) => (a[order.col] > b[order.col] ? 1 : -1) * (order.asc ? 1 : -1));
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows.map(embed);
    };

    const q = {
      select: (str) => { if (str) selectStr = str; wantSelect = true; return q; },
      insert: (row) => { op = 'insert'; patch = row; return q; },
      update: (row) => { op = 'update'; patch = row; return q; },
      eq: (c, v) => { filters.push(r => r[c] === v); return q; },
      neq: (c, v) => { filters.push(r => r[c] !== v); return q; },
      in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
      gt: (c, v) => { filters.push(r => r[c] > v); return q; },
      gte: (c, v) => { filters.push(r => r[c] >= v); return q; },
      lt: (c, v) => { filters.push(r => r[c] < v); return q; },
      limit: (n) => { limitN = n; return q; },
      order: (col, { ascending = true } = {}) => { order = { col, asc: ascending }; return q; },
      maybeSingle: async () => {
        const rows = run();
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple (or no) rows returned' } };
        return { data: rows[0] || null, error: null };
      },
      single: async () => {
        const rows = run();
        if (rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'multiple (or no) rows returned' } };
        return { data: rows[0], error: null };
      },
      then: (resolve, reject) => {
        try { resolve({ data: wantSelect || op === 'select' ? run() : (run(), null), error: null }); } catch (e) { reject(e); }
      }
    };
    return q;
  };

  return { from, db, calls, rpc: async () => ({ data: null, error: null }) };
};

const stub = (rel, exports, fromFile) => {
  const path = require('path');
  const p = rel.startsWith('.')
    ? require.resolve(path.resolve(path.dirname(fromFile), rel))
    : require.resolve(rel);   // bare package name, e.g. 'razorpay'
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

module.exports = { createFakeSupabase, stub };
