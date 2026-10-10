// Run: node --test src/utils/interactivePayload.test.js
// buildInteractivePayload (what is stored in messages.interactive_payload) against
// the REAL outbound worker and the REAL senders: for each job, the payload must say
// the same thing as the interactive message Meta was handed. Only axios, BullMQ,
// the database and the token decryption are stand-ins - no Redis, no WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');

let processor; let posted;
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('bullmq', { Worker: class { constructor(name, fn) { processor = fn; } on() {} } });
stub('../config/queueConnection', { workerConnection: {} });
stub('../config/env', { QUEUE_NAMESPACE: 'test', GRAPH_API_VERSION: 'v99.0' });
stub('../config/supabase', { from: () => { throw new Error('the database is not used here'); } });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { decrypt: () => 'token' });

const axios = require('axios');
require('../queues/whatsapp.worker');
const { buildInteractivePayload } = require('./interactivePayload');

test.beforeEach(() => {
  posted = [];
  axios.post = async (url, body) => { posted.push(body); return { data: { messages: [{ id: 'wamid' }] } }; };
});

const BASE = { businessId: 'b1', phoneNumberId: 'pn1', encryptedAccessToken: 'enc', to: '919800000001' };

// The interactive message Meta was given, read back as a payload; null when it was not interactive.
const fromMeta = (body) => {
  const i = body.interactive;
  if (body.type !== 'interactive') return null;
  switch (i.type) {
    case 'button':
      return { kind: 'buttons', body: i.body.text, options: i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title })),
        ...(i.header ? { imageUrl: i.header.image.link } : {}) };
    case 'list':
      return { kind: 'list', body: i.body.text, buttonText: i.action.button, options: i.action.sections[0].rows };
    case 'cta_url':
      return { kind: 'cta_url', body: i.body.text, label: i.action.parameters.display_text };
    case 'location_request_message':
      return { kind: 'location_request', body: i.body.text };
    default:
      throw new Error(`unexpected interactive type ${i.type}`);
  }
};

const run = async (job) => {
  await processor({ data: { ...BASE, ...job }, attemptsMade: 0 });
  assert.equal(posted.length, 1);
  return fromMeta(posted[0]);
};

const LONG = 'x'.repeat(2000);
const EMOJI_EDGE = `${'a'.repeat(19)}👨‍👩‍👧‍👦tail`; // a family emoji straddles the 20-unit cut
const DEVANAGARI = 'अ'.repeat(30);

