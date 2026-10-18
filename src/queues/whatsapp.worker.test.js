// Run: node --test src/queues/whatsapp.worker.test.js
// The outbound queue worker: after a send it marks the row sent AND saves
// Meta's wamid on it (so delivered / read status webhooks match). BullMQ, Meta
// and Supabase are stand-ins - no Redis, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let processor; let sendImpl; let sends;

const from = () => {
  const filters = []; let op = 'select'; let patch = null; let ids = null;
  const match = () => rows.filter(r => filters.every(f => f(r)));
  const run = () => {
    if (op === 'update') {
      const target = match();
      if (patch.meta_message_id !== undefined) {
        const clash = rows.some(r => !target.includes(r) && r.business_id === target[0].business_id && r.meta_message_id === patch.meta_message_id);
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      target.forEach(r => Object.assign(r, patch));
      return { data: target, error: null };
    }
    if (op === 'delete') { rows = rows.filter(r => !ids.includes(r.id)); return { data: null, error: null }; }
    return { data: match().map(r => ({ ...r })), error: null };
  };
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    update: (p) => { op = 'update'; patch = p; return q; },
    delete: () => { op = 'delete'; return q; },
    in: (c, vs) => { ids = vs; return q; },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
  };
  return q;
};

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test' });
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
const sendFn = (name) => async (...args) => { sends.push([name, args]); return sendImpl(name); };
stub('../services/whatsapp.service', {
  sendTextMessage: sendFn('text'), sendImageMessage: sendFn('image'), sendVideoMessage: sendFn('video'), sendLocationMessage: sendFn('location'),
  sendLocationRequest: sendFn('locationRequest'), sendInteractiveButtons: sendFn('buttons'), sendListMessage: sendFn('list'),
  sendRuleListMessage: sendFn('ruleList'), sendCtaUrlButton: sendFn('cta'), sendCarouselMessage: sendFn('carousel')
});
require('./whatsapp.worker');

const B = 'b1';
const job = (data, attemptsMade = 0) => ({ data: { businessId: B, phoneNumberId: 'pn', encryptedAccessToken: 'enc', to: '919800000001', message: 'hi', messageId: 'row1', ...data }, attemptsMade });
const response = (id) => ({ messaging_product: 'whatsapp', contacts: [{ wa_id: '919800000001' }], messages: [{ id }] });
const bot = () => ({ id: 'row1', business_id: B, direction: 'outbound', sender_type: 'bot', status: 'sent', meta_message_id: null });

test.beforeEach(() => { rows = [bot()]; sends = []; sendImpl = () => response('wamid.OUT1'); });

test('a text send: row marked sent with Meta\'s wamid saved on it', async () => {
  await processor(job({}));
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', 'wamid.OUT1']);
});

test('every send branch saves the wamid (text, image, buttons, list, rule list, CTA, location, location request)', async () => {
  const cases = [
    [{}, 'text'], [{ imageUrl: 'https://x/y.jpg' }, 'image'], [{ buttons: [{ title: 'A', nextKeyword: 'a' }] }, 'buttons'],
    [{ interactiveButtons: ['A'], step: 's' }, 'buttons'], [{ interactiveList: ['A'], step: 's' }, 'list'],
    [{ listOptions: [{ title: 'A' }] }, 'ruleList'], [{ ctaButton: { buttonText: 'Go', url: 'https://x' } }, 'cta'],
    [{ location: { latitude: 1, longitude: 2, name: 'n', address: 'a' } }, 'location'], [{ locationRequest: true }, 'locationRequest']
  ];
  for (const [data, branch] of cases) {
    rows = [bot()]; sends = [];
    sendImpl = () => response(`wamid.${branch}`);
    await processor(job(data));
    assert.equal(sends[0][0], branch);
    assert.equal(rows[0].meta_message_id, `wamid.${branch}`, branch);
    assert.equal(rows[0].status, 'sent', branch);
  }
});

test('a reply node\'s video goes out as a video message (link + caption) and saves the wamid', async () => {
  sendImpl = () => response('wamid.VID');
  await processor(job({ type: 'video', videoUrl: 'https://r2.test/v.mp4', message: '' }));
  assert.equal(sends[0][0], 'video');
  assert.deepEqual(sends[0][1].slice(3), ['https://r2.test/v.mp4', '']);
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', 'wamid.VID']);
});

