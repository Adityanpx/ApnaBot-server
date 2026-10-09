// Run: node --test src/controllers/message.controller.conversations.test.js
// GET /api/messages: the last-message preview. An 'unsupported' last message
// shows the friendly label even when the stored content is the old
// "⚠️ Message couldn't be displayed (type: unsupported, error 131051)…" text;
// other types show their stored content. Read-side only: nothing is written.
const test = require('node:test');
const assert = require('node:assert/strict');

const LABEL = "WhatsApp couldn't show this message here — open it in your WhatsApp Business app.";
const OLD = "⚠️ Message couldn't be displayed (type: unsupported, error 131051) - ask the customer to resend";

let customers; let lastByCustomer;
const selects = []; // [table, columns] for every select
const writes = [];
const supabase = {
  from: (table) => {
    let cols; let head = false; let customerId = null;
    const q = {
      select: (c, opts) => { cols = c; head = !!opts?.head; selects.push([table, c]); return q; },
      eq: (col, v) => { if (col === 'customer_id') customerId = v; return q; },
      not: () => q,
      order: () => q,
      insert: (r) => { writes.push(['insert', table, r]); return q; },
      update: (r) => { writes.push(['update', table, r]); return q; },
      range: async () => ({ data: customers, error: null, count: customers.length }),
      limit: () => q,
      maybeSingle: async () => ({ data: lastByCustomer[customerId] ?? null, error: null }),
      then: (resolve) => resolve(head ? { count: 0, error: null } : { data: [], error: null })
    };
    return q;
  }
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../config/supabase', supabase);
stub('../services/business.service', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', {});
stub('../services/payment.service', {});
const { getConversations } = require('./message.controller');

const run = async () => {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let err = null;
  await getConversations({ query: {}, user: { businessId: 'b1' } }, res, (e) => { err = e; });
  assert.equal(err, null);
  return res.body.data ? res.body.data.conversations : res.body.conversations;
};

test('getConversations: selects the last message type, maps unsupported to the label, leaves the rest, writes nothing', async () => {
  customers = [
    { id: 'c1', whatsapp_number: '911', last_message_at: '2026-10-01T00:00:00Z' },
    { id: 'c2', whatsapp_number: '922', last_message_at: '2026-10-01T00:00:00Z' },
    { id: 'c3', whatsapp_number: '933', last_message_at: '2026-10-01T00:00:00Z' },
    { id: 'c4', whatsapp_number: '944', last_message_at: '2026-10-01T00:00:00Z' }
  ];
  lastByCustomer = {
    c1: { content: OLD, direction: 'inbound', created_at: '2026-10-02T00:00:00Z', type: 'unsupported' }, // old row
    c2: { content: LABEL, direction: 'inbound', created_at: '2026-10-02T00:00:00Z', type: 'unsupported' }, // new row
    c3: { content: 'Hello there', direction: 'inbound', created_at: '2026-10-02T00:00:00Z', type: 'text' },
    c4: null // no messages
  };
  const conversations = await run();
  const byId = Object.fromEntries(conversations.map(c => [c._id, c]));
  assert.equal(byId.c1.lastMessage, LABEL);
  assert.equal(byId.c2.lastMessage, LABEL);
  assert.equal(byId.c3.lastMessage, 'Hello there');
  assert.equal(byId.c4.lastMessage, null);
  assert.equal(byId.c1.lastDirection, 'inbound');
  assert.ok(selects.some(([t, c]) => t === 'messages' && c === 'content, direction, created_at, type'), 'last-message select includes type');
  assert.deepEqual(writes, []);
});
