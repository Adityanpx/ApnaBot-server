// Run: node --test src/config/whatsappConnectPage.test.js
// public/whatsapp-connect.html's script, run in a vm sandbox with a stubbed
// DOM, Facebook SDK, bridge and clock - nothing touches a browser or Meta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'whatsapp-connect.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

const IDS = ['connectBtn', 'retryBtn', 'status', 'info', 'choiceYes', 'choiceNo', 'choicePersonal'];

// Loads the page; resolves once the config fetch + fake SDK load have run.
const loadPage = async () => {
  const els = {};
  IDS.forEach((id) => {
    const handlers = {};
    els[id] = {
      id, textContent: '', disabled: false, hidden: id === 'connectBtn' || id === 'retryBtn' || id === 'info',
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(ev, fn) { handlers[ev] = fn; },
      click() { handlers.click(); }
    };
  });
  const bridge = [];
  const timers = [];
  const fb = { loginCalls: [] };
  const win = {
    ApnaBotBridge: { postMessage: (m) => bridge.push(JSON.parse(m)) },
    FB: {
      init: (opts) => { fb.initOpts = opts; },
      login: (cb, opts) => { fb.loginCalls.push({ cb, opts }); }
    },
    listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; }
  };
  const warnings = [];
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => els[id] || null,
      getElementsByTagName: () => [{ parentNode: { insertBefore: () => { win.fbAsyncInit(); } } }],
      createElement: () => ({})
    },
    fetch: async () => ({ json: async () => ({ success: true, data: { appId: 'app1', configId: 'cfg1' } }) }),
    URL,
    console: { log: () => {}, warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; }
  };
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);
  await new Promise((r) => setImmediate(r)); // fetch().then chain

  const page = {
    els, bridge, timers, fb, warnings,
    click: (id) => els[id].click(),
    // a message event from `origin`
    post: (origin, payload) => win.listeners.message({ origin, data: payload }),
    fbMsg: (event, data) => page.post('https://www.facebook.com', JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data })),
    loginResult: (response) => fb.loginCalls[fb.loginCalls.length - 1].cb(response),
    // fire pending timers (optionally only those with ms >= min)
    runTimers: (min = 0) => timers.filter((t) => !t.cleared && t.ms >= min).forEach((t) => { t.cleared = true; t.fn(); }),
    results: () => bridge.filter((m) => !m.debug),
    status: () => els.status.textContent
  };
  return page;
};

const connectFlow = async (choice = 'choiceYes') => {
  const page = await loadPage();
  page.click(choice);
  page.click('connectBtn');
  return page;
};

test('guidance first: nothing connects until a valid choice is made; SDK is initialised on v25.0', async () => {
  const page = await loadPage();
  assert.equal(page.fb.initOpts.version, 'v25.0');
  assert.equal(page.els.connectBtn.hidden, true);
  assert.equal(page.fb.loginCalls.length, 0);
  page.click('choiceYes');
  assert.equal(page.els.connectBtn.hidden, false);
  assert.equal(page.els.connectBtn.disabled, false);
  assert.match(page.els.info.textContent, /2\.24\.17/);
  assert.match(page.els.info.textContent, /phone nearby/);
});

test('personal WhatsApp: instructions, no Connect button, no FB.login', async () => {
  const page = await loadPage();
  page.click('choicePersonal');
  assert.equal(page.els.connectBtn.hidden, true);
  assert.match(page.els.info.textContent, /WhatsApp Business app/);
  assert.match(page.els.info.textContent, /delete the WhatsApp account/);
  page.click('connectBtn'); // hidden, but even a stray click must not launch
  assert.equal(page.fb.loginCalls.length, 0);
});

