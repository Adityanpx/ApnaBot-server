// Run: node --test src/utils/followup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('./followup');

const DAY = 1440;
const marketingTpl = (over = {}) => ({
  id: 't1', name: 'come_back', status: 'approved', category: 'MARKETING', header_type: 'NONE',
  body_text: 'Hi {{1}}, {{2}} misses you!', ...over
});
const nameMapping = [
  { source: 'customer.name', fallback: 'there' },
  { source: 'business.name', fallback: 'us' }
];

test('enquiry_nudge: defaults filled in, default text + hi/mr translations copied', () => {
  const r = f.validateAutomation({ preset: 'enquiry_nudge', name: 'Nudge' });
  assert.ok(r.value, r.error);
  assert.equal(r.value.trigger_type, 'after_last_inbound');
  assert.equal(r.value.message_category, 'marketing');
  assert.equal(r.value.delay_minutes, 180);
  assert.equal(r.value.per_customer_cap, 3);
  assert.equal(r.value.daily_cap, 100);
  assert.equal(r.value.send_start_minute, 540);
  assert.equal(r.value.send_end_minute, 1260);
  assert.deepEqual(r.value.trigger_params, { recentBookingDays: 7 });
  assert.match(r.value.message_text, /^Hi \{\{customerName\}\}, just checking in/);
  assert.deepEqual(Object.keys(r.value.message_text_translations).sort(), ['hi', 'mr']);
  assert.equal(r.value.template_id, null);
});

test('owner text replaces the default (and its translations)', () => {
  const r = f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', messageText: '  Still there? ' });
  assert.equal(r.value.message_text, 'Still there?');
  assert.equal(r.value.message_text_translations, null);
});

test('enquiry_nudge: delay range 30 min – 23 h', () => {
  const at = (delayMinutes) => f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', delayMinutes });
  assert.ok(at(30).value);
  assert.ok(at(23 * 60).value);
  assert.match(at(29).error, /between 30 and 1380/);
  assert.match(at(23 * 60 + 1).error, /between 30 and 1380/);
  assert.match(at(90.5).error, /whole number/);
});

test('enquiry_nudge is text-only: a template is refused', () => {
  const r = f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', templateId: 't1' }, { templateRow: marketingTpl() });
  assert.match(r.error, /free text reply only/);
});

test('name 1–35 chars; send hours must differ; caps in DB ranges', () => {
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: '  ' }).error, /name is required/);
  assert.ok(f.validateAutomation({ preset: 'enquiry_nudge', name: 'x'.repeat(35) }).value);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'x'.repeat(36) }).error, /at most 35/);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', sendStartMinute: 600, sendEndMinute: 600 }).error, /same time/);
  assert.ok(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', sendStartMinute: 1320, sendEndMinute: 480 }).value); // overnight
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', sendEndMinute: 1441 }).error, /sendEndMinute/);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', perCustomerCap: 6 }).error, /perCustomerCap/);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', perCustomerCap: 0 }).error, /perCustomerCap/);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', dailyCap: 0 }).error, /dailyCap/);
});

test('win_back: approved MARKETING template required, 7–180 days, mapping count must match', () => {
  const base = { preset: 'win_back', name: 'Come back', templateId: 't1', templateVariableMapping: nameMapping };
  const ok = f.validateAutomation(base, { templateRow: marketingTpl() });
  assert.ok(ok.value, ok.error);
  assert.equal(ok.value.delay_minutes, 30 * DAY);
  assert.deepEqual(ok.value.trigger_params, { onlyPastCustomers: true, maxInactiveDays: 180 });
  assert.equal(ok.value.per_customer_cap, 2);
  assert.equal(ok.value.send_start_minute, 600);

  assert.match(f.validateAutomation({ ...base, templateId: null }, {}).error, /Pick an approved/);
  assert.match(f.validateAutomation(base, { templateRow: null }).error, /Template not found/);
  assert.match(f.validateAutomation(base, { templateRow: marketingTpl({ status: 'pending' }) }).error, /not approved/);
  assert.match(f.validateAutomation(base, { templateRow: marketingTpl({ category: 'UTILITY' }) }).error, /needs a MARKETING template/);
  assert.match(f.validateAutomation(base, { templateRow: marketingTpl({ header_type: 'IMAGE' }) }).error, /image header/);
  assert.match(f.validateAutomation({ ...base, templateVariableMapping: [nameMapping[0]] }, { templateRow: marketingTpl() }).error, /exactly 2 entries/);
  assert.match(f.validateAutomation({ ...base, delayMinutes: 6 * DAY }, { templateRow: marketingTpl() }).error, /between 10080 and 259200/);
  assert.match(f.validateAutomation({ ...base, delayMinutes: 181 * DAY }, { templateRow: marketingTpl() }).error, /between/);
  assert.match(f.validateAutomation({ ...base, delayMinutes: 60 * DAY, triggerParams: { maxInactiveDays: 30 } }, { templateRow: marketingTpl() }).error, /longer than the delay/);
});

