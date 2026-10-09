// Run: node --test src/services/coexistence.service.test.js
// The coexistence webhook handlers against an in-memory Supabase that enforces
// the same unique keys as the real tables (customers: business + number;
// messages: business + wamid, with bulk inserts that fail atomically). Socket,
// tenant service and logger stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let emitted; let invalidated; let logs; let resolveTenant; let nextId;

const uniqueKeys = { customers: ['business_id', 'whatsapp_number'], messages: ['business_id', 'meta_message_id'] };

const from = (table) => {
  const filters = []; let op = 'select'; let payload = null; let single = false;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const violates = (row, pool) => {
    const keys = uniqueKeys[table];
    if (!keys || keys.some(k => row[k] === null || row[k] === undefined)) return false;
    return pool.some(r => keys.every(k => r[k] === row[k]));
  };
  const run = () => {
    if (op === 'insert') {
      const list = Array.isArray(payload) ? payload : [payload];
      const staged = [];
      for (const p of list) {
        if (violates(p, rows()) || violates(p, staged)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        staged.push({ id: `${table}-${nextId++}`, created_at: '2026-10-05T00:00:00Z', ...p });
      }
      rows().push(...staged);
      return { data: single ? staged[0] : staged, error: null };
    }
    if (op === 'update') {
      const hit = matching();
      hit.forEach(r => Object.assign(r, payload));
      return { data: hit, error: null };
    }
    return { data: matching(), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    or: (expr) => {
      // only the one expression the handler uses: an empty name
      assert.equal(expr, 'name.is.null,name.eq.');
      filters.push(r => r.name === null || r.name === undefined || r.name === '');
      return q;
    },
    limit: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    single: () => { single = true; const r = run(); return Promise.resolve(r); },
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: r.error }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/env', { ECHO_AUTO_PAUSE: false });
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m])
});
stub('./socket.service', { emitToBusiness: (id, event, data) => { emitted.push([id, event, data]); } });
stub('./tenant.service', {
  resolveBusinessByPhoneNumberId: async (id) => resolveTenant(id),
  invalidateTenantCache: async (id) => { invalidated.push(id); }
});
stub('./whatsapp.service', {});
stub('./r2.service', {});
const svc = require('./coexistence.service');

const BIZ = 'b1';
const BIZ_NUMBER = '919607024225';
const tenant = { businessId: BIZ, isActive: true };
const meta = { display_phone_number: '+91 96070 24225', phone_number_id: 'pn1' };

const customers = () => db.customers;
const messages = () => db.messages;
const echo = (id, to, body, extra = {}) => ({ from: BIZ_NUMBER, to, id, timestamp: '1760000000', type: 'text', text: { body }, ...extra });

test.beforeEach(() => {
  db = { customers: [], messages: [], businesses: [] };
  emitted = []; invalidated = []; logs = []; nextId = 1;
  resolveTenant = async () => tenant;
});

// ---- echoes -------------------------------------------------------------

test('echo: stored as an outbound phone_app message, customer created without any count, dashboard notified', async () => {
  const stats = await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'On my way')] });
  assert.equal(stats.stored, 1);
  const m = messages()[0];
  assert.deepEqual(
    { d: m.direction, s: m.sender_type, st: m.status, read: m.is_read, c: m.content, id: m.meta_message_id, t: m.type, hist: m.is_history_import },
    { d: 'outbound', s: 'phone_app', st: 'sent', read: true, c: 'On my way', id: 'wamid.E1', t: 'text', hist: undefined }
  );
  assert.equal(m.created_at, '2025-10-09T08:53:20.000Z');
  const c = customers()[0];
  assert.equal(c.whatsapp_number, '919800000001');
  assert.equal(c.last_message_at, null);
  assert.equal(c.total_messages, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][1], 'new_message');
  assert.equal(emitted[0][2].customerNumber, '919800000001');
});

test('echo: an existing customer keeps last_message_at and total_messages (the 24h window is not opened)', async () => {
  customers().push({ id: 'c1', business_id: BIZ, whatsapp_number: '919800000001', name: 'Ravi', last_message_at: '2026-10-01T00:00:00Z', total_messages: 7 });
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'hello')] });
  assert.equal(customers().length, 1);
  assert.equal(customers()[0].last_message_at, '2026-10-01T00:00:00Z');
  assert.equal(customers()[0].total_messages, 7);
  assert.equal(messages()[0].customer_id, 'c1');
});

