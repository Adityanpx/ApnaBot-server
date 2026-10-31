// Run: node --test src/services/whatsappDiagnostics.service.test.js
// Connect diagnostics: the client-log sanitiser (secret stripping, entry cap), the
// log endpoint, and a mocked Graph failure captured by the connect trace. Supabase,
// axios and the logger are stubbed - nothing touches a database or Meta.
const test = require('node:test');
const assert = require('node:assert/strict');

let rows; let logged; let graph;

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

stub('axios', { get: async (url, opts) => graph('get', url, opts), post: async (url, body, opts) => graph('post', url, opts, body) });
stub('../config/env', { META_APP_ID: 'app1', META_APP_SECRET: 'APPSECRET', META_CONFIG_ID: 'cfg1' });
stub('../utils/logger', {
  info: (m, d) => logged.push(['info', m, d]),
  warn: (m, d) => logged.push(['warn', m, d]),
  error: (m, d) => logged.push(['error', m, d])
});
stub('./whatsapp.service', { META_API_BASE: 'https://graph.test/v25.0' });

// Just enough of the query builder for whatsapp_connect_attempts.
let seq = 0;
stub('../config/supabase', {
  from: () => {
    const f = []; let patch = null; let del = false; let ins = null; let ord = null; let lim = null; let rng = null;
    const match = () => rows.filter((r) => f.every((fn) => fn(r)));
    const q = {
      select: () => q,
      eq: (c, v) => { f.push((r) => r[c] === v); return q; },
      gte: (c, v) => { f.push((r) => r[c] >= v); return q; },
      in: (c, v) => { f.push((r) => v.includes(r[c])); return q; },
      order: (c, o) => { ord = [c, o.ascending]; return q; },
      limit: (n) => { lim = n; return q; },
      range: (a, b) => { rng = [a, b]; return q; },
      insert: (r) => { ins = r; return q; },
      update: (p) => { patch = p; return q; },
      delete: () => { del = true; return q; },
      single: async () => {
        const row = { id: `a${++seq}`, entries: [], server_steps: [], created_at: new Date(Date.now() + seq).toISOString(), ...ins };
        rows.push(row);
        return { data: row, error: null };
      },
      then: (resolve, reject) => {
        let data = null;
        if (patch) match().forEach((r) => Object.assign(r, patch));
        else if (del) rows = rows.filter((r) => !match().includes(r));
        else {
          data = match();
          if (ord) data.sort((a, b) => (a[ord[0]] < b[ord[0]] ? 1 : -1) * (ord[1] ? -1 : 1));
          if (rng) data = data.slice(rng[0], rng[1] + 1);
          if (lim) data = data.slice(0, lim);
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    };
    return q;
  }
});

const diag = require('./whatsappDiagnostics.service');

test.beforeEach(() => { rows = []; logged = []; graph = async () => { throw new Error('unexpected Graph call'); }; });

const bigEntry = () => ({ type: 'blob', text: 'x'.repeat(6000) });

test('sanitiser strips code / token / access_token / secret keys at any depth, in any casing', () => {
  const out = diag.sanitizeClientLog({
    outcome: 'FINISH',
    entries: [{
      event: 'FINISH',
      code: 'AUTHCODE',
      data: { token: 'T', accessToken: 'AT', nested: [{ access_token: 'AT2', client_secret: 'CS', phone_number_id: '222' }], secret: 'S' }
    }]
  });
  assert.ok(!out.error);
  const json = JSON.stringify(out.entries);
  for (const leaked of ['AUTHCODE', '"T"', 'AT2', '"AT"', 'CS', '"S"']) assert.ok(!json.includes(leaked), `${leaked} leaked`);
  assert.deepEqual(out.entries[0].data.nested, [{ phone_number_id: '222' }]);
  assert.equal(out.entries[0].event, 'FINISH');
});

test('sanitiser redacts a code / token carried in a URL string value', () => {
  const out = diag.sanitizeClientLog({ entries: [{ url: 'https://x.test/cb?code=AUTHCODE&state=ok&access_token=TT' }] });
  assert.ok(!JSON.stringify(out.entries).includes('AUTHCODE'));
  assert.ok(!JSON.stringify(out.entries).includes('TT'));
  assert.match(out.entries[0].url, /state=ok/);
});

test('entry cap: 150 entries -> 100 kept; an entry over 4 KB becomes a truncated marker', () => {
  const entries = Array.from({ length: 150 }, (_, i) => ({ i }));
  entries[3] = bigEntry();
  const out = diag.sanitizeClientLog({ entries });
  assert.equal(out.entries.length, 100);
  assert.equal(out.entries[0].i, 0);
  assert.equal(out.entries[3].truncated, true);
  assert.ok(out.entries[3].originalBytes > diag.MAX_ENTRY_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(out.entries[3])) < diag.MAX_ENTRY_BYTES);
});

test('sanitiser rejects a body without an entries array', () => {
  assert.ok(diag.sanitizeClientLog({}).error);
  assert.ok(diag.sanitizeClientLog({ entries: 'nope' }).error);
  assert.ok(diag.sanitizeClientLog({ entries: [], outcome: 5 }).error);
});

test('client log with no server attempt inserts a row; with a fresh server attempt it attaches to it', async () => {
  const id1 = await diag.recordClientLog({ businessId: 'b1', userId: 'u1', entries: [{ a: 1 }], outcome: 'popup_closed' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'popup_closed');

  const trace = diag.createConnectTrace({ businessId: 'b2', userId: 'u1' });
  await trace.begin();
  const id2 = await diag.recordClientLog({ businessId: 'b2', userId: 'u1', entries: [{ b: 1 }] });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === id2).entries.length, 1);
  assert.equal(rows.find((r) => r.id === id2).outcome, 'started');
  assert.notEqual(id1, id2);
});

