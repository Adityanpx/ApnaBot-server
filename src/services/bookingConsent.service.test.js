// Run: node --test src/services/bookingConsent.service.test.js
// bookingConsent.service against an in-memory stand-in for Supabase; the
// queue, usage and socket are stubbed — nothing touches a real database,
// Redis or WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');

const BIZ = 'b1';
const NUMBER = '919800000001';
const HOUR = 3600 * 1000;

let db; let setting; let queued; let failBusiness; let failClaim;

// eq / is / select / update / insert / maybeSingle / single / await.
const from = (table) => {
  const filters = []; let op = 'select'; let payload;
  const rows = () => (db[table] = db[table] || []);
  const matching = () => rows().filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'insert') { const row = { id: `${table}-${rows().length + 1}`, ...payload }; rows().push(row); return { data: [row], error: null }; }
    if (op === 'update') {
      if (failClaim && table === 'customers' && 'consent_prompted_at' in payload) return { data: null, error: { message: 'boom' } };
      const m = matching(); m.forEach(r => Object.assign(r, payload)); return { data: m.map(r => ({ ...r })), error: null };
    }
    return { data: matching().map(r => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    is: (c, v) => { filters.push(r => (r[c] ?? null) === v); return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    maybeSingle: async () => ({ data: run().data[0] || null, error: null }),
    single: async () => ({ data: run().data[0] || null, error: null }),
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub('../config/redis', {});
stub('../config/queueConnection', { queueConnection: {}, workerConnection: {} });
stub('./business.service', {
  getBusinessById: async () => {
    if (failBusiness) throw new Error('db down');
    return { id: BIZ, askConsentAfterBooking: setting };
  }
});
stub('./usage.service', { incrementUsage: async () => {} });
stub('./socket.service', { emitToBusiness: () => {} });
stub('../queues/whatsapp.queue', { addToWhatsappQueue: async (job) => { queued.push(job); } });

const service = require('./bookingConsent.service');

const customerRow = (over = {}) => ({
  id: 'c1', business_id: BIZ, whatsapp_number: NUMBER, preferred_language: 'en',
  opted_in: false, opted_in_at: null, opt_in_source: null, opt_in_link_id: null, opted_out_at: null,
  is_blocked: false, bot_paused_until: null, consent_prompted_at: null, consent_prompt_result: null,
  last_message_at: new Date().toISOString(), ...over
});
const customer = () => db.customers.find(c => c.id === 'c1');

test.beforeEach(() => {
  db = { customers: [customerRow()], messages: [] };
  setting = true; queued = []; failBusiness = false; failClaim = false;
});

// ── isEligible ──

test('isEligible: a customer never asked, not opted in, not out, not blocked, not paused', () => {
  assert.equal(service.isEligible(customerRow()), true);
  assert.equal(service.isEligible(customerRow({ bot_paused_until: new Date(Date.now() - HOUR).toISOString() })), true); // pause over
});

test('isEligible: no when already asked, opted in, sent STOP, blocked, paused, or no row', () => {
  assert.equal(service.isEligible(customerRow({ consent_prompted_at: '2026-10-01T00:00:00Z' })), false);
  assert.equal(service.isEligible(customerRow({ opted_in: true })), false);
  assert.equal(service.isEligible(customerRow({ opted_out_at: '2026-10-01T00:00:00Z' })), false);
  assert.equal(service.isEligible(customerRow({ is_blocked: true })), false);
  assert.equal(service.isEligible(customerRow({ bot_paused_until: new Date(Date.now() + HOUR).toISOString() })), false);
  assert.equal(service.isEligible(null), false);
});

// ── claimAfterBooking ──

test('claim: setting off → null, and the customer row is not read or written', async () => {
  setting = false;
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
  assert.equal(customer().consent_prompted_at, null);
});

test('claim: eligible customer is claimed once; the second booking does not ask again', async () => {
  const first = await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER });
  assert.equal(first.id, 'c1');
  assert.ok(first.consentPromptedAt);
  assert.ok(customer().consent_prompted_at);
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
});

test('claim: skips opted in, STOP, blocked, paused and unknown customers', async () => {
  for (const over of [
    { opted_in: true },
    { opted_out_at: '2026-10-01T00:00:00Z' },
    { is_blocked: true },
    { bot_paused_until: new Date(Date.now() + HOUR).toISOString() }
  ]) {
    db.customers = [customerRow(over)];
    assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null, JSON.stringify(over));
    assert.equal(customer().consent_prompted_at, null);
  }
  db.customers = [];
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
});

test('claim: a customer asked on an earlier booking is never asked again', async () => {
  db.customers = [customerRow({ consent_prompted_at: '2026-09-01T00:00:00Z', consent_prompt_result: 'no' })];
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
});