test('echo: the same wamid again is a duplicate, stored once, no second notification', async () => {
  const value = { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'hello')] };
  await svc.handleEchoes(tenant, value);
  const again = await svc.handleEchoes(tenant, value);
  assert.equal(again.duplicates, 1);
  assert.equal(messages().length, 1);
  assert.equal(emitted.length, 1);
});

test('echo: revoke and edit are skipped; a failing echo does not stop the rest', async () => {
  const stats = await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [
    echo('wamid.R', '919800000001', '', { type: 'revoke', revoke: { original_message_id: 'x' }, text: undefined }),
    echo('wamid.X', '919800000001', '', { type: 'edit', edit: {}, text: undefined }),
    { from: BIZ_NUMBER, to: '919800000002', type: 'text' }, // no id
    echo('wamid.OK', '919800000003', 'fine')
  ] });
  assert.deepEqual(stats.skipped, { revoke: 1, edit: 1, 'no message id': 1 });
  assert.deepEqual(messages().map(m => m.meta_message_id), ['wamid.OK']);
});

test('echo: never touches usage or the bot (nothing but customers + messages is written)', async () => {
  await svc.handleEchoes(tenant, { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'hello')] });
  assert.deepEqual(Object.keys(db).sort(), ['businesses', 'customers', 'messages']);
  assert.equal(db.usage, undefined);
});

// ---- history ------------------------------------------------------------

const chunk = (messagesIn, id = '919800000001', metaIn = { phase: 0, chunk_order: 1, progress: 10 }) => ({ metadata: metaIn, threads: [{ id, messages: messagesIn }] });
const hm = (id, fromNumber, body, status = 'READ', ts = '1759000000') => ({ from: fromNumber, to: fromNumber === BIZ_NUMBER ? '919800000001' : BIZ_NUMBER, id, timestamp: ts, type: 'text', text: { body }, history_context: { status } });

test('history: both directions stored with original time, read, flagged as imports; no socket, no counts', async () => {
  const stats = await svc.handleHistory(tenant, { metadata: meta, history: [chunk([
    hm('h1', BIZ_NUMBER, 'Namaste', 'READ'),
    hm('h2', '919800000001', 'Price?', 'DELIVERED'),
    hm('h3', BIZ_NUMBER, 'Failed one', 'ERROR')
  ])] });
  assert.equal(stats.inserted, 3);
  const byId = Object.fromEntries(messages().map(m => [m.meta_message_id, m]));
  assert.deepEqual([byId.h1.direction, byId.h1.sender_type, byId.h1.status], ['outbound', 'phone_app', 'delivered']);
  assert.deepEqual([byId.h2.direction, byId.h2.sender_type, byId.h2.status], ['inbound', 'human', 'delivered']);
  assert.equal(byId.h3.status, 'failed');
  assert.ok(messages().every(m => m.is_history_import === true && m.is_read === true));
  assert.equal(byId.h1.created_at, '2025-09-27T19:06:40.000Z');
  assert.equal(customers().length, 1);
  assert.equal(customers()[0].last_message_at, null);
  assert.equal(customers()[0].total_messages, 0);
  assert.equal(emitted.length, 0);
});

test('history: a replayed chunk and ids already stored are skipped, not duplicated', async () => {
  messages().push({ id: 'old', business_id: BIZ, meta_message_id: 'h1', direction: 'outbound' });
  const value = { metadata: meta, history: [chunk([hm('h1', BIZ_NUMBER, 'a'), hm('h2', '919800000001', 'b'), hm('h2', '919800000001', 'b')])] };
  const first = await svc.handleHistory(tenant, value);
  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 2);
  const second = await svc.handleHistory(tenant, value);
  assert.equal(second.inserted, 0);
  assert.equal(messages().filter(m => m.meta_message_id === 'h2').length, 1);
});

test('history: a chunk that races a concurrent writer still lands row by row (23505 on the bulk insert)', async () => {
  const realFrom = require('../config/supabase').from;
  let first = true;
  require('../config/supabase').from = (table) => {
    const q = realFrom(table);
    const sel = q.select;
    if (table === 'messages') {
      // the pre-check sees nothing; then a concurrent chunk stores h2 before our insert
      q.select = (...a) => { const r = sel(...a); return r; };
      const ins = q.insert;
      q.insert = (p) => {
        if (first && Array.isArray(p)) { first = false; db.messages.push({ id: 'race', business_id: BIZ, meta_message_id: 'h2', direction: 'inbound' }); }
        return ins(p);
      };
    }
    return q;
  };
  try {
    const stats = await svc.handleHistory(tenant, { metadata: meta, history: [chunk([hm('h1', BIZ_NUMBER, 'a'), hm('h2', '919800000001', 'b')])] });
    assert.equal(stats.inserted, 1);
    assert.equal(stats.duplicates, 1);
    assert.equal(stats.failed, 0);
  } finally {
    require('../config/supabase').from = realFrom;
  }
});

