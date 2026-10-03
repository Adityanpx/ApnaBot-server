// Run: node --test src/services/optInLink.service.test.js
// optInLink.service against an in-memory stand-in for Supabase — nothing is
// read from or written to a real database.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '22222222-2222-4222-8222-222222222222';
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

let db; let seq; let failInserts; let business;

const reset = () => {
  db = { opt_in_links: [], opt_in_link_events: [], customers: [] };
  seq = 0; failInserts = 0;
  business = { name: 'SG Travels', displayName: 'SG Travels', whatsappNumber: '919876543210' };
};
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// Minimal chainable PostgREST stand-in: eq / in / order / limit / range,
// insert / update with .select(), maybeSingle / single / await.
const from = (table) => {
  const filters = []; let op = 'select'; let payload = null; let order = null; let limit = null; let range = null;
  const matching = () => db[table].filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') {
      if (table === 'opt_in_links' && failInserts > 0) { failInserts--; return { data: null, error: { code: '23505', message: 'duplicate key' } }; }
      const row = { id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(table === 'opt_in_links' ? { is_active: true } : {}), ...payload };
      if (table === 'opt_in_links' && db[table].some(r => r.business_id === row.business_id && r.code === row.code)) {
        return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      db[table].push(row);
      return { data: [row], error: null };
    }
    if (op === 'update') {
      const rows = matching();
      rows.forEach(r => Object.assign(r, payload));
      return { data: rows, error: null };
    }
    let rows = matching();
    if (order) rows = [...rows].sort((a, b) => (a[order.col] < b[order.col] ? -1 : a[order.col] > b[order.col] ? 1 : 0) * (order.asc ? 1 : -1));
    if (range) rows = rows.slice(range[0], range[1] + 1);
    if (limit !== null) rows = rows.slice(0, limit);
    return { data: rows.map(r => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    eq: (col, val) => { filters.push(r => r[col] === val); return q; },
    in: (col, vals) => { filters.push(r => vals.includes(r[col])); return q; },
    order: (col, opts = {}) => { order = { col, asc: opts.ascending !== false }; return q; },
    limit: (n) => { limit = n; return q; },
    range: (a, b) => { range = [a, b]; return q; },
    maybeSingle: async () => { const r = run(); return r.error ? r : { data: r.data[0] || null, error: null }; },
    single: async () => {
      const r = run();
      if (r.error) return r;
      return r.data.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { message: 'not single' } };
    },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', { from });
stub('./business.service', { getBusinessById: async () => business });
stub('./categoryFeature.service', { isEnabled: async () => true });
stub('../utils/logger', { error: () => {}, info: () => {}, warn: () => {} });
const service = require('./optInLink.service');

const addLink = (over = {}) => {
  const row = { id: uuid(), business_id: BIZ, name: 'Counter poster', code: 'K7Q2', prefill_text: 'Hi {{businessName}} 👋', is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over };
  db.opt_in_links.push(row);
  return row;
};
const addCustomer = (over = {}) => {
  const row = { id: uuid(), business_id: BIZ, opted_in: false, opted_in_at: null, opt_in_source: null, opt_in_link_id: null, opted_out_at: '2026-09-01T00:00:00Z', ...over };
  db.customers.push(row);
  return row;
};
const camel = (row) => ({ id: row.id, optedIn: row.opted_in, optedOutAt: row.opted_out_at });
const addEvent = (link, customerId, event, agoMs) => db.opt_in_link_events.push({
  id: uuid(), link_id: link.id, business_id: link.business_id, customer_id: customerId, event,
  created_at: new Date(Date.now() - agoMs).toISOString()
});

test('isOptedIn: opted in and not opted out', () => {
  assert.equal(service.isOptedIn({ optedIn: true, optedOutAt: null }), true);
  assert.equal(service.isOptedIn({ optedIn: true, optedOutAt: '2026-10-01T00:00:00Z' }), false);
  assert.equal(service.isOptedIn({ optedIn: false, optedOutAt: null }), false);
});

test('consent Yes: writes opt-in fields, clears opted_out_at, logs opted_in', async () => {
  reset();
  const link = addLink();
  const c = addCustomer();
  const { newlyOptedIn, customer } = await service.handleConsentTap(BIZ, camel(c), { answer: 'yes', linkId: link.id });
  assert.equal(newlyOptedIn, true);
  assert.equal(c.opted_in, true);
  assert.ok(c.opted_in_at);
  assert.equal(c.opt_in_source, 'opt_in_link');
  assert.equal(c.opt_in_link_id, link.id);
  assert.equal(c.opted_out_at, null);
  assert.equal(customer.optInLinkId, link.id); // camelCase row returned
  assert.deepEqual(db.opt_in_link_events.map(e => e.event), ['opted_in']);
});

test('consent Yes when already opted in (any source): no write, no second event', async () => {
  reset();
  const link = addLink();
  const c = addCustomer({ opted_in: true, opted_in_at: '2026-09-01T00:00:00Z', opt_in_source: 'manual', opted_out_at: null });
  const r = await service.handleConsentTap(BIZ, camel(c), { answer: 'yes', linkId: link.id });
  assert.equal(r.newlyOptedIn, false);
  assert.equal(c.opt_in_source, 'manual');
  assert.equal(c.opted_in_at, '2026-09-01T00:00:00Z');
  assert.equal(db.opt_in_link_events.length, 0);
});

test('consent Yes double tap: second tap changes nothing', async () => {
  reset();
  const link = addLink();
  const c = addCustomer();
  const first = await service.handleConsentTap(BIZ, camel(c), { answer: 'yes', linkId: link.id });
  const firstAt = c.opted_in_at;
  const second = await service.handleConsentTap(BIZ, first.customer, { answer: 'yes', linkId: link.id });
  assert.equal(second.newlyOptedIn, false);
  assert.equal(c.opted_in_at, firstAt);
  assert.equal(db.opt_in_link_events.filter(e => e.event === 'opted_in').length, 1);
});

test('consent Yes on an inactive link still opts in and records the link', async () => {
  reset();
  const link = addLink({ is_active: false });
  const c = addCustomer();
  const r = await service.handleConsentTap(BIZ, camel(c), { answer: 'yes', linkId: link.id });
  assert.equal(r.newlyOptedIn, true);
  assert.equal(c.opt_in_link_id, link.id);
  assert.equal(db.opt_in_link_events.length, 1);
});

test('consent Yes for a missing link or another business\'s link: opts in, no link, no event', async () => {
  reset();
  const foreign = addLink({ business_id: OTHER_BIZ });
  const c1 = addCustomer();
  const r1 = await service.handleConsentTap(BIZ, camel(c1), { answer: 'yes', linkId: foreign.id });
  assert.equal(r1.newlyOptedIn, true);
  assert.equal(c1.opt_in_link_id, null);
  const c2 = addCustomer();
  await service.handleConsentTap(BIZ, camel(c2), { answer: 'yes', linkId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(c2.opted_in, true);
  assert.equal(c2.opt_in_link_id, null);
  const c3 = addCustomer();
  await service.handleConsentTap(BIZ, camel(c3), { answer: 'yes', linkId: 'not-a-uuid' });
  assert.equal(c3.opted_in, true);
  assert.equal(db.opt_in_link_events.length, 0);
});

test('consent No: logs declined, customer unchanged', async () => {
  reset();
  const link = addLink();
  const c = addCustomer();
  const r = await service.handleConsentTap(BIZ, camel(c), { answer: 'no', linkId: link.id });
  assert.equal(r.newlyOptedIn, false);
  assert.equal(c.opted_in, false);
  assert.equal(c.opted_out_at, '2026-09-01T00:00:00Z');
  assert.deepEqual(db.opt_in_link_events.map(e => e.event), ['declined']);
});

test('findLinkById: scoped to the business, rejects non-uuids', async () => {
  reset();
  const link = addLink();
  assert.equal((await service.findLinkById(BIZ, link.id)).id, link.id);
  assert.equal(await service.findLinkById(OTHER_BIZ, link.id), null);
  assert.equal(await service.findLinkById(BIZ, 'optin_yes'), null);
  assert.equal(await service.findLinkById(BIZ, null), null);
});

test('findPendingLink: latest event a recent message → that link', async () => {
  reset();
  const link = addLink();
  const c = addCustomer();
  addEvent(link, c.id, 'message', 5 * MIN);
  assert.equal((await service.findPendingLink(BIZ, c.id)).id, link.id);
});

test('findPendingLink: none when answered, too old, inactive or no events', async () => {
  reset();
  const link = addLink();
  const answered = addCustomer();
  addEvent(link, answered.id, 'message', 10 * MIN);
  addEvent(link, answered.id, 'declined', 9 * MIN);
  assert.equal(await service.findPendingLink(BIZ, answered.id), null);

  const old = addCustomer();
  addEvent(link, old.id, 'message', 31 * MIN);
  assert.equal(await service.findPendingLink(BIZ, old.id), null);

  const inactive = addLink({ code: 'AB23', is_active: false });
  const c = addCustomer();
  addEvent(inactive, c.id, 'message', MIN);
  assert.equal(await service.findPendingLink(BIZ, c.id), null);

  assert.equal(await service.findPendingLink(BIZ, addCustomer().id), null);
});

test('computeStats: distinct customers per event, last 30 days and all time', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  const ev = (link_id, customer_id, event, daysAgo) => ({ link_id, customer_id, event, created_at: new Date(now - daysAgo * DAY).toISOString() });
  const stats = service.computeStats([
    ev('L1', 'a', 'message', 1), ev('L1', 'a', 'message', 2), // same customer twice → 1
    ev('L1', 'b', 'message', 40),
    ev('L1', 'a', 'opted_in', 1),
    ev('L1', 'b', 'declined', 40),
    ev('L2', 'c', 'message', 3)
  ], now);
  assert.deepEqual(stats.get('L1'), {
    last30Days: { messages: 1, optedIn: 1, declined: 0 },
    allTime: { messages: 2, optedIn: 1, declined: 1 }
  });
  assert.deepEqual(stats.get('L2').allTime, { messages: 1, optedIn: 0, declined: 0 });
});

test('create: default greeting, fresh code, prefill text and wa.me URL', async () => {
  reset();
  const { link } = await service.create(BIZ, 'user-1', { name: '  Counter poster ' });
  assert.equal(link.name, 'Counter poster');
  assert.match(link.code, /^[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(link.greeting, 'Hi {{businessName}} 👋');
  assert.equal(link.prefillText, `Hi SG Travels 👋 Code: JOIN-${link.code}`);
  assert.equal(link.waMeUrl, `https://wa.me/919876543210?text=${encodeURIComponent(link.prefillText)}`);
  assert.equal(link.isActive, true);
  assert.deepEqual(link.stats.allTime, { messages: 0, optedIn: 0, declined: 0 });
  assert.equal(db.opt_in_links[0].created_by, 'user-1');
});

test('create: strips an owner-typed JOIN code; waMeUrl null without a WhatsApp number', async () => {
  reset();
  business.whatsappNumber = null;
  const { link } = await service.create(BIZ, null, { name: 'Flyer', greeting: 'Namaste! Code: JOIN-ZZZZ' });
  assert.equal(link.greeting, 'Namaste!');
  assert.equal(link.prefillText, `Namaste! Code: JOIN-${link.code}`);
  assert.equal(link.waMeUrl, null);
});

test('create: validation errors are 400s', async () => {
  reset();
  assert.equal((await service.create(BIZ, null, {})).status, 400);
  assert.equal((await service.create(BIZ, null, { name: 'x'.repeat(61) })).status, 400);
  assert.equal((await service.create(BIZ, null, { name: 'A', greeting: '' })).status, 400);
  assert.equal((await service.create(BIZ, null, { name: 'A', greeting: 'y'.repeat(201) })).status, 400);
  assert.equal(db.opt_in_links.length, 0);
});

test('create: retries a code collision, gives up after 10 tries', async () => {
  reset();
  failInserts = 3;
  const { link } = await service.create(BIZ, null, { name: 'A' });
  assert.ok(link.code);
  assert.equal(db.opt_in_links.length, 1);

  reset();
  failInserts = 10;
  await assert.rejects(() => service.create(BIZ, null, { name: 'A' }), /unique opt-in link code after 10 tries/);
  assert.equal(db.opt_in_links.length, 0);
});

test('update: name / greeting / isActive; code never changes; 404 and 400s', async () => {
  reset();
  const row = addLink();
  const { link } = await service.update(BIZ, row.id, { name: 'Shop door', greeting: 'Hello JOIN-K7Q2', isActive: false, code: 'ZZZZ' });
  assert.equal(link.name, 'Shop door');
  assert.equal(link.greeting, 'Hello');
  assert.equal(link.isActive, false);
  assert.equal(link.code, 'K7Q2');
  assert.equal((await service.update(BIZ, row.id, {})).status, 400);
  assert.equal((await service.update(BIZ, row.id, { isActive: 'no' })).status, 400);
  assert.equal((await service.update(OTHER_BIZ, row.id, { name: 'x' })).status, 404);
});

test('list / get: stats per link, newest first', async () => {
  reset();
  const older = addLink({ created_at: '2026-09-01T00:00:00Z' });
  const newer = addLink({ code: 'AB23', name: 'Flyer', created_at: '2026-10-01T00:00:00Z' });
  addEvent(older, 'c1', 'message', DAY);
  addEvent(older, 'c1', 'opted_in', DAY);
  addEvent(older, 'c2', 'message', 45 * DAY);
  const { links } = await service.list(BIZ);
  assert.deepEqual(links.map(l => l.id), [newer.id, older.id]);
  assert.deepEqual(links[1].stats, {
    last30Days: { messages: 1, optedIn: 1, declined: 0 },
    allTime: { messages: 2, optedIn: 1, declined: 0 }
  });
  assert.equal((await service.get(BIZ, older.id)).link.stats.allTime.messages, 2);
  assert.equal((await service.get(OTHER_BIZ, older.id)).status, 404);
});

test('fetchLinkNames: only this business\'s links, ignores nulls', async () => {
  reset();
  const mine = addLink();
  const theirs = addLink({ business_id: OTHER_BIZ, code: 'AB23' });
  const names = await service.fetchLinkNames(BIZ, [mine.id, theirs.id, null, mine.id]);
  assert.equal(names.get(mine.id), 'Counter poster');
  assert.equal(names.has(theirs.id), false);
  assert.equal((await service.fetchLinkNames(BIZ, [null, undefined])).size, 0);
});
