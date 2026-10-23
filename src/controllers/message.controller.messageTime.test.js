// Run: node --test src/controllers/message.controller.messageTime.test.js
// Chat order is WhatsApp's send time (messages.wa_timestamp), not when the webhook reached us
// (created_at): a delayed webhook sorts by wa_timestamp. Also the `before` cursor and the
// conversations list's lastMessageType / lastMessageOriginalType. The fake database computes
// message_time = coalesce(wa_timestamp, created_at) like the generated column does.
const test = require('node:test');
const assert = require('node:assert/strict');

let messages; let customers;
const withTime = (m) => ({ ...m, message_time: m.wa_timestamp || m.created_at });

const supabase = {
  from: (table) => {
    const filters = []; const orders = []; let lim = null; let rng = null; let head = false; let counted = false;
    const run = () => {
      let rows = (table === 'messages' ? messages.map(withTime) : customers).filter((r) => filters.every((f) => f(r)));
      const total = rows.length;
      for (const { col, asc } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      return { rows, total };
    };
    const q = {
      select: (c, opts) => { counted = !!opts?.count; head = !!opts?.head; return q; },
      eq: (c, v) => { filters.push((r) => r[c] === v); return q; },
      lt: (c, v) => { filters.push((r) => r[c] < v); return q; },
      or: (expr) => { // only the cursor's  message_time.lt.T,and(message_time.eq.T,id.lt.ID)
        const m = /^message_time\.lt\.(.+?),and\(message_time\.eq\.(.+?),id\.lt\.(.+)\)$/.exec(expr);
        assert.ok(m && m[1] === m[2], `unexpected or(): ${expr}`);
        filters.push((r) => r.message_time < m[1] || (r.message_time === m[1] && r.id < m[3]));
        return q;
      },
      not: () => q,
      order: (col, o) => { orders.push({ col, asc: o?.ascending !== false }); return q; },
      limit: (n) => { lim = n; return q; },
      range: (a, b) => { rng = [a, b]; return q; },
      maybeSingle: async () => ({ data: run().rows[0] || null, error: null }),
      then: (resolve, reject) => {
        const { rows, total } = run();
        return Promise.resolve({ data: head ? null : rows, error: null, count: counted ? total : null }).then(resolve, reject);
      }
    };
    return q;
  }
};
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', supabase);
stub('../services/business.service', {});
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async () => {} });
stub('./customer.controller', { withWindowExpiresAt: (c) => c });
stub('../services/customerPipeline.service', {});
stub('../services/payment.service', {});
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const { getChatHistory, getConversations } = require('./message.controller');

const msg = (id, created_at, wa_timestamp, extra = {}) => ({
  id, business_id: 'b1', customer_id: 'c1', direction: 'inbound', type: 'text', content: id, created_at, wa_timestamp: wa_timestamp || null, ...extra
});

const history = async (query = {}) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await getChatHistory({ params: { customerId: 'c1' }, query, user: { businessId: 'b1' } }, res, (e) => { throw e; });
  return res;
};
const ids = (res) => res.body.data.messages.map((m) => m.id);

test.beforeEach(() => {
  customers = [{ id: 'c1', business_id: 'b1', whatsapp_number: '919800000001', last_message_at: '2026-10-01T00:00:00Z', last_activity_at: '2026-10-01T00:00:00Z' }];
  // m2 was sent at 10:01 but its webhook only arrived at 10:30, after m3 (sent 10:02, stored 10:02:01).
  messages = [
    msg('m1', '2026-10-01T10:00:01Z', '2026-10-01T10:00:00Z'),
    msg('m3', '2026-10-01T10:02:01Z', '2026-10-01T10:02:00Z'),
    msg('m2', '2026-10-01T10:30:00Z', '2026-10-01T10:01:00Z'), // delayed webhook
    msg('m4', '2026-10-01T10:03:00Z', null, { direction: 'outbound' }) // ApnaBot send: no wa_timestamp
  ];
});

test('a delayed webhook sorts by its WhatsApp time, not by when it arrived', async () => {
  assert.deepEqual(ids(await history()), ['m1', 'm2', 'm3', 'm4']);
});

test('messageTime = waTimestamp, else createdAt; waTimestamp is returned', async () => {
  const byId = Object.fromEntries((await history()).body.data.messages.map((m) => [m.id, m]));
  assert.equal(byId.m2.waTimestamp, '2026-10-01T10:01:00Z');
  assert.equal(byId.m2.createdAt, '2026-10-01T10:30:00Z');
  assert.equal(byId.m2.messageTime, '2026-10-01T10:01:00Z');
  assert.equal(byId.m4.waTimestamp, null);
  assert.equal(byId.m4.messageTime, '2026-10-01T10:03:00Z');
});