test('history: declined sharing (2593109) is logged and nothing is stored', async () => {
  const stats = await svc.handleHistory(tenant, { metadata: meta, history: [{ errors: [{ code: 2593109, title: 'History sync is turned off' }] }] });
  assert.deepEqual(stats.errorCodes, [2593109]);
  assert.equal(messages().length, 0);
  assert.ok(logs.some(([lvl, m]) => lvl === 'warn' && /2593109/.test(m)));
});

test('history: one summary line per webhook, no per-message logging', async () => {
  await svc.handleHistory(tenant, { metadata: meta, history: [
    chunk([hm('h1', BIZ_NUMBER, 'a'), hm('h2', '919800000001', 'b')], '919800000001', { phase: 1, chunk_order: 4, progress: 60 }),
    chunk([hm('h3', BIZ_NUMBER, 'c')], '919800000002', { phase: 1, chunk_order: 5, progress: 62 })
  ] });
  const infos = logs.filter(([lvl]) => lvl === 'info');
  assert.equal(infos.length, 1);
  assert.match(infos[0][1], /phase 1 chunk 5 progress 62% threads 2 messages 3 inserted 3/);
});

test('history: many threads at once create each customer once', async () => {
  const many = [];
  for (let i = 0; i < 450; i += 1) many.push({ id: `91980000${String(i).padStart(4, '0')}`, messages: [hm(`m${i}`, `91980000${String(i).padStart(4, '0')}`, 'hi')] });
  const stats = await svc.handleHistory(tenant, { metadata: meta, history: [{ metadata: { phase: 2, chunk_order: 9, progress: 100 }, threads: many }] });
  assert.equal(stats.inserted, 450);
  assert.equal(stats.customersCreated, 450);
  assert.equal(customers().length, 450);
});

// ---- contacts -----------------------------------------------------------

const contactItem = (phone, name, action = 'add') => ({ type: 'contact', action, contact: { full_name: name, phone_number: phone }, metadata: { timestamp: '1' } });

test('contact sync: new contacts created (not opted in, no counts); an existing name is never overwritten', async () => {
  customers().push({ id: 'c1', business_id: BIZ, whatsapp_number: '919800000001', name: 'My Own Name', total_messages: 4, last_message_at: '2026-10-01T00:00:00Z' });
  customers().push({ id: 'c2', business_id: BIZ, whatsapp_number: '919800000002', name: null, total_messages: 0, last_message_at: null });
  const stats = await svc.handleStateSync(tenant, { metadata: meta, state_sync: [
    contactItem('+91 98000 00001', 'Phone Name'),
    contactItem('919800000002', 'Filled Name'),
    contactItem('919800000003', 'Brand New'),
    contactItem('919800000009', null, 'remove'),
    contactItem('12', 'Bad')
  ] });
  assert.deepEqual([stats.created, stats.existing, stats.namesFilled, stats.removes, stats.invalid], [1, 2, 1, 1, 1]);
  const byNumber = Object.fromEntries(customers().map(c => [c.whatsapp_number, c]));
  assert.equal(byNumber['919800000001'].name, 'My Own Name');
  assert.equal(byNumber['919800000001'].total_messages, 4);
  assert.equal(byNumber['919800000002'].name, 'Filled Name');
  assert.equal(byNumber['919800000003'].name, 'Brand New');
  assert.equal(byNumber['919800000003'].total_messages, 0);
  assert.equal(byNumber['919800000003'].last_message_at, null);
  assert.equal(byNumber['919800000003'].opted_in, undefined); // left to the column default (false)
  assert.equal(customers().length, 3); // remove deletes nothing
});

test('contact sync: a concurrent writer winning an insert is settled, not failed', async () => {
  const realFrom = require('../config/supabase').from;
  let raced = false;
  require('../config/supabase').from = (table) => {
    const q = realFrom(table);
    if (table === 'customers') {
      const ins = q.insert;
      q.insert = (p) => {
        if (!raced && Array.isArray(p)) { raced = true; db.customers.push({ id: 'r', business_id: BIZ, whatsapp_number: '919800000003', name: 'Imported' }); }
        return ins(p);
      };
    }
    return q;
  };
  try {
    const stats = await svc.handleStateSync(tenant, { metadata: meta, state_sync: [contactItem('919800000003', 'Phone'), contactItem('919800000004', 'Other')] });
    assert.equal(stats.failed, 0);
    assert.equal(customers().length, 2);
    assert.equal(customers().find(c => c.whatsapp_number === '919800000003').name, 'Imported');
  } finally {
    require('../config/supabase').from = realFrom;
  }
});