test('mapping entries: source, static value, fallback', () => {
  const run = (mapping) => f.validateAutomation(
    { preset: 'win_back', name: 'W', templateId: 't1', templateVariableMapping: mapping },
    { templateRow: marketingTpl() }
  );
  assert.match(run([{ source: 'customer.phone', fallback: 'x' }, nameMapping[1]]).error, /source must be one of/);
  assert.match(run([{ source: 'static', fallback: 'x' }, nameMapping[1]]).error, /value is required/);
  // fallback is optional: stored as '' and filled by template language at send time
  assert.deepEqual(run([{ source: 'customer.name' }, { source: 'business.name' }]).value.template_variable_mapping,
    [{ source: 'customer.name', fallback: '' }, { source: 'business.name', fallback: '' }]);
  assert.deepEqual(run([{ source: 'customer.name', fallback: '  ' }, nameMapping[1]]).value.template_variable_mapping[0],
    { source: 'customer.name', fallback: '' });
  assert.match(run([{ source: 'customer.name', fallback: 5 }, nameMapping[1]]).error, /fallback must be text/);
  assert.match(run([{ source: 'static', value: '  ' }, nameMapping[1]]).error, /value is required/);
  assert.deepEqual(run([{ source: 'static', value: ' 10% off ', fallback: 'an offer' }, nameMapping[1]]).value.template_variable_mapping[0],
    { source: 'static', value: '10% off', fallback: 'an offer' });
});

test('custom: after_last_inbound follows the text-only rules; inactive_for needs a template, 1–180 days', () => {
  const inbound = f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'after_last_inbound', delayMinutes: 60, messageText: 'Hi' });
  assert.ok(inbound.value, inbound.error);
  assert.equal(inbound.value.message_category, 'marketing');
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'after_last_inbound', delayMinutes: 24 * 60, messageText: 'Hi' }).error, /between 30 and 1380/);
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'after_last_inbound', delayMinutes: 60 }).error, /messageText is required/);

  const utilityTpl = marketingTpl({ category: 'UTILITY' });
  const inactive = f.validateAutomation({
    preset: 'custom', name: 'C', triggerType: 'inactive_for', delayMinutes: DAY, messageText: 'Hi',
    messageCategory: 'utility', templateId: 't1', templateVariableMapping: nameMapping
  }, { templateRow: utilityTpl });
  assert.ok(inactive.value, inactive.error);
  assert.deepEqual(inactive.value.trigger_params, { onlyPastCustomers: false, maxInactiveDays: 180 });
  // template category must match the chosen message category
  assert.match(f.validateAutomation({
    preset: 'custom', name: 'C', triggerType: 'inactive_for', delayMinutes: DAY, messageText: 'Hi', templateId: 't1', templateVariableMapping: nameMapping
  }, { templateRow: utilityTpl }).error, /needs a MARKETING template/);
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'inactive_for', delayMinutes: 600, messageText: 'Hi' }).error, /between 1440/);
});