test('FB.login: featureType always on, whichever card was chosen', async () => {
  for (const card of ['choiceYes', 'choiceNo']) {
    const page = await connectFlow(card);
    const { opts } = page.fb.loginCalls[0];
    assert.equal(opts.config_id, 'cfg1');
    assert.equal(opts.response_type, 'code');
    assert.equal(opts.override_default_response_type, true);
    assert.deepEqual(JSON.parse(JSON.stringify(opts.extras)), { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' });
  }
});

test('IDs event then code: one payload, with the coexistence type', async () => {
  const page = await connectFlow('choiceYes');
  page.fbMsg('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', { waba_id: 'W1', phone_number_id: 'P1' });
  assert.deepEqual(page.results(), []); // still waiting for the code
  page.loginResult({ authResponse: { code: 'CODE1' } });
  assert.deepEqual(page.results(), [{ code: 'CODE1', wabaId: 'W1', phoneNumberId: 'P1', onboardingType: 'coexistence' }]);
});

test('code then IDs event: one payload, cloud_api type for a plain FINISH', async () => {
  const page = await connectFlow('choiceNo');
  page.loginResult({ authResponse: { code: 'CODE2' } });
  assert.deepEqual(page.results(), []); // still waiting for the IDs
  page.fbMsg('FINISH', { waba_id: 'W2', phone_number_id: 'P2' });
  assert.deepEqual(page.results(), [{ code: 'CODE2', wabaId: 'W2', phoneNumberId: 'P2', onboardingType: 'cloud_api' }]);
  page.fbMsg('FINISH', { waba_id: 'W2', phone_number_id: 'P2' }); // a repeat never sends twice
  assert.equal(page.results().length, 1);
});

test('type follows Meta\'s event, not the card: chose Yes, got plain FINISH -> cloud_api + a warning', async () => {
  const page = await connectFlow('choiceYes');
  page.fbMsg('FINISH', { waba_id: 'W', phone_number_id: 'P' });
  page.loginResult({ authResponse: { code: 'C' } });
  assert.equal(page.results()[0].onboardingType, 'cloud_api');
  assert.equal(page.warnings.length, 1);
  assert.match(page.warnings[0], /chose coexistence but Meta reported cloud_api/);
});

test('both IDs are required: FINISH without a phone_number_id waits, then times out (30s) with Retry', async () => {
  const page = await connectFlow();
  page.loginResult({ authResponse: { code: 'C' } });
  page.fbMsg('FINISH', { waba_id: 'W' });
  assert.deepEqual(page.results(), []);
  const timeout = page.timers.find((t) => !t.cleared);
  assert.equal(timeout.ms, 30000);
  page.runTimers(30000);
  assert.match(page.results()[0].error, /didn't finish sending/);
  assert.equal(page.els.retryBtn.hidden, false);
});

test('FINISH_ONLY_WABA: clear message + Retry, nothing sent for connect', async () => {
  const page = await connectFlow();
  page.fbMsg('FINISH_ONLY_WABA', { waba_id: 'W' });
  page.loginResult({ authResponse: { code: 'C' } });
  assert.equal(page.results().length, 1);
  assert.match(page.results()[0].error, /no phone number was added/);
  assert.equal(page.els.retryBtn.hidden, false);
});

test('CANCEL shows the step; the generic "not completed" message does not overwrite it', async () => {
  const page = await connectFlow();
  page.loginResult({ authResponse: undefined }); // Meta calls back with no code on cancel
  page.fbMsg('CANCEL', { current_step: 'PHONE_NUMBER_SETUP' });
  page.runTimers(); // the delayed generic failure fires after
  assert.equal(page.results().length, 1);
  assert.match(page.results()[0].error, /cancelled at step: PHONE_NUMBER_SETUP/);
  assert.equal(page.els.retryBtn.hidden, false);
});

test('user-reported error arrives as CANCEL with error_message: shown', async () => {
  const page = await connectFlow();
  page.fbMsg('CANCEL', { error_message: 'Number already registered', error_code: 100 });
  assert.match(page.results()[0].error, /Number already registered/);
});

test('ERROR shows error_message + Retry; Retry resets and allows a fresh attempt', async () => {
  const page = await connectFlow();
  page.fbMsg('ERROR', { error_message: 'Something broke' });
  assert.match(page.results()[0].error, /Something broke/);
  assert.equal(page.els.retryBtn.hidden, false);
  page.click('retryBtn');
  assert.equal(page.els.retryBtn.hidden, true);
  assert.equal(page.els.connectBtn.disabled, false);
  page.click('connectBtn');
  assert.equal(page.fb.loginCalls.length, 2);
  page.fbMsg('FINISH', { waba_id: 'W', phone_number_id: 'P' });
  page.loginResult({ authResponse: { code: 'C' } });
  assert.equal(page.results().filter((m) => m.code).length, 1);
});

test('origin check: facebook.com and *.facebook.com only', async () => {
  const page = await connectFlow();
  const finish = JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'W', phone_number_id: 'P' } });
  for (const bad of ['https://evilfacebook.com', 'https://facebook.com.evil.test', 'https://example.com', 'null', '']) {
    page.post(bad, finish);
  }
  page.loginResult({ authResponse: { code: 'C' } });
  assert.deepEqual(page.results(), []); // spoofed finishes ignored
  page.post('https://business.facebook.com', finish);
  assert.equal(page.results().length, 1);
  assert.equal(page.results()[0].wabaId, 'W');
});

test('events outside an active attempt are ignored', async () => {
  const page = await loadPage();
  page.fbMsg('ERROR', { error_message: 'stale' });
  assert.deepEqual(page.results(), []);
});

test('debug payloads never carry the auth code', async () => {
  const page = await connectFlow();
  page.loginResult({ authResponse: { code: 'SECRET-CODE', userID: 'u' }, status: 'connected' });
  page.post('https://www.facebook.com', JSON.stringify({ type: 'other', code: 'SECRET-CODE-2' }));
  const everything = JSON.stringify(page.bridge.filter((m) => m.debug));
  assert.ok(!everything.includes('SECRET-CODE'));
  assert.match(everything, /\[redacted\]/);
  assert.match(everything, /"userID":"u"/); // the rest of the debug payload is intact
});