// ---- account_update -----------------------------------------------------

const biz = (extra = {}) => ({ id: BIZ, waba_id: '111', phone_number_id: 'pn1', is_whatsapp_connected: true, access_token: 'enc', ...extra });

test('account_update: PARTNER_REMOVED / ACCOUNT_DELETED / ACCOUNT_OFFBOARDED disconnect, keeping the IDs and token, clearing the cache', async () => {
  for (const event of ['PARTNER_REMOVED', 'ACCOUNT_DELETED', 'ACCOUNT_OFFBOARDED']) {
    db.businesses = [biz()]; invalidated = [];
    const r = await svc.handleAccountUpdate({ id: '111' }, { event, disconnection_info: { reason: 'CHANGE_NUMBER', initiated_by: 'USER' } });
    assert.equal(r.action, 'disconnected', event);
    assert.equal(db.businesses[0].is_whatsapp_connected, false);
    assert.equal(db.businesses[0].phone_number_id, 'pn1');
    assert.equal(db.businesses[0].access_token, 'enc');
    assert.equal(db.businesses[0].waba_id, '111');
    assert.deepEqual(invalidated, ['pn1']);
  }
});

test('account_update: ACCOUNT_RECONNECTED reconnects only while a token is still stored', async () => {
  db.businesses = [biz({ is_whatsapp_connected: false })];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'ACCOUNT_RECONNECTED' })).action, 'connected');
  assert.equal(db.businesses[0].is_whatsapp_connected, true);
  assert.deepEqual(invalidated, ['pn1']);

  db.businesses = [biz({ is_whatsapp_connected: false, access_token: null })];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'ACCOUNT_RECONNECTED' })).action, 'ignored');
  assert.equal(db.businesses[0].is_whatsapp_connected, false);
});

test('account_update: already in that state is a no-op; unknown events are only logged', async () => {
  db.businesses = [biz({ is_whatsapp_connected: false })];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_REMOVED' })).action, 'unchanged');
  assert.deepEqual(invalidated, []);
  db.businesses = [biz()];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_ADDED' })).action, 'log');
  assert.equal(db.businesses[0].is_whatsapp_connected, true);
  assert.ok(logs.some(([, m]) => /PARTNER_ADDED.*no action/.test(m)));
});

test('account_update: no match, or a WABA shared by two businesses, is ignored (never guessed)', async () => {
  db.businesses = [biz({ waba_id: '999' })];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_REMOVED' })).action, 'ignored');
  db.businesses = [biz({ id: 'a' }), biz({ id: 'b' })];
  assert.equal((await svc.handleAccountUpdate({ id: '111' }, { event: 'PARTNER_REMOVED' })).action, 'ignored');
  assert.ok(db.businesses.every(b => b.is_whatsapp_connected === true));
  assert.equal((await svc.handleAccountUpdate({}, { event: 'PARTNER_REMOVED' })).action, 'ignored');
});

// ---- dispatch -----------------------------------------------------------

test('handleChange: a business that does not resolve (inactive or disconnected) is ignored', async () => {
  resolveTenant = async () => null;
  const r = await svc.handleChange({ id: 'w' }, { field: 'smb_message_echoes', value: { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'hi')] } });
  assert.equal(r, null);
  assert.equal(messages().length, 0);
});

test('handleChange: routes each field to its handler; a payload with no phone_number_id is ignored', async () => {
  await svc.handleChange({ id: 'w' }, { field: 'smb_message_echoes', value: { metadata: meta, message_echoes: [echo('wamid.E1', '919800000001', 'hi')] } });
  assert.equal(messages().length, 1);
  await svc.handleChange({ id: 'w' }, { field: 'history', value: { metadata: meta, history: [chunk([hm('h1', '919800000002', 'x')], '919800000002')] } });
  assert.equal(messages().length, 2);
  await svc.handleChange({ id: 'w' }, { field: 'smb_app_state_sync', value: { metadata: meta, state_sync: [contactItem('919800000005', 'Z')] } });
  assert.ok(customers().some(c => c.whatsapp_number === '919800000005'));
  assert.equal(await svc.handleChange({ id: 'w' }, { field: 'history', value: { history: [] } }), null);
});
