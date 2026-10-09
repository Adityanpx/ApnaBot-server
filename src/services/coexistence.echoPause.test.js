// Run: node --test src/services/coexistence.echoPause.test.js
// smb_message_echoes: auto-pause of the bot (ECHO_AUTO_PAUSE) and last_activity_at,
// against an in-memory Supabase with the same unique keys as the real tables.
// The 15 s timer is node's mock timer; socket, tenant service and logger stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');

let db; let emitted; let logs; let nextId; let envConfig;

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
    limit: () => q,
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: r.error }; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
envConfig = { ECHO_AUTO_PAUSE: false };
stub('../config/env', envConfig);
stub('../config/supabase', { from });
stub('../utils/logger', {
  info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m])
});
stub('./socket.service', { emitToBusiness: (id, event, data) => { emitted.push([id, event, data]); } });
stub('./tenant.service', { resolveBusinessByPhoneNumberId: async () => null, invalidateTenantCache: async () => {} });
const svc = require('./coexistence.service');
const { INDEFINITE_PAUSE_SENTINEL } = require('../utils/botPause');

const BIZ = 'b1';
const BIZ_NUMBER = '919607024225';
const NUMBER = '919800000001';
const meta = { display_phone_number: '+91 96070 24225', phone_number_id: 'pn1' };
const tenant = { businessId: BIZ, isActive: true, whatsappOnboardingType: 'coexistence' };

const nowSec = () => String(Math.floor(Date.now() / 1000));
const echo = (id, over = {}) => ({ from: BIZ_NUMBER, to: NUMBER, id, timestamp: nowSec(), type: 'text', text: { body: 'hi' }, ...over });
const send = (t, ...echoes) => svc.handleEchoes(t, { metadata: meta, message_echoes: echoes });
const customer = () => db.customers.find(c => c.whatsapp_number === NUMBER);
const pauseLogs = () => logs.filter(([, m]) => /^echo auto-pause: wamid /.test(m)).map(([, m]) => m);
const flush = () => new Promise(r => setImmediate(r));
const fire = async () => { test.mock.timers.tick(svc.ECHO_PAUSE_DELAY_MS); await flush(); await flush(); };

test.beforeEach(() => {
  db = {
    customers: [{ id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, name: 'Ravi', last_message_at: '2026-10-08T00:00:00Z', last_activity_at: '2026-10-08T00:00:00Z', total_messages: 3, bot_paused_until: null, pipeline_stage: 'new' }],
    messages: []
  };
  emitted = []; logs = []; nextId = 1;
  envConfig.ECHO_AUTO_PAUSE = false;
  test.mock.timers.enable({ apis: ['setTimeout'] });
});
test.afterEach(() => { test.mock.timers.reset(); });

// ---- auto-pause ---------------------------------------------------------

test('flag off: a new echo never pauses the bot, schedules nothing, logs nothing', async () => {
  await send(tenant, echo('wamid.E1'));
  await fire();
  assert.equal(customer().bot_paused_until, null);
  assert.equal(customer().pipeline_stage, 'new');
  assert.deepEqual(pauseLogs(), []);
  assert.equal(db.messages.length, 1); // the echo itself is still stored
});

test('flag on: ~15 s after a new echo the bot is paused 24h and the customer moves to contacted', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  await send(tenant, echo('wamid.E1'));
  assert.equal(customer().bot_paused_until, null, 'not before the delay');
  const before = Date.now();
  await fire();
  const until = new Date(customer().bot_paused_until).getTime();
  assert.ok(until >= before + 24 * 3600 * 1000 - 1000 && until <= Date.now() + 24 * 3600 * 1000 + 1000);
  assert.equal(customer().pipeline_stage, 'contacted');
  assert.deepEqual(pauseLogs(), ['echo auto-pause: wamid wamid.E1 business b1 apiRowMatched no paused yes']);
});

test('flag on: a customer who never messaged is paused too', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  db.customers = [];
  await send(tenant, echo('wamid.E1'));
  assert.equal(customer().last_message_at, null);
  await fire();
  assert.ok(new Date(customer().bot_paused_until).getTime() > Date.now());
  assert.equal(customer().pipeline_stage, 'contacted');
});

test('a duplicate echo (wamid already stored) schedules no pause and is logged as already stored', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  db.messages.push({ id: 'api', business_id: BIZ, customer_id: 'c1', meta_message_id: 'wamid.E1', direction: 'outbound', sender_type: 'bot' });
  await send(tenant, echo('wamid.E1'));
  await fire();
  assert.equal(customer().bot_paused_until, null);
  assert.deepEqual(pauseLogs(), ['echo auto-pause: wamid wamid.E1 business b1 apiRowMatched yes paused no (wamid already stored)']);
});

test('echo of an API-sent message that claims the wamid before the timer fires: not paused (bot and human rows both count)', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  for (const [id, sender] of [['wamid.B', 'bot'], ['wamid.H', 'human']]) {
    await send(tenant, echo(id));
    // outboundMessageId.service.js: the API row takes the wamid, the echo row is deleted
    db.messages = db.messages.filter(m => !(m.meta_message_id === id && m.sender_type === 'phone_app'));
    db.messages.push({ id: `api-${id}`, business_id: BIZ, customer_id: 'c1', meta_message_id: id, direction: 'outbound', sender_type: sender });
    await fire();
    assert.equal(customer().bot_paused_until, null, sender);
    assert.equal(customer().pipeline_stage, 'new', sender);
  }
  assert.deepEqual(pauseLogs(), [
    'echo auto-pause: wamid wamid.B business b1 apiRowMatched yes paused no (echo of a message sent through the API)',
    'echo auto-pause: wamid wamid.H business b1 apiRowMatched yes paused no (echo of a message sent through the API)'
  ]);
});

