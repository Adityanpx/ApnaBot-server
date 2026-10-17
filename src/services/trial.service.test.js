// Run: node --test src/services/trial.service.test.js
// One 7-day Basic trial per WhatsApp number. Real trial + subscription services over an
// in-memory Supabase (trial_claims.phone_e164 UNIQUE modelled); Redis and the tenant cache stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeSupabase } = require('../test-support/fakeSupabase');

let fake; let failSubscriptionInsert;
const stubModule = (file, exports) => {
  const p = require.resolve(path.join(__dirname, file));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stubModule('../config/supabase.js', {
  from: (t) => {
    const q = fake.from(t);
    if (failSubscriptionInsert && t === 'subscriptions') {
      const orig = q.insert.bind(q);
      q.insert = (...a) => { orig(...a); return { ...q, select: () => ({ single: async () => ({ data: null, error: { message: 'boom' } }) }) }; };
    }
    return q;
  },
  rpc: (n, a) => fake.rpc(n, a)
});
stubModule('../config/redis.js', { get: async () => null, set: async () => {}, del: async () => {} });
stubModule('../utils/logger.js', { info: () => {}, warn: () => {}, error: () => {} });
stubModule('./subscriptionNotifications.service.js', {});
stubModule('./tenant.service.js', { invalidateTenantCache: async () => {} });
stubModule('./razorpaySubscriptions.service.js', { cancelRazorpaySubscription: async () => {} });

const trial = require('./trial.service');

const PLAN = 'plan-basic';
const seed = ({ config = [], subscriptions = [] } = {}) => {
  fake = createFakeSupabase({ uniques: [{ table: 'trial_claims', cols: ['phone_e164'] }] });
  fake.db.plans = [{ id: PLAN, name: 'basic', display_name: 'Basic', is_active: true }, { id: 'plan-pro', name: 'pro', is_active: true }];
  fake.db.businesses = [
    { id: 'b1', is_active: false, phone_number_id: 'pn1' },
    { id: 'b2', is_active: false, phone_number_id: 'pn2' }
  ];
  fake.db.app_config = config;
  fake.db.subscriptions = subscriptions;
  fake.db.trial_claims = [];
  failSubscriptionInsert = false;
};
const grant = (businessId, whatsappNumber = '919876543210', extra = {}) =>
  trial.grantTrialOnFirstConnect({ businessId, userId: `u-${businessId}`, whatsappNumber, wabaId: 'w', phoneNumberId: `pn-${businessId}`, ...extra });
const DAY = 24 * 60 * 60 * 1000;

test('first connect grants a 7-day trial on the Basic plan and links the claim', async () => {
  seed();
  const before = Date.now();
  const result = await grant('b1');
  assert.equal(result.granted, true);
  const sub = fake.db.subscriptions[0];
  assert.equal(sub.status, 'trial');
  assert.equal(sub.plan_id, PLAN);
  assert.equal(sub.business_id, 'b1');
  assert.equal(sub.auto_renew, false);
  const days = (new Date(sub.end_date) - new Date(sub.start_date)) / DAY;
  assert.ok(Math.abs(days - 7) < 0.01, `trial length ${days}d`);
  assert.ok(new Date(sub.start_date).getTime() >= before - 1000);
  assert.equal(result.endsAt, sub.end_date);
  const claim = fake.db.trial_claims[0];
  assert.equal(claim.phone_e164, '919876543210');
  assert.equal(claim.business_id, 'b1');
  assert.equal(claim.user_id, 'u-b1');
  assert.equal(claim.subscription_id, sub.id);
  assert.equal(fake.db.businesses[0].is_active, true);
});

test('the number is normalised to E.164 digits before claiming', async () => {
  seed();
  await grant('b1', '+91 98765-43210');
  assert.equal(fake.db.trial_claims[0].phone_e164, '919876543210');
  assert.equal(trial.normalizePhoneE164('+91 (98765) 43210'), '919876543210');
  assert.equal(trial.normalizePhoneE164('12345'), null);
  assert.equal(trial.normalizePhoneE164(null), null);
});

test('the same number on a second business is denied, with no subscription and no second claim', async () => {
  seed();
  await grant('b1');
  const second = await grant('b2', '+91 98765 43210');
  assert.deepEqual(second, { granted: false, reason: 'number_already_used' });
  assert.equal(fake.db.subscriptions.filter((s) => s.business_id === 'b2').length, 0);
  assert.equal(fake.db.trial_claims.length, 1);
});

test('two simultaneous connects with the same number produce exactly one trial', async () => {
  seed();
  const [a, b] = await Promise.all([grant('b1'), grant('b2')]);
  assert.equal([a, b].filter((r) => r.granted).length, 1);
  assert.deepEqual([a, b].find((r) => !r.granted), { granted: false, reason: 'number_already_used' });
  assert.equal(fake.db.subscriptions.length, 1);
  assert.equal(fake.db.trial_claims.length, 1);
});

test('a business that already has a subscription row (any status) gets no trial and burns no claim', async () => {
  seed({ subscriptions: [{ id: 's0', business_id: 'b1', plan_id: 'plan-pro', status: 'expired', end_date: '2020-01-01T00:00:00Z' }] });
  const result = await grant('b1');
  assert.deepEqual(result, { granted: false, reason: 'already_subscribed' });
  assert.equal(fake.db.trial_claims.length, 0);
  assert.equal(fake.db.subscriptions.length, 1);
});

test('trialEnabled=false grants nothing', async () => {
  seed({ config: [{ key: 'trial_enabled', value: 'false' }] });
  assert.deepEqual(await grant('b1'), { granted: false, reason: 'trial_disabled' });
  assert.equal(fake.db.trial_claims.length, 0);
  assert.equal(fake.db.subscriptions.length, 0);
});

test('settings: defaults, and app_config overrides for days and plan', async () => {
  seed();
  assert.deepEqual(await trial.getTrialSettings(), { trialEnabled: true, trialDays: 7, trialPlanId: PLAN, trialPlanIsDefault: true });
  seed({ config: [{ key: 'trial_days', value: '14' }, { key: 'trial_plan_id', value: '11111111-1111-4111-8111-111111111111' }] });
  const s = await trial.getTrialSettings();
  assert.equal(s.trialDays, 14);
  assert.equal(s.trialPlanId, '11111111-1111-4111-8111-111111111111');
  assert.equal(s.trialPlanIsDefault, false);
});

test('a custom trialDays and trialPlanId are used for the grant', async () => {
  seed({ config: [{ key: 'trial_days', value: '3' }] });
  fake.db.plans.push({ id: '22222222-2222-4222-8222-222222222222', name: 'pro2', is_active: true });
  await trial.updateTrialSettings({ trialPlanId: '22222222-2222-4222-8222-222222222222' }, 'admin');
  await grant('b1');
  const sub = fake.db.subscriptions[0];
  assert.equal(sub.plan_id, '22222222-2222-4222-8222-222222222222');
  assert.ok(Math.abs((new Date(sub.end_date) - new Date(sub.start_date)) / DAY - 3) < 0.01);
});

test('updateTrialSettings validates input and null reverts the plan to the default', async () => {
  seed();
  await assert.rejects(trial.updateTrialSettings({ trialDays: 0 }, 'a'), { statusCode: 400 });
  await assert.rejects(trial.updateTrialSettings({ trialDays: 1.5 }, 'a'), { statusCode: 400 });
  await assert.rejects(trial.updateTrialSettings({ trialEnabled: 'yes' }, 'a'), { statusCode: 400 });
  await assert.rejects(trial.updateTrialSettings({ trialPlanId: 'nope' }, 'a'), { statusCode: 400 });
  await assert.rejects(trial.updateTrialSettings({ trialPlanId: '33333333-3333-4333-8333-333333333333' }, 'a'), { statusCode: 404 });
  await assert.rejects(trial.updateTrialSettings({ bogus: 1 }, 'a'), { statusCode: 400 });
  await assert.rejects(trial.updateTrialSettings({}, 'a'), { statusCode: 400 });
  const s = await trial.updateTrialSettings({ trialEnabled: false, trialDays: 10 }, 'admin');
  assert.equal(s.trialEnabled, false);
  assert.equal(s.trialDays, 10);
  fake.db.plans.push({ id: '44444444-4444-4444-8444-444444444444', name: 'x', is_active: true });
  await trial.updateTrialSettings({ trialPlanId: '44444444-4444-4444-8444-444444444444' }, 'admin');
  const reverted = await trial.updateTrialSettings({ trialPlanId: null }, 'admin');
  assert.equal(reverted.trialPlanId, PLAN);
  assert.equal(reverted.trialPlanIsDefault, true);
});

test('if creating the subscription fails, the claim is removed again so a retry can still get the trial', async () => {
  seed();
  failSubscriptionInsert = true;
  assert.deepEqual(await grant('b1'), { granted: false, reason: 'error' });
  assert.equal(fake.db.trial_claims.length, 0);
  failSubscriptionInsert = false;
  assert.equal((await grant('b1')).granted, true);
});

test('no Basic plan and no configured plan: no trial, no claim, no throw', async () => {
  seed();
  fake.db.plans = [];
  assert.deepEqual(await grant('b1'), { granted: false, reason: 'no_trial_plan' });
  assert.equal(fake.db.trial_claims.length, 0);
});

test('an unusable number gets no trial', async () => {
  seed();
  assert.deepEqual(await grant('b1', 'abc'), { granted: false, reason: 'invalid_number' });
  assert.equal(fake.db.trial_claims.length, 0);
});

test('admin: list/search claims and delete requires a reason, then frees the number', async () => {
  seed();
  await grant('b1');
  const claimId = fake.db.trial_claims[0].id;
  const listed = await trial.listTrialClaims({});
  assert.equal(listed.claims.length, 1);
  assert.equal(listed.claims[0].phone_e164, '919876543210');

  await assert.rejects(trial.deleteTrialClaim(claimId, '', 'admin'), { statusCode: 400 });
  await assert.rejects(trial.deleteTrialClaim(claimId, undefined, 'admin'), { statusCode: 400 });
  assert.equal(fake.db.trial_claims.length, 1);
  await assert.rejects(trial.deleteTrialClaim('nope', 'support reset', 'admin'), { statusCode: 404 });

  await trial.deleteTrialClaim(claimId, 'owner changed SIM, support ticket 12', 'admin');
  assert.equal(fake.db.trial_claims.length, 0);
  // the number may claim again, but only a business with no subscription row (b2)
  assert.equal((await grant('b2')).granted, true);
  assert.equal((await grant('b1', '919876543210')).reason, 'already_subscribed');
});