test('page/limit still works for old clients: page 1 is the newest, each page oldest-first', async () => {
  assert.deepEqual(ids(await history({ page: 1, limit: 2 })), ['m3', 'm4']);
  assert.deepEqual(ids(await history({ page: 2, limit: 2 })), ['m1', 'm2']);
});

test('before=: the `limit` messages older than the cursor, oldest-first; walking back reaches everything once', async () => {
  const first = await history({ limit: 2 });
  assert.deepEqual(ids(first), ['m3', 'm4']);
  const second = await history({ before: first.body.data.messages[0].messageTime, limit: 2 }); // before 10:02:00
  assert.deepEqual(ids(second), ['m1', 'm2']);
  assert.equal(second.body.data.pagination.hasMore, false);
  const third = await history({ before: second.body.data.messages[0].messageTime, limit: 2 }); // before 10:00:00
  assert.deepEqual(ids(third), []);
});

test('before=: hasMore is true while older messages remain; the cursor is strict', async () => {
  const res = await history({ before: '2026-10-01T10:03:00Z', limit: 2 }); // older than m4: m3, m2, m1 -> newest two
  assert.deepEqual(ids(res), ['m2', 'm3']);
  assert.equal(res.body.data.pagination.hasMore, true);
  assert.deepEqual(ids(await history({ before: '2026-10-01T10:02:00Z', limit: 5 })), ['m1', 'm2']); // m3 itself excluded
});

test('cursor <messageTime>|<id>: same-second messages are neither repeated nor skipped across pages', async () => {
  const T = '2026-10-01T12:00:00Z';
  messages = ['a', 'b', 'c', 'd', 'e'].map((id, i) => msg(id, `2026-10-01T12:00:0${i}Z`, T)); // five sent in one second
  const seen = [];
  let res = await history({ limit: 2 });
  seen.unshift(...ids(res));
  let guard = 0;
  while (res.body.data.pagination.nextCursor && guard++ < 10) {
    res = await history({ before: res.body.data.pagination.nextCursor, limit: 2 });
    seen.unshift(...ids(res));
  }
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(res.body.data.pagination.nextCursor, null);
});

test('nextCursor is <messageTime>|<id> of the oldest message returned, null when nothing is older', async () => {
  const first = await history({ limit: 2 });
  assert.equal(first.body.data.pagination.nextCursor, '2026-10-01T10:02:00Z|m3');
  const last = await history({ limit: 10 });
  assert.equal(last.body.data.pagination.nextCursor, null);
  assert.equal((await history({ page: 2, limit: 2 })).body.data.pagination.nextCursor, null);
});

test('a cursor with an unencoded + offset (arrives as a space) is repaired; the id half is optional', async () => {
  messages = [msg('x', '2026-10-01T10:00:00+00:00', '2026-10-01T10:00:00+00:00'), msg('y', '2026-10-01T09:00:00+00:00', '2026-10-01T09:00:00+00:00')];
  assert.deepEqual(ids(await history({ before: '2026-10-01T10:00:00 00:00|y' })), ['y', 'x']); // x ties the time, its id sorts before y
  assert.deepEqual(ids(await history({ before: '2026-10-01T10:00:00+00:00' })), ['y']);
});

test('before= that is not a date is a 400', async () => {
  assert.equal((await history({ before: 'yesterday-ish' })).statusCode, 400);
});

const conversations = async () => {
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  await getConversations({ query: {}, user: { businessId: 'b1' } }, res, (e) => { throw e; });
  return res.body.data.conversations;
};

test('conversations: the last message is the latest by WhatsApp time, with lastMessageType', async () => {
  // 'b' was stored later but sent earlier (09:00) than 'a' (10:00)
  messages = [msg('a', '2026-10-01T10:00:00Z', null), msg('b', '2026-10-01T11:00:00Z', '2026-10-01T09:00:00Z', { type: 'image', content: '📷 Photo' })];
  const [c] = await conversations();
  assert.equal(c.lastMessage, 'a');
  assert.equal(c.lastMessageType, 'text');
  assert.equal(c.lastMessageOriginalType, null);
  assert.equal(c.lastMessageTime, '2026-10-01T10:00:00Z');
});

test('conversations: lastMessageOriginalType is the raw payload type, only for unsupported rows', async () => {
  messages = [msg('u', '2026-10-01T10:00:00Z', null, { type: 'unsupported', raw_payload: { type: 'revoke' } })];
  let [c] = await conversations();
  assert.equal(c.lastMessageType, 'unsupported');
  assert.equal(c.lastMessageOriginalType, 'revoke');
  messages = [msg('t', '2026-10-01T10:00:00Z', null, { type: 'text', raw_payload: { type: 'text' } })];
  [c] = await conversations();
  assert.equal(c.lastMessageOriginalType, null);
  messages = [];
  [c] = await conversations();
  assert.equal(c.lastMessageType, null);
  assert.equal(c.lastMessageTime, null);
});
