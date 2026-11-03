// In-memory supabase stand-in for the Super Admin business list tests: select / eq / in / order / range /
// limit, plus the two .or() shapes the list uses (businesses: name, city, owner_user_id.in; users: name, email, phone).
// Rows in `tables` are snake_case; a subscriptions row carries its joined `plan` object directly.

const orMatcher = (table, expr) => {
  const pick = (col) => { const m = new RegExp(`${col}\\.ilike\\.%([^%,]*)%`).exec(expr); return m ? m[1].toLowerCase() : null; };
  const has = (v, term) => term !== null && String(v || '').toLowerCase().includes(term);
  if (table === 'users') {
    return (r) => has(r.name, pick('name')) || has(r.email, pick('email')) || has(r.phone, pick('phone'));
  }
  const ownerIds = ((/owner_user_id\.in\.\(([^)]*)\)/.exec(expr) || [])[1] || '').split(',');
  return (r) => has(r.name, pick('name')) || has(r.city, pick('city')) || ownerIds.includes(r.owner_user_id);
};

const createFakeAdminDb = (tables, log = {}) => ({
  from: (table) => {
    const filters = []; let window = null;
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      in: (c, vals) => { filters.push((r) => vals.includes(r[c])); return q; },
      or: (expr) => { (log.or = log.or || []).push({ table, expr }); filters.push(orMatcher(table, expr)); return q; },
      order: () => q,
      limit: () => q,
      range: (a, b) => { window = [a, b]; return q; },
      then: (resolve) => {
        const all = tables[table].filter((r) => filters.every((f) => f(r)));
        const data = (window ? all.slice(window[0], window[1] + 1) : all).map((r) => ({ ...r }));
        return resolve({ data, error: null, count: all.length });
      }
    };
    return q;
  }
});

module.exports = { createFakeAdminDb };
