// Run: node --test src/controllers/message.controller.markConversationRead.test.js
// PUT /api/messages/customer/:customerId/read: one UPDATE that marks the unread inbound
// messages of ONE conversation read - scoped by business, customer, direction and
// is_read - and returns how many changed. In-memory Supabase; the queue and the
// WhatsApp service fail the test if they are touched.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let updates; let failWith;

const from = (table) => {
  assert.equal(table, 'messages');
  const filters = []; let patch = null;
  const q = {
    update: (p) => { patch = p; return q; },
    eq: (c, v) => { filters.push([c, v]); return q; },
    select: () => q,
    then: (resolve, reject) => {
      updates.push({ patch, filters: filters.map(([c, v]) => `${c}=${v}`).sort() });
      if (failWith) return Promise.resolve({ data: null, error: failWith }).then(resolve, reject);
      const hit = rows.filter(r => filters.every(([c, v]) => r[c] === v));
      hit.forEach(r => Object.assign(r, patch));
      return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null }).then(resolve, reject);
    }
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const forbidden = () => { throw new Error('this must not be called'); };
stub('../config/supabase', { from });
stub('../services/business.service', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: forbidden, addToWhatsappQueueAndWait: forbidden });
stub('../services/whatsapp.service', new Proxy({}, { get: () => forbidden }));
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', {});
stub('../services/payment.service', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../middleware/auth.middleware', { protect: (req, res, next) => next() });
stub('../middleware/business.middleware', { requireBusiness: (req, res, next) => next() });
stub('../middleware/role.middleware', { requireRole: (...roles) => Object.assign((req, res, next) => next(), { roles }) });

const { markConversationRead } = require('./message.controller');

const call = async (customerId, businessId = 'b1') => {
  let status = 200; let body; let error = null;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await markConversationRead({ params: { customerId }, user: { businessId } }, res, (e) => { error = e; });
  return { status, body, error };
};

const row = (id, over) => ({ id, business_id: 'b1', customer_id: 'c1', direction: 'inbound', is_read: false, ...over });

test.beforeEach(() => {
  failWith = null; updates = [];
  rows = [
    row('in-unread-1'), row('in-unread-2'),
    row('in-read', { is_read: true }),
    row('out-unread', { direction: 'outbound' }),
    row('other-customer', { customer_id: 'c2' }),
    row('other-business', { business_id: 'b2' })
  ];
});

const readState = () => Object.fromEntries(rows.map(r => [r.id, r.is_read]));

test('marks the unread inbound messages of that conversation read and says how many', async () => {
  const { status, body } = await call('c1');
  assert.equal(status, 200);
  assert.deepEqual(body.data, { customerId: 'c1', updated: 2 });
  assert.deepEqual(readState(), {
    'in-unread-1': true, 'in-unread-2': true, 'in-read': true,
    'out-unread': false, 'other-customer': false, 'other-business': false
  });
});

test('it is a single UPDATE, scoped by business, customer, direction and is_read', async () => {
  await call('c1');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].patch, { is_read: true });
  assert.deepEqual(updates[0].filters, ['business_id=b1', 'customer_id=c1', 'direction=inbound', 'is_read=false']);
});

test("another business's customer id updates nothing and answers 0", async () => {
  const { status, body } = await call('c1', 'b3');
  assert.equal(status, 200);
  assert.equal(body.data.updated, 0);
  assert.equal(readState()['in-unread-1'], false);
});

test('a conversation with nothing unread answers 0, and a repeat changes nothing', async () => {
  await call('c1');
  const again = await call('c1');
  assert.equal(again.body.data.updated, 0);
});

test('a database error goes to the error handler', async () => {
  failWith = { message: 'boom' };
  const { error } = await call('c1');
  assert.equal(error.message, 'boom');
});

test('the route lets owner, staff and superadmin in, and sits before /:id/read', () => {
  const routes = require('../routes/message.routes');
  const layers = routes.stack.filter(l => l.route);
  const index = (path) => layers.findIndex(l => l.route.path === path && l.route.methods.put);
  assert.ok(index('/customer/:customerId/read') >= 0);
  assert.ok(index('/customer/:customerId/read') < index('/:id/read'));
  const guard = layers[index('/customer/:customerId/read')].route.stack.map(h => h.handle).find(h => h.roles);
  assert.deepEqual(guard.roles, ['owner', 'staff', 'superadmin']);
});