test('only the last 50 attempts per business are kept', async () => {
  for (let i = 0; i < 55; i++) await diag.recordClientLog({ businessId: 'b1', userId: null, entries: [{ i }], outcome: `o${i}` });
  assert.equal(rows.filter((r) => r.business_id === 'b1').length, diag.ATTEMPTS_KEPT);
});

test('mocked Graph failure: method, path, status, code, subcode and fbtrace_id are captured; no secret is', async () => {
  graph = async () => {
    const e = new Error('Request failed with status code 400');
    e.config = { url: 'https://graph.test/v25.0/oauth/access_token', params: { client_secret: 'APPSECRET', code: 'AUTHCODE' } };
    e.response = { status: 400, data: { error: { message: 'Invalid verification code format.', code: 100, error_subcode: 36007, fbtrace_id: 'AbC123' } } };
    throw e;
  };
  const axios = require('axios');
  const trace = diag.createConnectTrace({ businessId: 'b1', userId: 'u1' });
  const begun = trace.begin();
  try { await axios.get('https://graph.test/v25.0/oauth/access_token', { params: {} }); } catch (error) {
    trace.fail('token_exchange', 'GET', '/oauth/access_token', error);
  }
  await begun;
  await trace.finish('token_exchange_failed');

  const step = trace.steps.find((s) => s.step === 'token_exchange');
  assert.equal(step.ok, false);
  assert.equal(step.method, 'GET');
  assert.equal(step.path, '/oauth/access_token');
  assert.equal(step.httpStatus, 400);
  assert.equal(step.code, 100);
  assert.equal(step.errorSubcode, 36007);
  assert.equal(step.fbtraceId, 'AbC123');

  // Persisted on the attempt row, and logged as a structured line.
  assert.equal(rows[0].outcome, 'token_exchange_failed');
  assert.equal(rows[0].server_steps.find((s) => s.step === 'token_exchange').fbtraceId, 'AbC123');
  const line = logged.find(([lvl, m, d]) => lvl === 'error' && m === 'whatsapp_connect_step' && d.step === 'token_exchange');
  assert.ok(line, 'a structured log line was written');
  assert.equal(line[2].fbtraceId, 'AbC123');

  const everything = JSON.stringify([rows, logged]);
  for (const secret of ['APPSECRET', 'AUTHCODE']) assert.ok(!everything.includes(secret), `${secret} leaked`);
});

test('debug_token result keeps app, type, validity, expiry, scopes and granular target IDs - no token', async () => {
  graph = async (method, url, opts) => {
    assert.match(opts.headers.Authorization, /^Bearer app1\|APPSECRET$/);
    return { data: { data: { app_id: 'app1', type: 'USER', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['111'] }] } } };
  };
  const trace = diag.createConnectTrace({ businessId: 'b1', userId: 'u1' });
  await diag.traceDebugToken(trace, 'USERTOKEN');
  const step = trace.steps.find((s) => s.step === 'debug_token');
  assert.equal(step.appId, 'app1');
  assert.equal(step.isValid, true);
  assert.deepEqual(step.granularScopes, [{ scope: 'whatsapp_business_management', targetIds: ['111'] }]);
  assert.ok(!JSON.stringify([trace.steps, logged]).includes('USERTOKEN'));
});