const JOBS = {
  'edge buttons with a header image': { message: 'Pick', imageUrl: 'https://img/x.png', buttons: [{ title: 'Prices', nextKeyword: 'e1' }, { title: 'Book', nextKeyword: 'e2' }] },
  'edge buttons, 4 given: only 3 are sent': { message: 'Pick', buttons: [1, 2, 3, 4].map((n) => ({ title: `B${n}`, nextKeyword: `e${n}` })) },
  'edge buttons, long and emoji titles': { message: LONG, buttons: [{ title: 'y'.repeat(50), nextKeyword: 'e1' }, { title: EMOJI_EDGE, nextKeyword: 'e2' }, { title: DEVANAGARI, nextKeyword: 'e3' }] },
  'booking buttons "{step}:{index}"': { message: 'Seats?', step: 'node9', interactiveButtons: ['One', 'Two', 'Three', 'Four'], imageUrl: 'https://img/y.png' },
  'booking list "{step}:{index}"': { message: 'Which car?', step: 'node7', interactiveList: ['Swift', 'z'.repeat(40), EMOJI_EDGE], listButtonLabel: 'Choose' },
  'booking list, a header image is not sent on lists': { message: 'Which car?', step: 'node7', interactiveList: ['Swift'], imageUrl: 'https://img/z.png' },
  'edge list with descriptions': { message: 'Courses', listButtonLabel: 'See courses', listOptions: [
    { nextKeyword: 'e1', label: 'Abacus', description: 'Ages 5-14' }, { nextKeyword: 'e2', label: 'Vedic', description: null }, { nextKeyword: 'e3', label: 'l'.repeat(40), description: 'd'.repeat(100) }] },
  'edge list, over-long button label': { message: 'Courses', listButtonLabel: 'b'.repeat(30), listOptions: [{ nextKeyword: 'e1', label: 'A' }] },
  'edge list, empty button label -> Choose': { message: 'Courses', listButtonLabel: '', listOptions: [{ nextKeyword: 'e1', label: 'A' }] },
  'edge list, no button label -> Choose': { message: 'Courses', listOptions: [{ nextKeyword: 'e1', label: 'A' }] },
  'edge list, Marathi': { message: 'कोर्स', listButtonLabel: 'कोर्स देखें', listOptions: [{ nextKeyword: 'e1', label: 'अबॅकस', description: 'वय ५-१४' }] },
  'cta button': { message: 'Book here', ctaButton: { buttonText: 'Open the booking form please', url: 'https://app.test/book/tok' } },
  'location request': { message: 'Share your pickup location', locationRequest: true },
  'link wins over buttons': { message: 'x', ctaButton: { buttonText: 'Go', url: 'https://u' }, buttons: [{ title: 'A', nextKeyword: 'e1' }] },
  'booking list wins over buttons and rows': { message: 'x', step: 's', interactiveList: ['A'], buttons: [{ title: 'B', nextKeyword: 'e1' }], listOptions: [{ nextKeyword: 'e2', label: 'C' }] },
  'booking buttons win over edge buttons': { message: 'x', step: 's', interactiveButtons: ['A'], buttons: [{ title: 'B', nextKeyword: 'e1' }] },
  'edge buttons win over edge rows': { message: 'x', buttons: [{ title: 'B', nextKeyword: 'e1' }], listOptions: [{ nextKeyword: 'e2', label: 'C' }] }
};

for (const [name, job] of Object.entries(JOBS)) {
  test(`stored payload = what Meta was given: ${name}`, async () => {
    const sent = await run(job);
    assert.notEqual(sent, null);
    assert.deepEqual(buildInteractivePayload(job), sent);
  });
}

test('nothing interactive: plain text, an image, a pin, empty option lists -> null, and Meta got none either', async () => {
  const plain = [
    { message: 'hello' },
    { message: 'hello', imageUrl: 'https://img/x.png' },
    { message: 'hello', buttons: [], listOptions: [], interactiveButtons: null, interactiveList: null },
    { location: { latitude: 1, longitude: 2, name: 'Shop' } }
  ];
  for (const job of plain) {
    posted = [];
    assert.equal(await run(job), null);
    assert.equal(buildInteractivePayload(job), null);
  }
  assert.equal(buildInteractivePayload(undefined), null);
});

test('options keep the whole-grapheme cut: a family emoji at the edge is dropped, not split', () => {
  const [button] = buildInteractivePayload({ message: 'x', buttons: [{ title: EMOJI_EDGE, nextKeyword: 'e1' }] }).options;
  assert.equal(button.title, 'a'.repeat(19));
});

test('a row without a description has no description key; keys with no value are absent', () => {
  const payload = buildInteractivePayload({ message: 'x', listOptions: [{ nextKeyword: 'e1', label: 'A', description: '' }] });
  assert.equal('description' in payload.options[0], false);
  const buttons = buildInteractivePayload({ message: 'x', buttons: [{ title: 'A', nextKeyword: 'e1' }] });
  assert.equal('imageUrl' in buttons, false);
  assert.equal('buttonText' in buttons, false);
});

test('the payload survives a JSON round trip unchanged (what jsonb stores)', () => {
  for (const job of Object.values(JOBS)) {
    const payload = buildInteractivePayload(job);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  }
});

test('a link button keeps its label but never the link or its token', () => {
  const payload = buildInteractivePayload(JOBS['cta button']);
  assert.deepEqual(payload, { kind: 'cta_url', body: 'Book here', label: 'Open the booking for' });
  assert.equal('url' in payload, false);
  assert.equal(JSON.stringify(payload).includes('app.test'), false);
});