test('custom: other triggers and the unbuilt presets are "available soon"', () => {
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'after_completed', messageText: 'Hi' }).error, /available soon/);
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'after_payment_requested', messageText: 'Hi' }).error, /available soon/);
  assert.match(f.validateAutomation({ preset: 'custom', name: 'C', triggerType: 'nope', messageText: 'Hi' }).error, /triggerType must be one of/);
  assert.match(f.validateAutomation({ preset: 'review_request', name: 'R' }).error, /available soon/);
  assert.match(f.validateAutomation({ preset: 'payment_pending', name: 'P' }).error, /available soon/);
  assert.match(f.validateAutomation({ preset: 'booking_reminder', name: 'B' }).error, /preset must be one of/);
});

test('presets cannot change their trigger or category', () => {
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', triggerType: 'inactive_for' }).error, /always uses/);
  assert.match(f.validateAutomation({ preset: 'enquiry_nudge', name: 'N', messageCategory: 'utility' }).error, /always sends/);
});

test('rowToInput round-trips a saved row', () => {
  const v = f.validateAutomation({ preset: 'enquiry_nudge', name: 'Nudge', delayMinutes: 120 }).value;
  assert.deepEqual(f.validateAutomation(f.rowToInput(v)).value, v);
});

test('trigger keys: one per last inbound, normalised to ISO', () => {
  assert.equal(f.inboundTriggerKey('2026-10-03T10:00:00.123456+00:00'), 'inbound:2026-10-03T10:00:00.123Z');
  assert.equal(f.inactiveTriggerKey('2026-10-03T10:00:00Z'), 'inactive:2026-10-03T10:00:00.000Z');
  assert.equal(f.triggerKeyFor({ trigger_type: 'inactive_for' }, { last_message_at: '2026-10-03T10:00:00Z' }), 'inactive:2026-10-03T10:00:00.000Z');
  assert.equal(f.triggerKeyFor({ trigger_type: 'after_last_inbound' }, { last_message_at: '2026-10-03T10:00:00Z' }), 'inbound:2026-10-03T10:00:00.000Z');
});

test('dueRange: inbound keeps 10 min of the window; inactive bounded by maxInactiveDays', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const inbound = f.dueRange({ trigger_type: 'after_last_inbound', delay_minutes: 180 }, now);
  assert.equal(inbound.before.toISOString(), '2026-10-03T09:00:00.000Z');
  assert.equal(inbound.after.toISOString(), '2026-10-02T12:10:00.000Z');
  const inactive = f.dueRange({ trigger_type: 'inactive_for', delay_minutes: 30 * DAY, trigger_params: { maxInactiveDays: 90 } }, now);
  assert.equal(inactive.before.toISOString(), '2026-09-03T12:00:00.000Z');
  assert.equal(inactive.after.toISOString(), '2026-07-05T12:00:00.000Z');
});

test('rendering: localized text with {{customerName}}, template params with fallbacks', () => {
  const automation = { message_text: 'Hi {{customerName}} from {{businessName}}', message_text_translations: { hi: 'नमस्ते {{customerName}}' } };
  const business = { name: 'Bright', displayName: 'Bright Minds' };
  assert.equal(f.renderText(automation, business, { name: 'Asha' }, null), 'Hi Asha from Bright Minds');
  assert.equal(f.renderText(automation, business, { name: '' }, 'mr'), 'Hi there from Bright Minds'); // no mr → English
  assert.equal(f.renderText(automation, business, { name: 'Asha' }, 'hi'), 'नमस्ते Asha');
  const params = f.renderTemplateParams(
    [{ source: 'customer.name', fallback: 'there' }, { source: 'business.name', fallback: 'us' }, { source: 'static', value: '10% off', fallback: 'x' }],
    business, { name: '  ' }
  );
  assert.deepEqual(params, ['there', 'Bright Minds', '10% off']);
  assert.equal(f.renderTemplateText('Hi {{1}}, {{2}} offers {{ 3 }}', params), 'Hi there, Bright Minds offers 10% off');
});

