// Run: node --test src/controllers/broadcast.controller.params.test.js
// #6 Phase 2: broadcasts with a media header, a TEXT-header variable or URL
// buttons — what createBroadcast / sendBroadcast accept, the components the
// worker is handed, and the send-time re-check (a template that changed since
// the draft was made is refused with a reason, nothing queued or debited).
const test = require('node:test');
const assert = require('node:assert/strict');

let templateRow; let draft;
const inserted = [];
const supabase = {
  from: (table) => {
    const q = {
      select: () => q,
      eq: () => q,
      insert: (row) => { inserted.push(row); return q; },
      update: () => q,
      single: async () => ({ data: { id: 'new', ...inserted[inserted.length - 1] }, error: null }),
      maybeSingle: async () => ({ data: table === 'broadcasts' ? draft : templateRow, error: null })
    };
    return q;
  }
};
const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const queued = [];
const debits = [];
stub('../config/supabase', supabase);
stub('../config/env', { WALLET_BILLING_ENABLED: true, MAX_BROADCAST_RECIPIENTS: 1000 });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../services/business.service', { getBusinessById: async () => ({ isWhatsappConnected: true, phoneNumberId: 'p', accessToken: 'x' }) });
stub('../services/wallet.service', { debitWallet: async (...a) => { debits.push(a); } });
stub('../services/rateCard.service', { getRateForMessage: async () => 80 });
stub('../queues/broadcast.queue', { addToBroadcastQueue: async (job) => { queued.push(job); } });
stub('../services/broadcastAudience.service', {
  normalizeAudience: () => ({ filter: 'all_customers', params: {} }),
  resolveAudience: async () => [{ id: 'c1', whatsapp_number: '911', name: 'A' }],
  businessGroupIds: async () => []
});
const { createBroadcast, sendBroadcast } = require('./broadcast.controller');

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ user: { businessId: 'b' }, params: {}, body: {}, ...req }, res, (err) => { throw err; });
  return res;
};