test('an echo older than 10 minutes never pauses and schedules nothing', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  const old = String(Math.floor(Date.now() / 1000) - 11 * 60);
  await send(tenant, echo('wamid.OLD', { timestamp: old }));
  await fire();
  assert.equal(customer().bot_paused_until, null);
  assert.deepEqual(pauseLogs(), ['echo auto-pause: wamid wamid.OLD business b1 apiRowMatched n/a paused no (echo older than 10 minutes)']);
});

test('an echo just inside 10 minutes still pauses', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  await send(tenant, echo('wamid.E1', { timestamp: String(Math.floor(Date.now() / 1000) - 9 * 60) }));
  await fire();
  assert.ok(customer().bot_paused_until);
});

test('an indefinite pause is never shortened, but the customer still moves to contacted', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  customer().bot_paused_until = INDEFINITE_PAUSE_SENTINEL;
  await send(tenant, echo('wamid.E1'));
  await fire();
  assert.equal(customer().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
  assert.equal(customer().pipeline_stage, 'contacted');
  assert.deepEqual(pauseLogs(), ['echo auto-pause: wamid wamid.E1 business b1 apiRowMatched no paused no (indefinite pause kept)']);
});

test('the pause is decided from a fresh read: an indefinite pause set during the delay still wins', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  await send(tenant, echo('wamid.E1'));
  customer().bot_paused_until = INDEFINITE_PAUSE_SENTINEL; // owner pauses from the dashboard meanwhile
  await fire();
  assert.equal(customer().bot_paused_until, INDEFINITE_PAUSE_SENTINEL);
});

test('a customer already past new is not moved back; a lost customer stays lost', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  customer().pipeline_stage = 'lost';
  await send(tenant, echo('wamid.E1'));
  await fire();
  assert.equal(customer().pipeline_stage, 'lost');
  assert.ok(customer().bot_paused_until); // still paused
});

test('onboarding type: an explicit cloud_api number is skipped; NULL (legacy) and coexistence are paused', async () => {
  envConfig.ECHO_AUTO_PAUSE = true;
  await send({ ...tenant, whatsappOnboardingType: 'cloud_api' }, echo('wamid.C'));
  await fire();
  assert.equal(customer().bot_paused_until, null);
  assert.match(pauseLogs()[0], /cloud_api number/);

  await send({ ...tenant, whatsappOnboardingType: null }, echo('wamid.N'));
  await fire();
  assert.ok(customer().bot_paused_until, 'NULL type is treated as coexistence');

  customer().bot_paused_until = null;
  await send({ ...tenant, whatsappOnboardingType: undefined }, echo('wamid.U')); // a tenant cached before this field existed
  await fire();
  assert.ok(customer().bot_paused_until);
});

test('decideEchoPause: an unreadable database logs the error and pauses nothing', async () => {
  const realFrom = require('../config/supabase').from;
  require('../config/supabase').from = () => { throw new Error('db down'); };
  try {
    const r = await svc.decideEchoPause({ businessId: BIZ, customerId: 'c1', wamid: 'wamid.X' });
    assert.equal(r.paused, false);
    assert.match(pauseLogs()[0], /paused no \(error: db down\)/);
  } finally {
    require('../config/supabase').from = realFrom;
  }
});

// ---- last_activity_at ---------------------------------------------------

test('echo: stamps last_activity_at with the echo time; last_message_at and total_messages stay as they were', async () => {
  const ts = Math.floor(Date.now() / 1000) - 60;
  await send(tenant, echo('wamid.E1', { timestamp: String(ts) }));
  assert.equal(customer().last_activity_at, new Date(ts * 1000).toISOString());
  assert.equal(customer().last_message_at, '2026-10-08T00:00:00Z');
  assert.equal(customer().total_messages, 3);
  assert.equal(emitted[0][2].customer.lastActivityAt, new Date(ts * 1000).toISOString());
});

test('echo: last_activity_at only moves forward (a late echo does not push the chat down)', async () => {
  customer().last_activity_at = '2099-01-01T00:00:00Z';
  await send(tenant, echo('wamid.E1'));
  assert.equal(customer().last_activity_at, '2099-01-01T00:00:00Z');
});

test('echo to a brand-new number: the customer gets last_activity_at but no last_message_at (inbox yes, 24h window no)', async () => {
  db.customers = [];
  await send(tenant, echo('wamid.E1'));
  assert.ok(customer().last_activity_at);
  assert.equal(customer().last_message_at, null);
  assert.equal(customer().total_messages, 0);
});

test('a duplicate echo does not touch last_activity_at again', async () => {
  const ts = Math.floor(Date.now() / 1000) - 120;
  await send(tenant, echo('wamid.E1', { timestamp: String(ts) }));
  customer().last_activity_at = '2026-10-08T01:00:00Z';
  await send(tenant, echo('wamid.E1', { timestamp: String(ts) }));
  assert.equal(customer().last_activity_at, '2026-10-08T01:00:00Z');
});