test('type video without a videoUrl does not try to send a video', async () => {
  await processor(job({ type: 'video' }));
  assert.equal(sends[0][0], 'text');
});

test('Meta\'s status webhook now finds the row: its lookup key (meta_message_id) matches', async () => {
  await processor(job({}));
  const found = rows.filter(r => r.meta_message_id === 'wamid.OUT1');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'row1');
});

test('an echo row already holds the wamid: the echo is removed, the bot row keeps it, the job still succeeds', async () => {
  rows.push({ id: 'echo1', business_id: B, direction: 'outbound', sender_type: 'phone_app', status: 'sent', meta_message_id: 'wamid.OUT1' });
  const result = await processor(job({}));
  assert.deepEqual(result, { success: true });
  assert.deepEqual(rows.map(r => r.id), ['row1']);
  assert.equal(rows[0].meta_message_id, 'wamid.OUT1');
});

test('a send response without an id still marks the row sent and succeeds', async () => {
  sendImpl = () => ({ messaging_product: 'whatsapp' });
  assert.deepEqual(await processor(job({})), { success: true });
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', null]);
});

test('a job without a messageId (nothing to update) just sends', async () => {
  assert.deepEqual(await processor(job({ messageId: null })), { success: true });
  assert.equal(sends.length, 1);
});

test('a failed send is unchanged: row failed after the last attempt, error rethrown, no wamid', async () => {
  sendImpl = () => { throw new Error('meta down'); };
  await assert.rejects(() => processor(job({}, 2)), /meta down/);
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['failed', null]);
  rows = [bot()];
  await assert.rejects(() => processor(job({}, 0)), /meta down/);
  assert.equal(rows[0].status, 'sent'); // not the last attempt: left for the retry
});

test("the final failure keeps Meta's reason: code, title, details and failed_at", async () => {
  sendImpl = () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { data: { error: { code: 131047, type: 'OAuthException', message: 'Re-engagement message', error_data: { details: 'More than 24 hours' } } } } }); };
  await assert.rejects(() => processor(job({}, 2)), /400/);
  assert.deepEqual([rows[0].status, rows[0].error_code, rows[0].error_title, rows[0].error_details], ['failed', 131047, 'Re-engagement message', 'More than 24 hours']);
  assert.ok(!Number.isNaN(Date.parse(rows[0].failed_at)));
});

test('a final failure that is not a Meta rejection stores just the message, no code', async () => {
  sendImpl = () => { throw new Error('socket hang up'); };
  await assert.rejects(() => processor(job({}, 2)), /socket/);
  assert.deepEqual([rows[0].status, rows[0].error_code, rows[0].error_title], ['failed', null, 'socket hang up']);
});

// ---- carousel reply (type 'carousel') ----
const CARDS = [
  { index: 0, mediaType: 'image', mediaUrl: 'https://r2.test/a.jpeg', text: 'Deluxe', buttons: [{ nextKeyword: 'e1', title: 'Book' }] },
  { index: 1, mediaType: null, mediaUrl: null, text: 'Suite', buttons: [{ nextKeyword: 'e2', title: 'Book' }] }
];
const metaError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { message: 'nope' } } } });
const names = () => sends.map(([name]) => name);

test('a native carousel is sent as ONE Meta message and the row gets its wamid', async () => {
  await processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS }));
  assert.deepEqual(names(), ['carousel']);
  assert.deepEqual(sends[0][1].slice(3), ['hi', CARDS]);
  assert.deepEqual([rows[0].status, rows[0].meta_message_id], ['sent', 'wamid.OUT1']);
});

test('Meta rejects the carousel (4xx): the sequential fallback goes out, no retry, wamid of the first message', async () => {
  let n = 0;
  sendImpl = (name) => {
    if (name === 'carousel') throw metaError(400);
    return response(`wamid.F${++n}`);
  };
  await processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS }));
  // body text, then each card: buttons (image header only for a card that has an image), in order
  assert.deepEqual(names(), ['carousel', 'text', 'buttons', 'buttons']);
  assert.equal(sends[2][1][5], 'https://r2.test/a.jpeg');
  assert.equal(sends[3][1][5], null, 'a card without media is text + buttons only');
  assert.deepEqual(sends[3][1].slice(3, 5), ['Suite', [{ nextKeyword: 'e2', title: 'Book' }]]);
  assert.equal(rows[0].meta_message_id, 'wamid.F1');
  assert.equal(rows[0].status, 'sent');
});