const base = { id: 't', business_id: 'b', name: 'promo', status: 'approved', category: 'MARKETING', language: 'en_US', send_support: 'ok' };
const imageTpl = { ...base, header_type: 'IMAGE', body_text: 'Hi', header_media_url: 'https://r2/x.jpeg' };
const videoTpl = { ...base, header_type: 'VIDEO', body_text: 'Hi', header_media_url: 'https://r2/x.mp4' };
const docTpl = { ...base, header_type: 'DOCUMENT', body_text: 'Hi', header_media_url: 'https://r2/x.pdf', header_media_filename: 'Fees.pdf' };
// TEXT header variable + body variable + phone button + dynamic URL button (index 1) + static URL (index 2)
const richTpl = {
  ...base, header_type: 'TEXT', body_text: 'Pay for {{1}}',
  meta_components: [
    { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
    { type: 'BODY', text: 'Pay for {{1}}' },
    { type: 'BUTTONS', buttons: [
      { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' },
      { type: 'URL', text: 'Pay', url: 'https://x.com/{{1}}' },
      { type: 'URL', text: 'Terms', url: 'https://x.com/terms' }
    ] }
  ]
};
const richMapping = [
  { position: 1, source: 'static', value: 'the course' },
  { target: 'header', source: 'customer.name' },
  { target: 'button', buttonIndex: 1, source: 'static', value: 'abc123' }
];
const withDraft = (over) => { draft = { id: 'bc', business_id: 'b', template_id: 't', status: 'draft', template_variables: [], variable_mapping: null, ...over }; };

test.beforeEach(() => { inserted.length = 0; queued.length = 0; debits.length = 0; withDraft(); });

test('send: IMAGE / VIDEO / DOCUMENT headers go to the worker as the right media component', async () => {
  const expected = [
    [imageTpl, [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://r2/x.jpeg' } }] }]],
    [videoTpl, [{ type: 'header', parameters: [{ type: 'video', video: { link: 'https://r2/x.mp4' } }] }]],
    [docTpl, [{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://r2/x.pdf', filename: 'Fees.pdf' } }] }]]
  ];
  for (const [tpl, components] of expected) {
    queued.length = 0;
    templateRow = tpl;
    const res = await call(sendBroadcast, { params: { id: 'bc' } });
    assert.equal(res.statusCode, 200, tpl.header_type);
    assert.deepEqual(queued[0].components, components, tpl.header_type);
  }
});

test('send: a media template whose header media is gone is refused even though send_support still says ok', async () => {
  templateRow = { ...videoTpl, header_media_url: null };
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /header needs an image, video or PDF/);
  assert.equal(queued.length + debits.length, 0);
});

test('send: a template that gained a copy-code button since the draft is refused, nothing queued or debited', async () => {
  templateRow = { ...richTpl, meta_components: [...richTpl.meta_components.slice(0, 2), { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', text: 'Yes' }] }] };
  withDraft({ variable_mapping: richMapping });
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /can't be sent yet: it has buttons/);
  assert.equal(queued.length + debits.length, 0);
});

test('create: header variable and dynamic URL button need a mapping that fills them', async () => {
  templateRow = richTpl;
  const create = (body) => call(createBroadcast, { body: { name: 'B', templateId: 't', ...body } });

  assert.equal((await create({ variableMapping: richMapping })).statusCode, 201);

  // body filled by the shared templateVariables list only — not enough for header / button
  let res = await create({ templateVariables: ['the course'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /variableMapping is required/);

  res = await create({ variableMapping: richMapping.filter(e => e.target !== 'header') });
  assert.match(res.body.message, /header has a variable/);
  res = await create({ variableMapping: richMapping.filter(e => e.target !== 'button') });
  assert.match(res.body.message, /URL button 1/);
  res = await create({ variableMapping: richMapping.map(e => (e.target === 'button' ? { ...e, buttonIndex: 2 } : e)) });
  assert.match(res.body.message, /not a URL button with a variable/);
  res = await create({ variableMapping: richMapping.filter(e => e.target) }); // no body entry
  assert.match(res.body.message, /requires 1 variable/);
});

test('create: header / button sources — header takes customer.name or static, buttons only static', async () => {
  templateRow = richTpl;
  const create = (variableMapping) => call(createBroadcast, { body: { name: 'B', templateId: 't', variableMapping } });
  let res = await create(richMapping.map(e => (e.target === 'button' ? { ...e, source: 'customer.name' } : e)));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /button variable's source must be one of: static/);
  res = await create(richMapping.map(e => (e.target === 'button' ? { ...e, source: 'booking.code' } : e)));
  assert.equal(res.statusCode, 400);
  res = await create(richMapping.map(e => (e.target === 'button' ? { ...e, value: '  ' } : e)));
  assert.match(res.body.message, /needs that value/);
  res = await create(richMapping.map(e => (e.target === 'header' ? { ...e, source: 'business.name' } : e)));
  assert.match(res.body.message, /header variable's source must be one of: customer.name, static/);
});

test('create: mapping entries for a header / button the template does not have are refused', async () => {
  templateRow = { ...base, header_type: 'NONE', body_text: 'Hi {{1}}' };
  const res = await call(createBroadcast, { body: { name: 'B', templateId: 't', variableMapping: [{ position: 1, source: 'static', value: 'x' }, { target: 'header', source: 'static', value: 'y' }] } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /no header variable/);
});

test('create: body-only template + body-only mapping validates exactly as before (and templateVariables still work)', async () => {
  templateRow = { ...base, header_type: 'NONE', body_text: 'Hi {{1}}' };
  const create = (body) => call(createBroadcast, { body: { name: 'B', templateId: 't', ...body } });
  assert.equal((await create({ templateVariables: ['x'] })).statusCode, 201);
  assert.equal((await create({ variableMapping: [{ position: 1, source: 'customer.name' }] })).statusCode, 201);
  const res = await create({});
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /requires 1 variable\(s\); provide templateVariables or variableMapping/);
});

test('create: static URL + phone buttons need nothing; dynamic URL alone needs the button entry', async () => {
  templateRow = { ...base, header_type: 'NONE', body_text: 'Hi', meta_components: [{ type: 'BODY', text: 'Hi' }, { type: 'BUTTONS', buttons: [
    { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+91' }, { type: 'URL', text: 'Site', url: 'https://x.com' }] }] };
  assert.equal((await call(createBroadcast, { body: { name: 'B', templateId: 't' } })).statusCode, 201);
});

test('send: a draft made for a body-only template that now has a dynamic URL button is refused with the reason', async () => {
  templateRow = richTpl;
  withDraft({ variable_mapping: [{ position: 1, source: 'static', value: 'x' }, { target: 'header', source: 'customer.name' }] }); // no button entry
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /changed since the draft was made.*URL button 1/);
  assert.equal(queued.length + debits.length, 0);
});

test('send: the worker job carries the mapping (header var + button) and no per-recipient data in components', async () => {
  templateRow = richTpl;
  withDraft({ variable_mapping: richMapping });
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queued[0].variableMapping, richMapping);
  assert.deepEqual(queued[0].components, []); // TEXT header has no shared media header; body/header/buttons are per recipient
});

test('send: a quick-reply template - payload components are in the shared components and in the job data for the mapped path', async () => {
  const qrTpl = { ...base, header_type: 'NONE', body_text: 'Hi', meta_components: [
    { type: 'BODY', text: 'Hi' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }, { type: 'QUICK_REPLY', text: 'Stop promotions' }] }
  ] };
  const qr = (i) => ({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: `tpl:t:${i}` }] });
  templateRow = qrTpl;
  const res = await call(sendBroadcast, { params: { id: 'bc' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queued[0].components, [qr(0), qr(1)]);
  assert.deepEqual(queued[0].quickReplyComponents, [qr(0), qr(1)]);

  queued.length = 0;
  templateRow = imageTpl;
  await call(sendBroadcast, { params: { id: 'bc' } });
  assert.deepEqual(queued[0].quickReplyComponents, []); // templates without quick replies are untouched
});
