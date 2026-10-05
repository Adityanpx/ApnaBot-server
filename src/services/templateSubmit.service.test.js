// Run: node --test src/services/templateSubmit.service.test.js
// The shared Meta submit: validation first, the resumable header upload with the
// BUSINESS token, the create payload — and the demo reminder template going
// through it with exactly the payload it sent before the refactor.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let calls; let failOn; let templateRows; let inserted;
const axios = {
  get: async (url) => { calls.push({ method: 'get', url }); return { data: Buffer.from('imagebytes'), headers: { 'content-type': 'application/octet-stream' } }; },
  post: async (url, data, options) => {
    calls.push({ method: 'post', url, data, options });
    if (failOn && url.includes(failOn)) { const e = new Error('meta said no'); e.response = { data: { error: 'bad' } }; throw e; }
    if (url.endsWith('/uploads')) return { data: { id: 'upload:SESSION' } };
    if (url.endsWith('/upload:SESSION')) return { data: { h: 'HANDLE123' } };
    return { data: { id: 'meta-tpl-1', status: 'PENDING' } };
  }
};
stub('axios', axios);
stub('../config/env', { META_APP_ID: 'APP1', META_APP_SECRET: 'SECRET' });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { decrypt: (v) => `dec(${v})` });
stub('./whatsapp.service', { META_API_BASE: 'https://graph.example/v25.0' });
stub('./business.service', { getBusinessById: async () => ({ id: 'b1', wabaId: 'WABA1', accessToken: 'enc' }) });
stub('../config/supabase', {
  from: () => {
    const q = {
      select: () => q, eq: () => q,
      maybeSingle: async () => ({ data: templateRows[0] || null, error: null }),
      insert: (row) => { inserted = row; return { select: () => ({ single: async () => ({ data: { id: 't1', ...row }, error: null }) }) }; },
      update: (payload) => ({ eq: () => ({ select: () => ({ single: async () => ({ data: { id: 't1', ...payload }, error: null }) }) }) })
    };
    return q;
  }
});

const { submitTemplateToMeta, TemplateValidationError, validateForSubmit } = require('./templateSubmit.service');
const { ensureReminderTemplate } = require('./demoReminderTemplate.service');
const { REMINDER_TEMPLATE } = require('../utils/demoReminder');

const business = { wabaId: 'WABA1' };
const row = (over) => ({
  name: 'booking_confirmed', category: 'UTILITY', language: 'en_US',
  meta_components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Your booking {{1}} is confirmed.', example: { body_text: [['SG1042']] } }],
  header_media_url: 'https://r2.example/business-media/b1-1.jpeg', ...over
});

test.beforeEach(() => { calls = []; failOn = null; templateRows = []; inserted = null; });

test('media header: uploads with the BUSINESS token (not the app token), then creates with the header_handle', async () => {
  const response = await submitTemplateToMeta(business, 'BIZTOKEN', row());
  assert.equal(response.id, 'meta-tpl-1');

  const [download, session, upload, create] = calls;
  assert.equal(download.url, 'https://r2.example/business-media/b1-1.jpeg');
  assert.equal(session.url, 'https://graph.example/v25.0/APP1/uploads');
  assert.deepEqual(session.options.params, { file_length: 10, file_type: 'image/jpeg', access_token: 'BIZTOKEN' }); // mime from the extension, not R2's octet-stream
  assert.equal(upload.url, 'https://graph.example/v25.0/upload:SESSION');
  assert.equal(upload.options.headers.Authorization, 'OAuth BIZTOKEN');
  assert.equal(upload.options.headers.file_offset, '0');
  assert.equal(create.url, 'https://graph.example/v25.0/WABA1/message_templates');
  assert.equal(create.options.headers.Authorization, 'Bearer BIZTOKEN');
  assert.deepEqual(create.data.components[0], { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['HANDLE123'] } });
  assert.ok(!JSON.stringify(calls).includes('SECRET'), 'the app secret is never sent');
});

test('VIDEO and DOCUMENT upload with their own mime type', async () => {
  for (const [format, url, mime] of [['VIDEO', 'https://r2.example/v.mp4', 'video/mp4'], ['DOCUMENT', 'https://r2.example/f.pdf', 'application/pdf']]) {
    calls = [];
    await submitTemplateToMeta(business, 'T', row({ meta_components: [{ type: 'HEADER', format }, { type: 'BODY', text: 'Hi.' }], header_media_url: url }));
    assert.equal(calls[1].options.params.file_type, mime);
  }
});

test('no header media: nothing is uploaded, body-only create', async () => {
  await submitTemplateToMeta(business, 'T', row({ meta_components: [{ type: 'BODY', text: 'Hi.' }] }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.example/v25.0/WABA1/message_templates');
});

test('a media header with no file attached is refused before Meta is called', async () => {
  await assert.rejects(submitTemplateToMeta(business, 'T', row({ header_media_url: null })), (e) => e instanceof TemplateValidationError && /Attach a header/.test(e.message));
  assert.equal(calls.length, 0);
});

test('validation runs first: nothing is sent for an invalid template', async () => {
  const bad = row({ name: 'Bad Name', language: 'fr', meta_components: [{ type: 'BODY', text: '{{1}} hi' }] });
  await assert.rejects(submitTemplateToMeta(business, 'T', bad), (e) => e instanceof TemplateValidationError && e.errors.length >= 3);
  assert.equal(calls.length, 0);
  // variables without samples (a draft) cannot be submitted
  assert.match(validateForSubmit(row({ meta_components: [{ type: 'BODY', text: 'Hi {{1}}.' }] }))[0], /sample/);
});

test('failures are tagged by stage with the Meta response attached', async () => {
  failOn = '/uploads';
  await assert.rejects(submitTemplateToMeta(business, 'T', row()), (e) => e.templateStage === 'upload' && e.response.data.error === 'bad');
  failOn = '/message_templates';
  calls = [];
  await assert.rejects(submitTemplateToMeta(business, 'T', row()), (e) => e.templateStage === 'create');
});

test('demo reminder template: submitted with exactly the payload it used before', async () => {
  await ensureReminderTemplate('b1');
  assert.equal(calls.length, 1);
  const [create] = calls;
  assert.equal(create.url, 'https://graph.example/v25.0/WABA1/message_templates');
  assert.deepEqual(create.data, {
    name: REMINDER_TEMPLATE.name,
    category: REMINDER_TEMPLATE.category,
    language: REMINDER_TEMPLATE.language,
    components: [{ type: 'BODY', text: REMINDER_TEMPLATE.bodyText, example: { body_text: [REMINDER_TEMPLATE.variableSamples] } }]
  });
  assert.equal(JSON.stringify(create.data), JSON.stringify({
    name: 'apnabot_demo_class', category: 'UTILITY', language: 'en_US',
    components: [{ type: 'BODY', text: REMINDER_TEMPLATE.bodyText, example: { body_text: [REMINDER_TEMPLATE.variableSamples] } }]
  }), 'same key order too');
  assert.deepEqual(create.options, { headers: { Authorization: 'Bearer dec(enc)', 'Content-Type': 'application/json' } });
  assert.equal(inserted.header_type, 'NONE');
});