test('Meta 5xx / network error on the carousel is thrown so the queue retries; no fallback yet', async () => {
  sendImpl = () => { throw metaError(503); };
  await assert.rejects(() => processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS })), /503/);
  assert.deepEqual(names(), ['carousel']);

  sends = [];
  sendImpl = () => { throw new Error('ECONNRESET'); };
  await assert.rejects(() => processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS })), /ECONNRESET/);
  assert.deepEqual(names(), ['carousel']);
});

test('429 is a rate limit, not a rejection: retried, not turned into the fallback', async () => {
  sendImpl = () => { throw metaError(429); };
  await assert.rejects(() => processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS })), /429/);
  assert.deepEqual(names(), ['carousel']);
});

test('carouselNative false (no photos): straight to the fallback - body, then one message per card', async () => {
  await processor(job({ type: 'carousel', carouselNative: false, carouselCards: CARDS }));
  assert.deepEqual(names(), ['text', 'buttons', 'buttons']);
});

test('a fallback card with no buttons: its image with the text as caption, or just the text', async () => {
  const cards = [
    { index: 0, mediaType: 'image', mediaUrl: 'https://r2.test/a.jpeg', text: 'Deluxe', buttons: [] },
    { index: 1, mediaType: null, mediaUrl: null, text: 'Suite', buttons: [] },
    { index: 2, mediaType: null, mediaUrl: null, text: '', buttons: [] }
  ];
  await processor(job({ type: 'carousel', carouselNative: false, carouselCards: cards }));
  assert.deepEqual(names(), ['text', 'image', 'text'], 'an empty card sends nothing');
});

test('once the fallback has started, a card message failing with 5xx / network is skipped (no throw, no whole-sequence retry)', async () => {
  const cards = [
    { index: 0, mediaType: null, mediaUrl: null, text: 'A', buttons: [{ nextKeyword: 'e1', title: 'Book' }] },
    { index: 1, mediaType: null, mediaUrl: null, text: 'B', buttons: [{ nextKeyword: 'e2', title: 'Book' }] },
    { index: 2, mediaType: null, mediaUrl: null, text: 'C', buttons: [{ nextKeyword: 'e3', title: 'Book' }] }
  ];
  let buttonCalls = 0;
  sendImpl = (name) => {
    if (name === 'buttons' && ++buttonCalls === 2) throw metaError(503);
    return response(`wamid.G${buttonCalls}`);
  };
  await processor(job({ type: 'carousel', carouselNative: false, carouselCards: cards }));
  assert.deepEqual(names(), ['text', 'buttons', 'buttons', 'buttons'], 'card 3 still goes out after card 2 failed');
  assert.equal(rows[0].status, 'sent');

  sends = []; buttonCalls = 0;
  sendImpl = (name) => { if (name === 'buttons') throw new Error('ECONNRESET'); return response('wamid.G9'); };
  await processor(job({ type: 'carousel', carouselNative: false, carouselCards: cards }));
  assert.deepEqual(names(), ['text', 'buttons', 'buttons', 'buttons']);
});

test('after a native 4xx, the fallback keeps going past a failing card too; only the FIRST send keeps queue retry', async () => {
  sendImpl = (name) => {
    if (name === 'carousel') throw metaError(400);
    if (name === 'buttons') throw metaError(500);
    return response('wamid.H1');
  };
  await processor(job({ type: 'carousel', carouselNative: true, carouselCards: CARDS }));
  assert.deepEqual(names(), ['carousel', 'text', 'buttons', 'buttons']);

  // the fallback body failing still throws: nothing of it went out, so a retry duplicates nothing
  sends = [];
  sendImpl = (name) => { if (name === 'text') throw metaError(503); return response('wamid.H2'); };
  await assert.rejects(() => processor(job({ type: 'carousel', carouselNative: false, carouselCards: CARDS })), /503/);
  assert.deepEqual(names(), ['text']);
});
