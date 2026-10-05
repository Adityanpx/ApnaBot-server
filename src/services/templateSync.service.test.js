// Run: node --test src/services/templateSync.service.test.js
// Template sync from WhatsApp: planSync (matching, adopt, soft delete, skips,
// send_support), the Meta listing (paging, invalid-cursor retry), the writes
// against an in-memory message_templates, and the per-business cooldown.
// Supabase, the business lookup and Meta are all stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ── In-memory message_templates ──
let rows; let writes; let insertError;
const from = (table) => {
  assert.equal(table, 'message_templates');
  const filters = []; let op = 'select'; let payload;
  const matching = () => rows.filter(r => filters.every(f => f(r)));
  const q = {
    select: () => q,
    eq: (c, v) => { filters.push(r => r[c] === v); return q; },
    in: (c, vs) => { filters.push(r => vs.includes(r[c])); return q; },
    insert: (p) => { op = 'insert'; payload = p; return q; },
    update: (p) => { op = 'update'; payload = p; return q; },
    then: (resolve, reject) => {
      let result;
      if (op === 'insert') {
        if (insertError) result = { data: null, error: insertError };
        else { rows.push({ id: `new${rows.length + 1}`, ...payload }); writes.push(['insert', payload]); result = { data: null, error: null }; }
      } else if (op === 'update') {
        for (const r of matching()) { Object.assign(r, payload); writes.push(['update', r.id, payload]); }
        result = { data: null, error: null };
      } else {
        result = { data: matching().map(r => ({ ...r })), error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    }
  };
  return q;
};
stub('../config/supabase', { from });
stub('../utils/logger', { info: () => {}, warn: () => {}, error: () => {} });
stub('../utils/crypto', { decrypt: (v) => `dec:${v}` });
stub('../services/whatsapp.service', { META_API_BASE: 'https://graph.example/v25.0' });
let businessLookups = 0;
stub('../services/business.service', {
  getBusinessById: async (id) => { businessLookups += 1; return { id, wabaId: 'waba1', accessToken: 'enc' }; }
});

const svc = require('./templateSync.service');
const NOW = new Date('2026-10-05T10:00:00Z');

// ── Fixtures ──
const metaTpl = (over = {}) => ({
  id: 'm1', name: 'promo', language: 'en_US', status: 'APPROVED', category: 'MARKETING', rejected_reason: 'NONE',
  quality_score: { score: 'GREEN', date: 1 }, parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Rohan']] } }],
  ...over
});
const row = (over = {}) => ({
  id: 'r1', business_id: 'b', name: 'promo', language: 'en_US', category: 'MARKETING', body_text: 'Hi {{1}}',
  variable_count: 1, variable_samples: ['Rohan'], meta_template_id: 'm1', status: 'approved', rejection_reason: null,
  header_type: 'NONE', header_image_url: null, header_image_r2_key: null,
  source: 'app', meta_status: 'APPROVED', quality_score: 'GREEN', meta_components: [{ type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Rohan']] } }],
  send_support: 'ok', last_synced_at: null, meta_deleted_at: null,
  ...over
});
const plan = (existing, listed, complete = true) => svc.planSync(existing, listed, { complete, now: NOW });

test.beforeEach(() => { rows = []; writes = []; insertError = null; businessLookups = 0; svc.resetCooldownForTests(); });

// ── send_support from components ──
test('send_support: computed from components', () => {
  const body = { type: 'BODY', text: 'Hi {{1}}' };
  const cases = [
    [[body], {}, 'ok'],
    [[body, { type: 'FOOTER', text: 'bye' }], {}, 'ok'],
    [[{ type: 'HEADER', format: 'TEXT', text: 'Sale' }, body], {}, 'ok'],
    [[{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, body], {}, 'ok'], // one header variable is sendable (mapping target 'header')
    [[{ type: 'HEADER', format: 'TEXT', text: '{{1}} {{2}}' }, body], {}, 'unsupported_component'],
    [[{ type: 'HEADER', format: 'IMAGE' }, body], {}, 'needs_header_media'],
    [[{ type: 'HEADER', format: 'IMAGE' }, body], { headerImageUrl: 'https://r2/x.jpg' }, 'ok'],
    [[{ type: 'HEADER', format: 'VIDEO' }, body], { headerImageUrl: 'https://r2/x.jpg' }, 'needs_header_media'],
    [[{ type: 'HEADER', format: 'VIDEO' }, body], { headerMediaUrl: 'https://r2/x.mp4' }, 'ok'],
    [[{ type: 'HEADER', format: 'VIDEO' }, body], { headerMediaUrl: 'https://r2/x.jpeg' }, 'needs_header_media'], // wrong type attached
    [[{ type: 'HEADER', format: 'DOCUMENT' }, body], {}, 'needs_header_media'],
    [[{ type: 'HEADER', format: 'DOCUMENT' }, body], { headerMediaUrl: 'https://r2/x.pdf' }, 'ok'],
    [[{ type: 'HEADER', format: 'IMAGE' }, body], { headerMediaUrl: 'https://r2/x.jpeg' }, 'ok'],
    [[{ type: 'HEADER', format: 'IMAGE' }, body], { headerMediaUrl: 'https://r2/x.webp' }, 'needs_header_media'],
    [[{ type: 'HEADER', format: 'LOCATION' }, body], {}, 'unsupported_component'],
    [[body, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] }], {}, 'unsupported_component'],
    [[body, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com/a' }] }], {}, 'ok'], // static URL
    [[body, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com/{{1}}' }] }], {}, 'ok'], // dynamic URL
    [[body, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com/{{1}}/{{2}}' }] }], {}, 'unsupported_component'],
    [[body, { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', text: 'Call', phone_number: '+911234567890' }] }], {}, 'ok'],
    [[body, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://x.com' }, { type: 'QUICK_REPLY', text: 'Yes' }] }], {}, 'unsupported_component'],
    ...['COPY_CODE', 'FLOW', 'CATALOG', 'OTP', 'MPM', 'SPM'].map(type => [[body, { type: 'BUTTONS', buttons: [{ type, text: 'x' }] }], {}, 'unsupported_component']),
    [[{ type: 'HEADER', format: 'IMAGE' }, body, { type: 'BUTTONS', buttons: [] }], {}, 'needs_header_media'],
    [[{ type: 'CAROUSEL', cards: [] }], {}, 'unsupported_component']
  ];
  for (const [components, own, expected] of cases) {
    assert.equal(svc.computeSendSupport({ components }, own), expected, JSON.stringify(components));
  }
});

test('send_support: named parameters are flagged, from parameter_format or the body text', () => {
  const named = { type: 'BODY', text: 'Hi {{first_name}}' };
  assert.equal(svc.computeSendSupport({ parameter_format: 'NAMED', components: [named] }), 'unsupported_named_params');
  assert.equal(svc.computeSendSupport({ components: [named] }), 'unsupported_named_params');
  assert.equal(svc.computeSendSupport({ parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }), 'ok');
  // named wins over buttons / media
  assert.equal(svc.computeSendSupport({ parameter_format: 'NAMED', components: [{ type: 'HEADER', format: 'VIDEO' }, named, { type: 'BUTTONS' }] }), 'unsupported_named_params');
});

// ── planSync ──
test('new Meta template: created as source=meta_sync with Meta\'s fields', () => {
  const p = plan([], [metaTpl({ id: 'm9', name: 'ganpati_offer_2026' })]);
  assert.equal(p.creates.length, 1);
  const c = p.creates[0].row;
  assert.equal(c.source, 'meta_sync');
  assert.equal(c.meta_template_id, 'm9');
  assert.equal(c.name, 'ganpati_offer_2026');
  assert.equal(c.status, 'approved');
  assert.equal(c.meta_status, 'APPROVED');
  assert.equal(c.quality_score, 'GREEN');
  assert.equal(c.body_text, 'Hi {{1}}');
  assert.equal(c.variable_count, 1);
  assert.deepEqual(c.variable_samples, ['Rohan']);
  assert.equal(c.header_type, 'NONE');
  assert.equal(c.send_support, 'ok');
  assert.equal(c.header_image_url, undefined); // never set from Meta
});

test('matched by meta_template_id: Meta wins on status, category, reason, quality, components', () => {
  const existing = row({ status: 'pending', category: 'UTILITY', quality_score: null, meta_status: 'PENDING', body_text: 'old body' });
  const p = plan([existing], [metaTpl({
    status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', category: 'MARKETING', quality_score: { score: 'RED' },
    components: [{ type: 'BODY', text: 'new body' }]
  })]);
  assert.equal(p.updates.length, 1);
  const f = p.updates[0].fields;
  assert.equal(f.status, 'rejected');
  assert.equal(f.meta_status, 'REJECTED');
  assert.equal(f.rejection_reason, 'INVALID_FORMAT');
  assert.equal(f.category, 'MARKETING');
  assert.equal(f.quality_score, 'RED');
  assert.equal(f.body_text, 'new body');
  assert.equal(f.variable_count, 0);
  for (const k of ['status', 'category', 'rejection_reason', 'quality_score', 'meta_components', 'body_text']) {
    assert.ok(p.updates[0].changes.includes(k), k);
  }
});

test('a match never overwrites header_image_url / header_image_r2_key and keeps an IMAGE header sendable', () => {
  const existing = row({ header_type: 'IMAGE', header_image_url: 'https://r2/own.jpg', header_image_r2_key: 'k' });
  const p = plan([existing], [metaTpl({
    components: [{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.whatsapp.net/example.jpg'] } }, { type: 'BODY', text: 'Hi {{1}}' }]
  })]);
  const f = (p.updates[0] || p.unchanged[0]).fields;
  assert.equal('header_image_url' in f, false);
  assert.equal('header_image_r2_key' in f, false);
  assert.equal(f.header_type, 'IMAGE');
  assert.equal(f.send_support, 'ok'); // own image URL on file
});

test('IMAGE header with no stored image → needs_header_media', () => {
  const p = plan([], [metaTpl({ components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }] })]);
  assert.equal(p.creates[0].row.header_type, 'IMAGE');
  assert.equal(p.creates[0].row.send_support, 'needs_header_media');
  assert.deepEqual(p.unsupported, [{ name: 'promo', language: 'en_US', sendSupport: 'needs_header_media' }]);
});

test('adopt: no meta id match → (name, language) among rows without a meta_template_id', () => {
  const draft = row({ id: 'd1', meta_template_id: null, status: 'draft', meta_status: null, quality_score: null, source: 'app' });
  const p = plan([draft], [metaTpl({ id: 'm5', status: 'PENDING' })]);
  assert.equal(p.adopts.length, 1);
  assert.equal(p.creates.length, 0);
  assert.equal(p.adopts[0].id, 'd1');
  assert.equal(p.adopts[0].fields.meta_template_id, 'm5');
  assert.equal(p.adopts[0].fields.status, 'pending');
});

test('adopt needs the same language and a row with no meta id', () => {
  const otherLang = row({ id: 'd1', meta_template_id: null, language: 'hi' });
  const registered = row({ id: 'd2', meta_template_id: 'other', language: 'en_US' });
  const p = plan([otherLang, registered], [metaTpl({ id: 'm5' })]);
  assert.equal(p.adopts.length, 0);
  assert.equal(p.creates.length, 1);
});

test('meta id match beats the name fallback', () => {
  const byId = row({ id: 'a', meta_template_id: 'm1' });
  const draft = row({ id: 'b', meta_template_id: null });
  const p = plan([byId, draft], [metaTpl({ id: 'm1' })]);
  assert.equal(p.adopts.length, 0);
  assert.equal([...p.updates, ...p.unchanged].length, 1);
  assert.equal([...p.updates, ...p.unchanged][0].id, 'a');
});

test('unchanged rows are not counted as updates', () => {
  const p = plan([row()], [metaTpl()]);
  assert.equal(p.updates.length, 0);
  assert.equal(p.unchanged.length, 1);
});

test('AUTHENTICATION (and any category the table can\'t hold) is skipped entirely, not stored', () => {
  const p = plan([], [metaTpl({ id: 'a1', name: 'otp', category: 'AUTHENTICATION' }), metaTpl({ id: 'a2', name: 'x', category: 'SOMETHING_NEW' })]);
  assert.equal(p.creates.length, 0);
  assert.equal(p.skipped.length, 2);
  assert.match(p.skipped[0].reason, /AUTHENTICATION/);
});

test('a skipped AUTHENTICATION listing never gets its own stored row flagged deleted', () => {
  const stored = row({ meta_template_id: 'a1' });
  const p = plan([stored], [metaTpl({ id: 'a1', category: 'AUTHENTICATION' })]);
  assert.equal(p.markDeleted.length, 0);
  assert.equal(p.updates.length + p.unchanged.length, 0); // left alone
});

test('named-parameter template is synced and flagged unsupported_named_params', () => {
  const p = plan([], [metaTpl({ parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{first_name}}' }] })]);
  assert.equal(p.creates.length, 1);
  assert.equal(p.creates[0].row.send_support, 'unsupported_named_params');
  assert.equal(p.creates[0].row.variable_count, 1);
  assert.equal(p.unsupported[0].sendSupport, 'unsupported_named_params');
});

test('a Meta status we don\'t map: not created, but a stored row keeps its status', () => {
  const p1 = plan([], [metaTpl({ status: 'ARCHIVED' })]);
  assert.equal(p1.creates.length, 0);
  assert.equal(p1.skipped.length, 1);
  const p2 = plan([row()], [metaTpl({ status: 'ARCHIVED' })]);
  assert.equal([...p2.updates, ...p2.unchanged][0].fields.status, 'approved');
});

test('soft delete: missing from a COMPLETE listing, has a meta id, not already deleted', () => {
  const gone = row({ id: 'g', meta_template_id: 'gone' });
  const draft = row({ id: 'd', meta_template_id: null, name: 'mine' });
  const already = row({ id: 'x', meta_template_id: 'x1', status: 'deleted', meta_deleted_at: '2026-10-01T00:00:00Z', name: 'old' });
  const p = plan([gone, draft, already, row({ id: 'k', meta_template_id: 'm1', name: 'keep' })], [metaTpl({ id: 'm1', name: 'keep' })]);
  assert.deepEqual(p.markDeleted.map(d => d.id), ['g']);
});

test('NOT flagged when the listing is not complete', () => {
  const p = plan([row({ id: 'g', meta_template_id: 'gone' })], [], false);
  assert.equal(p.markDeleted.length, 0);
});

test('empty COMPLETE listing for a business with registered templates: nothing soft-deleted, flagged', async () => {
  rows = [row({ id: 'a', meta_template_id: 'ma' }), row({ id: 'b2', name: 'b', meta_template_id: 'mb' })];
  assert.equal(plan(rows, []).markDeleted.length, 0);
  assert.equal(plan(rows, []).emptyListingSkipped, true);
  const { summary } = await svc.syncBusinessTemplates(biz, { now: NOW, fetchTemplates: async () => [] });
  assert.equal(summary.markedDeleted, 0);
  assert.equal(summary.emptyListingSkipped, true);
  assert.ok(rows.every(r => r.status === 'approved'));
});

test('empty listing with no registered rows is just a no-op; non-empty listing still soft-deletes', () => {
  assert.equal(plan([row({ meta_template_id: null })], []).emptyListingSkipped, false);
  assert.equal(plan([], []).emptyListingSkipped, false);
  assert.equal(plan([row({ meta_template_id: 'gone' })], [metaTpl({ id: 'other', name: 'o' })]).markDeleted.length, 1);
});

test('un-delete: a soft-deleted row that reappears gets Meta\'s status back and meta_deleted_at cleared', () => {
  const deleted = row({ status: 'deleted', meta_status: 'DELETED', meta_deleted_at: '2026-10-01T00:00:00Z' });
  const p = plan([deleted], [metaTpl({ status: 'APPROVED' })]);
  assert.equal(p.restores.length, 1);
  assert.equal(p.restores[0].fields.status, 'approved');
  assert.equal(p.restores[0].fields.meta_deleted_at, null);
});

test('Meta DELETED / PENDING_DELETION in the listing: status deleted + meta_deleted_at', () => {
  const p = plan([row()], [metaTpl({ status: 'PENDING_DELETION' })]);
  assert.equal(p.updates[0].fields.status, 'deleted');
  assert.equal(p.updates[0].fields.meta_deleted_at, NOW.toISOString());
});

test('columns the table doesn\'t have yet (migration pending) are not diffed', () => {
  const legacy = { id: 'r1', business_id: 'b', name: 'promo', language: 'en_US', category: 'MARKETING', body_text: 'Hi {{1}}', variable_count: 1,
    variable_samples: ['Rohan'], meta_template_id: 'm1', status: 'approved', rejection_reason: null, header_type: 'NONE' };
  const p = plan([legacy], [metaTpl()]);
  assert.equal(p.updates.length, 0);
});

// ── Meta listing ──
const page = (names, next) => ({ data: { data: names.map((n, i) => metaTpl({ id: `${n}`, name: n })), paging: next ? { cursors: { after: next }, next: 'https://graph/next' } : { cursors: { after: 'end' } } } });

test('listing: follows paging cursors until there is no next page', async () => {
  const calls = [];
  const http = { get: async (url, cfg) => { calls.push(cfg.params.after || null); return cfg.params.after === 'c1' ? page(['c'], null) : cfg.params.after === 'c0' ? page(['b'], 'c1') : page(['a'], 'c0'); } };
  const listed = await svc.fetchAllTemplates('waba1', 'tok', http);
  assert.deepEqual(listed.map(t => t.name), ['a', 'b', 'c']);
  assert.deepEqual(calls, [null, 'c0', 'c1']);
});

test('listing: invalid cursor (131059) restarts from the first page once', async () => {
  let n = 0; const afters = [];
  const http = { get: async (url, cfg) => {
    afters.push(cfg.params.after || null); n += 1;
    if (n === 2) { const e = new Error('bad cursor'); e.response = { data: { error: { code: 131059 } } }; throw e; }
    return cfg.params.after ? page(['b'], null) : page(['a'], 'c0');
  } };
  const listed = await svc.fetchAllTemplates('waba1', 'tok', http);
  assert.deepEqual(listed.map(t => t.name), ['a', 'b']); // a from the restart, not duplicated from before
  assert.deepEqual(afters, [null, 'c0', null, 'c0']);
});

test('listing: a second invalid cursor, or any other error, rejects', async () => {
  const bad = (code) => { const e = new Error('x'); e.response = { data: { error: { code } } }; return e; };
  await assert.rejects(svc.fetchAllTemplates('w', 't', { get: async (u, cfg) => { if (cfg.params.after) throw bad(131059); return page(['a'], 'c0'); } }));
  await assert.rejects(svc.fetchAllTemplates('w', 't', { get: async () => { throw bad(190); } }));
  // a "next" with no cursor can't be followed — never treated as complete
  await assert.rejects(svc.fetchAllTemplates('w', 't', { get: async () => ({ data: { data: [], paging: { next: 'u' } } }) }));
});

// ── Writes ──
const biz = { id: 'b', wabaId: 'waba1', accessToken: 'enc' };

test('dry run: reports the plan and writes nothing', async () => {
  rows = [row({ id: 'g', meta_template_id: 'gone', name: 'gone' })];
  const { summary } = await svc.syncBusinessTemplates(biz, { dryRun: true, now: NOW, fetchTemplates: async () => [metaTpl({ id: 'n1', name: 'fresh' })] });
  assert.equal(summary.created, 1);
  assert.equal(summary.markedDeleted, 1);
  assert.equal(summary.lastSyncedAt, null);
  assert.equal(writes.length, 0);
});

test('sync writes creates, updates, adopts and soft deletes, and reports counts', async () => {
  rows = [
    row({ id: 'upd', name: 'a', meta_template_id: 'ma', status: 'pending' }),
    row({ id: 'adopt', name: 'b', meta_template_id: null, status: 'draft' }),
    row({ id: 'gone', name: 'c', meta_template_id: 'mc' }),
    row({ id: 'same', name: 'd', meta_template_id: 'md' })
  ];
  const listed = [
    metaTpl({ id: 'ma', name: 'a' }),
    metaTpl({ id: 'mb', name: 'b' }),
    metaTpl({ id: 'md', name: 'd' }),
    metaTpl({ id: 'mn', name: 'n' }),
    metaTpl({ id: 'mx', name: 'otp', category: 'AUTHENTICATION' })
  ];
  const { summary } = await svc.syncBusinessTemplates(biz, { now: NOW, fetchTemplates: async () => listed });
  assert.deepEqual({ ...summary, unsupported: undefined }, {
    created: 1, updated: 1, adopted: 1, restored: 0, markedDeleted: 1, skipped: 1, failed: 0, emptyListingSkipped: false, unsupported: undefined, lastSyncedAt: NOW.toISOString()
  });
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId.upd.status, 'approved');
  assert.equal(byId.adopt.meta_template_id, 'mb');
  assert.equal(byId.adopt.source, 'app'); // an adopted row keeps its origin
  assert.equal(byId.gone.status, 'deleted');
  assert.equal(byId.gone.meta_deleted_at, NOW.toISOString());
  assert.equal(byId.same.last_synced_at, NOW.toISOString());
  const created = rows.find(r => r.meta_template_id === 'mn');
  assert.equal(created.source, 'meta_sync');
  assert.equal(created.business_id, 'b');
  assert.equal(rows.some(r => r.name === 'otp'), false);
});

test('a failed Meta listing flags nothing and writes nothing', async () => {
  rows = [row({ meta_template_id: 'm1' })];
  await assert.rejects(svc.syncBusinessTemplates(biz, { now: NOW, fetchTemplates: async () => { throw new Error('Meta down'); } }), /Meta down/);
  assert.equal(writes.length, 0);
  assert.equal(rows[0].status, 'approved');
});

test('an insert that fails is counted in failed, not created', async () => {
  insertError = { code: '23505', message: 'duplicate' };
  const { summary } = await svc.syncBusinessTemplates(biz, { now: NOW, fetchTemplates: async () => [metaTpl()] });
  assert.equal(summary.created, 0);
  assert.equal(summary.failed, 1);
});

test('a business with no WABA / token is a 400, nothing fetched', async () => {
  let fetched = false;
  await assert.rejects(
    svc.syncBusinessTemplates({ id: 'b', wabaId: null, accessToken: null }, { fetchTemplates: async () => { fetched = true; return []; } }),
    (e) => e.status === 400
  );
  assert.equal(fetched, false);
});

// ── Cooldown ──
test('cooldown: a second sync inside 60s is refused (429) with the wait; allowed after', async () => {
  const fetchTemplates = async () => [];
  await svc.runSync('b', { now: NOW, fetchTemplates });
  await assert.rejects(svc.runSync('b', { now: new Date(NOW.getTime() + 30 * 1000), fetchTemplates }), (e) => {
    assert.equal(e.name, 'SyncThrottledError');
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 30);
    assert.match(e.message, /30 seconds/);
    return true;
  });
  await svc.runSync('b', { now: new Date(NOW.getTime() + 61 * 1000), fetchTemplates }); // ok again
});

test('cooldown is per business', async () => {
  const fetchTemplates = async () => [];
  await svc.runSync('b1', { now: NOW, fetchTemplates });
  await svc.runSync('b2', { now: NOW, fetchTemplates });
});

test('a sync already running for the business is refused, not run twice', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const first = svc.runSync('b', { now: NOW, fetchTemplates: async () => { await gate; return []; } });
  await new Promise(r => setImmediate(r));
  await assert.rejects(svc.runSync('b', { now: NOW, fetchTemplates: async () => [] }), (e) => e.status === 429);
  release();
  await first;
});