test('claim: lost race — the atomic update finds the marker already set → null', async () => {
  // The read sees an unasked customer; by the time the update runs, another request claimed it.
  const realFrom = from;
  let selects = 0;
  stub('../config/supabase', {
    from: (table) => {
      const q = realFrom(table);
      if (table !== 'customers') return q;
      const origMaybe = q.maybeSingle;
      q.maybeSingle = async () => {
        const res = await origMaybe();
        if (selects++ === 0) customer().consent_prompted_at = '2026-10-10T00:00:00Z';
        return res;
      };
      return q;
    }
  });
  delete require.cache[require.resolve('./bookingConsent.service')];
  const racing = require('./bookingConsent.service');
  assert.equal(await racing.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
  stub('../config/supabase', { from });
  delete require.cache[require.resolve('./bookingConsent.service')];
});

test('claim: windowCheck (web form) — closed window → null and no claim; open window claims', async () => {
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER, windowCheck: () => false }), null);
  assert.equal(customer().consent_prompted_at, null);
  const claimed = await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER, windowCheck: (row) => row.id === 'c1' });
  assert.equal(claimed.id, 'c1');
});

test('claim: errors are caught and logged, never thrown (the confirmation always goes out)', async () => {
  failBusiness = true;
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
  failBusiness = false; failClaim = true;
  assert.equal(await service.claimAfterBooking({ businessId: BIZ, customerNumber: NUMBER }), null);
  assert.equal(customer().consent_prompted_at, null);
});

// ── handleBookingConsentTap ──

const asked = (over = {}) => { db.customers = [customerRow({ consent_prompted_at: '2026-10-10T00:00:00Z', ...over })]; };

test('tap yes: opts in as booking_prompt, no link, records the result', async () => {
  asked();
  const res = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'yes' });
  assert.equal(res.answered, true);
  assert.equal(res.newlyOptedIn, true);
  assert.equal(res.customer.optedIn, true);
  assert.equal(customer().opted_in, true);
  assert.ok(customer().opted_in_at);
  assert.equal(customer().opt_in_source, 'booking_prompt');
  assert.equal(customer().opt_in_link_id, null);
  assert.equal(customer().consent_prompt_result, 'yes');
});

test('tap yes after a STOP in between: result recorded, NOT opted in, opted_out_at kept', async () => {
  asked({ opted_out_at: '2026-10-10T01:00:00Z' });
  const res = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'yes' });
  assert.equal(res.answered, true);
  assert.equal(res.newlyOptedIn, false);
  assert.equal(customer().opted_in, false);
  assert.equal(customer().opted_out_at, '2026-10-10T01:00:00Z');
  assert.equal(customer().consent_prompt_result, 'yes');
});

test('tap yes when already opted in another way: source untouched, not "newly" opted in', async () => {
  asked({ opted_in: true, opt_in_source: 'manual' });
  const res = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'yes' });
  assert.equal(res.newlyOptedIn, false);
  assert.equal(customer().opt_in_source, 'manual');
});

test('tap no: records declined, changes nothing else', async () => {
  asked();
  const res = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'no' });
  assert.equal(res.answered, true);
  assert.equal(res.newlyOptedIn, false);
  assert.equal(customer().consent_prompt_result, 'no');
  assert.equal(customer().opted_in, false);
  assert.equal(customer().opt_in_source, null);
});

test('a repeat tap on the same buttons is ignored (first answer stands)', async () => {
  asked();
  await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'no' });
  const again = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'yes' });
  assert.equal(again.answered, false);
  assert.equal(customer().consent_prompt_result, 'no');
  assert.equal(customer().opted_in, false);
});

// ── sendQuestion ──

test('sendQuestion: one text message with Yes/No buttons optin_yes:booking / optin_no:booking, in the customer\'s language', async () => {
  asked({ preferred_language: 'hi' });
  await service.sendQuestion({
    businessId: BIZ, phoneNumberId: 'pn1', encryptedAccessToken: 'tok', businessName: 'SG Travels',
    customer: { id: 'c1', preferredLanguage: 'hi' }, customerNumber: NUMBER
  });
  assert.equal(queued.length, 1);
  const job = queued[0];
  assert.equal(job.to, NUMBER);
  assert.ok(job.message.includes('SG Travels'));
  assert.ok(job.message.includes('STOP'));
  assert.deepEqual(job.buttons.map(b => b.nextKeyword), ['optin_yes:booking', 'optin_no:booking']);
  assert.equal(job.messageId, db.messages[0].id);
  assert.equal(db.messages[0].content, job.message);
  assert.equal(db.messages[0].sender_type, 'bot');
});

test('tap yes does not clear marketing_blocked_at: only Meta\'s resume, START or the owner do', async () => {
  asked({ marketing_blocked_at: '2026-10-01T10:00:00Z' });
  const res = await service.handleBookingConsentTap({ id: 'c1' }, { answer: 'yes' });
  assert.equal(res.newlyOptedIn, true);
  assert.equal(customer().opted_in, true);
  assert.equal(customer().marketing_blocked_at, '2026-10-01T10:00:00Z');
});
