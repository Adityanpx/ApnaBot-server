// A small in-memory stand-in for the supabase-js query builder, for service
// tests that need real filtering / updating (storage cleanup). Not a Postgres:
// only the operators the services use are implemented.
//
//   const fake = createFakeSupabase({ uniques: [...], rpc: { name: (args, db) => rows } });
//   fake.db.<table> is an array of rows (snake_case).
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 'col.not.is.null' / 'col.is.null' pieces of an .or() string
const orPredicate = (expr) => {
  const preds = expr.split(',').map((piece) => {
    const eq = piece.match(/^([a-z0-9_]+)\.eq\.(.+)$/);
    if (eq) return (r) => String(r[eq[1]]) === eq[2];
    const m = piece.match(/^([a-z0-9_]+)\.(not\.)?is\.null$/);
    if (!m) throw new Error(`fake supabase: unsupported or() piece "${piece}"`);
    const [, col, neg] = m;
    return (r) => (neg ? r[col] !== null && r[col] !== undefined : r[col] === null || r[col] === undefined);
  });
  return (r) => preds.some(p => p(r));
};

const createFakeSupabase = ({ uniques = [], rpc = {} } = {}) => {
  const db = {};
  let nextId = 1;
  const calls = [];
  const rows = (table) => (db[table] = db[table] || []);

  const from = (table) => {
    const filters = [];
    let op = 'select'; let payload = null; let wantRows = false; let count = null; let head = false;
    let order = null; let range = null; let limit = null; let upsertOn = null;

    const matching = () => rows(table).filter(r => filters.every(f => f(r)));
    const run = () => {
      calls.push({ table, op });
      if (op === 'insert' || op === 'upsert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const out = [];
        for (const p of list) {
          if (op === 'upsert') {
            const existing = rows(table).find(r => upsertOn.every(c => r[c] === p[c]));
            if (existing) { Object.assign(existing, clone(p)); out.push(existing); continue; }
          }
          const dup = uniques.find(u => u.table === table && (!u.where || u.where(p)) &&
            rows(table).some(r => (!u.where || u.where(r)) && u.cols.every(c => r[c] === p[c] && p[c] !== undefined && p[c] !== null)));
          if (dup) return { data: null, error: { code: '23505', message: `duplicate key on ${table}` } };
          const row = { id: `${table}-${nextId++}`, created_at: new Date().toISOString(), ...clone(p) };
          rows(table).push(row);
          out.push(row);
        }
        return { data: clone(out), error: null };
      }
      if (op === 'update') {
        const hit = matching();
        hit.forEach(r => Object.assign(r, clone(payload)));
        return { data: wantRows ? clone(hit) : null, error: null };
      }
      if (op === 'delete') {
        const hit = matching();
        db[table] = rows(table).filter(r => !hit.includes(r));
        return { data: wantRows ? clone(hit) : null, error: null };
      }
      let out = matching();
      if (order) out = [...out].sort((a, b) => order.dir * compare(a[order.col], b[order.col]));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      if (head) return { data: null, count: out.length, error: null };
      return { data: clone(out), count: count ? out.length : null, error: null };
    };

    const q = {
      select: (_cols, opts = {}) => {
        if (op === 'select') { count = opts.count || null; head = !!opts.head; } else wantRows = true;
        return q;
      },
      insert: (p) => { op = 'insert'; payload = p; return q; },
      upsert: (p, opts = {}) => { op = 'upsert'; payload = p; upsertOn = (opts.onConflict || 'id').split(','); return q; },
      update: (p) => { op = 'update'; payload = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c, v) => { filters.push(r => r[c] === v); return q; },
      neq: (c, v) => { filters.push(r => r[c] !== v); return q; },
      in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
      is: (c, v) => { filters.push(r => (r[c] === undefined ? null : r[c]) === v); return q; },
      not: (c, _op, v) => { filters.push(r => (r[c] === undefined ? null : r[c]) !== v); return q; },
      gt: (c, v) => { filters.push(r => r[c] > v); return q; },
      gte: (c, v) => { filters.push(r => r[c] >= v); return q; },
      lt: (c, v) => { filters.push(r => r[c] < v); return q; },
      lte: (c, v) => { filters.push(r => r[c] <= v); return q; },
      or: (expr) => { filters.push(orPredicate(expr)); return q; },
      order: (col, { ascending = true } = {}) => { order = { col, dir: ascending ? 1 : -1 }; return q; },
      range: (a, b) => { range = [a, b]; return q; },
      limit: (n) => { limit = n; return q; },
      single: async () => { const r = run(); return { data: r.data && r.data[0] ? r.data[0] : null, error: r.error }; },
      maybeSingle: async () => { const r = run(); return { data: r.data && r.data[0] ? r.data[0] : null, error: r.error }; },
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
    };
    return q;
  };

  const rpcCall = async (name, args) => {
    calls.push({ rpc: name });
    if (!rpc[name]) return { data: null, error: { message: `fake supabase: no rpc ${name}` } };
    return { data: await rpc[name](args, db), error: null };
  };

  return { db, from, rpc: rpcCall, calls };
};

module.exports = { createFakeSupabase };