test('presetsForWeb lists every preset with limits and default text', () => {
  const list = f.presetsForWeb();
  assert.deepEqual(list.map(p => p.key), ['enquiry_nudge', 'win_back', 'custom', 'review_request', 'payment_pending']);
  assert.equal(list.find(p => p.key === 'review_request').available, false);
  assert.match(list.find(p => p.key === 'win_back').defaultText, /it's been a while/);
  assert.deepEqual(list.find(p => p.key === 'custom').triggerTypes, ['after_last_inbound', 'inactive_for']);
});

test('countTemplateVariables counts distinct {{n}}', () => {
  assert.equal(f.countTemplateVariables('Hi {{1}} {{1}} {{ 2 }}'), 2);
  assert.equal(f.countTemplateVariables('No vars'), 0);
});

test('empty-name fallback follows the language of the text actually sent', () => {
  const automation = {
    message_text: 'Hi {{customerName}}!',
    message_text_translations: { hi: 'नमस्ते {{customerName}}!', mr: 'नमस्कार {{customerName}}!' }
  };
  const business = { name: 'B' };
  for (const [lang, named, unnamed] of [
    [null, 'Hi Asha!', 'Hi there!'],
    ['en', 'Hi Asha!', 'Hi there!'],
    ['hi', 'नमस्ते Asha!', 'नमस्ते जी!'],
    ['mr', 'नमस्कार Asha!', 'नमस्कार जी!']
  ]) {
    assert.equal(f.renderText(automation, business, { name: 'Asha' }, lang), named, `${lang} named`);
    assert.equal(f.renderText(automation, business, { name: '  ' }, lang), unnamed, `${lang} unnamed`);
    assert.equal(f.renderText(automation, business, null, lang), unnamed, `${lang} no customer`);
  }
  // Hindi customer but no Hindi text → the English text, so the English fallback.
  assert.equal(f.renderText({ message_text: 'Hi {{customerName}}!' }, business, { name: '' }, 'hi'), 'Hi there!');
  // A name with $ characters is inserted as-is.
  assert.equal(f.renderText({ message_text: 'Hi {{customerName}}' }, business, { name: 'A$&B' }, null), 'Hi A$&B');
});

test("template customer.name: the owner's fallback wins; with none, the template language decides", () => {
  const business = { name: 'B' };
  const withFallback = [{ source: 'customer.name', fallback: 'friend' }];
  const noFallback = [{ source: 'customer.name', fallback: '' }];
  for (const lang of ['en_US', 'hi', 'mr', null]) {
    assert.deepEqual(f.renderTemplateParams(withFallback, business, { name: '' }, lang), ['friend'], `${lang} owner fallback`);
    assert.deepEqual(f.renderTemplateParams(withFallback, business, { name: 'Asha' }, lang), ['Asha'], `${lang} named`);
  }
  assert.deepEqual(f.renderTemplateParams(noFallback, business, { name: '' }, 'hi'), ['जी']);
  assert.deepEqual(f.renderTemplateParams(noFallback, business, { name: null }, 'mr'), ['जी']);
  assert.deepEqual(f.renderTemplateParams(noFallback, business, null, 'hi_IN'), ['जी']);
  assert.deepEqual(f.renderTemplateParams(noFallback, business, { name: '  ' }, 'en_US'), ['there']);
  assert.deepEqual(f.renderTemplateParams(noFallback, business, { name: '' }), ['there']); // language unknown
});

test('presets carry the template filter the web dropdown applies', () => {
  const byKey = Object.fromEntries(f.presetsForWeb().map(p => [p.key, p]));
  assert.equal(byKey.enquiry_nudge.templateFilter, null);
  assert.deepEqual(byKey.win_back.templateFilter, { status: 'approved', headerType: 'NONE', category: 'MARKETING', categoryMatchesMessageCategory: false });
  assert.equal(byKey.custom.templateFilter, null);
  assert.deepEqual(byKey.custom.templateFilterByTrigger, {
    after_last_inbound: null,
    inactive_for: { status: 'approved', headerType: 'NONE', category: null, categoryMatchesMessageCategory: true }
  });
  assert.equal(byKey.review_request.templateFilter, null);
});
