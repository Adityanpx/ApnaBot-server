// One free Basic trial per WhatsApp number (trial_claims.phone_e164 is UNIQUE).
// Settings live in app_config: trial_enabled, trial_days, trial_plan_id.
const supabase = require('../config/supabase');
const logger = require('../utils/logger');
const subscriptionService = require('./subscription.service');

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

const DEFAULT_TRIAL_DAYS = 7;
const MAX_TRIAL_DAYS = 365;
const DEFAULT_PLAN_NAME = 'basic';
const KEYS = { trialEnabled: 'trial_enabled', trialDays: 'trial_days', trialPlanId: 'trial_plan_id' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WhatsApp number as E.164 digits (no '+', no leading zeros), or null if it can't be one. */
const normalizePhoneE164 = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
};

const readSettingRows = async () => {
  const { data, error } = await supabase.from('app_config').select('key, value').in('key', Object.values(KEYS));
  if (error) throw error;
  return new Map((data || []).map((r) => [r.key, r.value]));
};

// The plan named 'basic' (plans.name is the unique key; display_name is 'Basic'), or null.
const findDefaultPlanId = async () => {
  const { data, error } = await supabase.from('plans').select('id').eq('name', DEFAULT_PLAN_NAME).maybeSingle();
  if (error) throw error;
  return data ? data.id : null;
};

/**
 * Effective trial settings. A missing / malformed app_config row falls back to
 * the default (enabled, 7 days, the 'basic' plan). trialPlanIsDefault tells the
 * admin UI whether trialPlanId was set explicitly.
 */
const getTrialSettings = async () => {
  const rows = await readSettingRows();
  const rawDays = Number(rows.get(KEYS.trialDays));
  const explicitPlanId = rows.get(KEYS.trialPlanId);
  const hasExplicitPlan = typeof explicitPlanId === 'string' && UUID_PATTERN.test(explicitPlanId);
  return {
    trialEnabled: rows.get(KEYS.trialEnabled) === 'false' ? false : true,
    trialDays: Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= MAX_TRIAL_DAYS ? rawDays : DEFAULT_TRIAL_DAYS,
    trialPlanId: hasExplicitPlan ? explicitPlanId : await findDefaultPlanId(),
    trialPlanIsDefault: !hasExplicitPlan
  };
};

/** Partial update; trialPlanId: null reverts to the default plan. Returns the new effective settings. */
const updateTrialSettings = async (body, userId) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Request body must be an object');
  const names = Object.keys(body);
  if (names.length === 0) throw httpError(400, `Provide at least one of: ${Object.keys(KEYS).join(', ')}`);
  const unknown = names.filter((n) => !KEYS[n]);
  if (unknown.length > 0) throw httpError(400, `Unknown field(s): ${unknown.join(', ')}. Allowed: ${Object.keys(KEYS).join(', ')}`);

  const upserts = [];
  let revertPlan = false;
  if ('trialEnabled' in body) {
    if (typeof body.trialEnabled !== 'boolean') throw httpError(400, 'trialEnabled must be true or false');
    upserts.push({ key: KEYS.trialEnabled, value: String(body.trialEnabled), updated_by: userId });
  }
  if ('trialDays' in body) {
    if (!Number.isInteger(body.trialDays) || body.trialDays < 1 || body.trialDays > MAX_TRIAL_DAYS) {
      throw httpError(400, `trialDays must be a whole number from 1 to ${MAX_TRIAL_DAYS}`);
    }
    upserts.push({ key: KEYS.trialDays, value: String(body.trialDays), updated_by: userId });
  }
  if ('trialPlanId' in body) {
    if (body.trialPlanId === null) {
      revertPlan = true;
    } else {
      if (typeof body.trialPlanId !== 'string' || !UUID_PATTERN.test(body.trialPlanId)) throw httpError(400, 'trialPlanId must be a plan id or null');
      const { data: plan, error } = await supabase.from('plans').select('id, is_active').eq('id', body.trialPlanId).maybeSingle();
      if (error) throw error;
      if (!plan) throw httpError(404, 'Plan not found');
      if (plan.is_active === false) throw httpError(400, 'That plan is not active');
      upserts.push({ key: KEYS.trialPlanId, value: body.trialPlanId, updated_by: userId });
    }
  }

  if (upserts.length > 0) {
    const { error } = await supabase.from('app_config').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;
  }
  if (revertPlan) {
    const { error } = await supabase.from('app_config').delete().eq('key', KEYS.trialPlanId);
    if (error) throw error;
  }
  return getTrialSettings();
};

/**
 * Grants the one-time trial on a business's first successful WhatsApp connect.
 * Call it AFTER the connection is saved. Never throws and never needs to be
 * awaited for correctness of the connect itself: any failure is logged and
 * reported as { granted: false, reason: 'error' }.
 *
 * Returns { granted: true, endsAt } or { granted: false, reason } with reason one of
 * trial_disabled | invalid_number | already_subscribed | number_already_used |
 * no_trial_plan | error.
 *
 * Order matters: a business that already has a subscription is refused BEFORE a
 * claim is written (so no number is burned for nothing); the claim insert is the
 * race guard (UNIQUE phone_e164 - a simultaneous second connect gets 23505); and
 * if creating the subscription then fails the claim is removed again so the
 * number can still get its trial on a retry.
 */
const grantTrialOnFirstConnect = async ({ businessId, userId = null, whatsappNumber, wabaId = null, phoneNumberId = null }) => {
  let claimId = null;
  try {
    const settings = await getTrialSettings();
    if (!settings.trialEnabled) return { granted: false, reason: 'trial_disabled' };

    const phoneE164 = normalizePhoneE164(whatsappNumber);
    if (!phoneE164) return { granted: false, reason: 'invalid_number' };

    const { data: existingSubs, error: subErr } = await supabase
      .from('subscriptions').select('id').eq('business_id', businessId).limit(1);
    if (subErr) throw subErr;
    if ((existingSubs || []).length > 0) return { granted: false, reason: 'already_subscribed' };

    if (!settings.trialPlanId) {
      logger.error('Trial not granted: no trial plan configured and no plan named "basic" exists', { businessId });
      return { granted: false, reason: 'no_trial_plan' };
    }

    const { data: claim, error: claimErr } = await supabase.from('trial_claims').insert({
      phone_e164: phoneE164,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      business_id: businessId,
      user_id: userId
    }).select('id').single();
    if (claimErr) {
      if (claimErr.code === '23505') return { granted: false, reason: 'number_already_used' };
      throw claimErr;
    }
    claimId = claim.id;

    const sub = await subscriptionService.createSubscription(businessId, settings.trialPlanId, {
      status: 'trial',
      durationDays: settings.trialDays,
      autoRenew: false
    });

    const { error: linkErr } = await supabase.from('trial_claims').update({ subscription_id: sub.id }).eq('id', claimId);
    if (linkErr) logger.error('Trial granted but the claim could not be linked to its subscription', { businessId, claimId, error: linkErr.message });

    logger.info('Trial granted', { businessId, subscriptionId: sub.id, endsAt: sub.end_date });
    return { granted: true, endsAt: sub.end_date };
  } catch (error) {
    logger.error('Trial grant failed - WhatsApp connection is unaffected', { businessId, error: error.message });
    if (claimId) {
      const { error: undoErr } = await supabase.from('trial_claims').delete().eq('id', claimId);
      if (undoErr) logger.error('Could not remove the trial claim after a failed grant - remove it by hand', { businessId, claimId, error: undoErr.message });
    }
    return { granted: false, reason: 'error' };
  }
};

// ── Super Admin ────────────────────────────────────────────────────────────

/**
 * Claims, newest first, with the business name. `search` matches the phone
 * (digits) or the business name / display name.
 */
const listTrialClaims = async ({ search, limit = 50, offset = 0 } = {}) => {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const from = Math.max(parseInt(offset, 10) || 0, 0);
  let query = supabase.from('trial_claims').select('*', { count: 'exact' });

  const term = typeof search === 'string' ? search.trim() : '';
  if (term) {
    const digits = term.replace(/\D/g, '');
    const orParts = [];
    if (digits) orParts.push(`phone_e164.ilike.%${digits}%`);
    const safe = term.replace(/[%,()*\\]/g, ' ').trim();
    if (safe) {
      const { data: matched, error: bizErr } = await supabase
        .from('businesses').select('id').or(`name.ilike.%${safe}%,display_name.ilike.%${safe}%`).limit(200);
      if (bizErr) throw bizErr;
      if ((matched || []).length > 0) orParts.push(`business_id.in.(${matched.map((b) => b.id).join(',')})`);
    }
    if (orParts.length === 0) return { claims: [], total: 0 };
    query = query.or(orParts.join(','));
  }

  const { data, count, error } = await query
    .order('claimed_at', { ascending: false }).range(from, from + pageSize - 1);
  if (error) throw error;

  const ids = [...new Set((data || []).map((c) => c.business_id).filter(Boolean))];
  const names = new Map();
  if (ids.length > 0) {
    const { data: businesses, error: namesErr } = await supabase
      .from('businesses').select('id, name, display_name').in('id', ids);
    if (namesErr) throw namesErr;
    for (const b of businesses || []) names.set(b.id, b.display_name || b.name);
  }
  return {
    claims: (data || []).map((c) => ({ ...c, business_name: c.business_id ? (names.get(c.business_id) || null) : null })),
    total: count ?? (data || []).length
  };
};

/**
 * Support reset: deletes a claim so that number can take a trial again. Needs a
 * reason, which is logged with the admin and the claim. Does NOT touch any
 * subscription row (a business that already has one still gets no trial).
 */
const deleteTrialClaim = async (id, reason, adminUserId) => {
  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 3) throw httpError(400, 'reason is required');

  const { data: claim, error } = await supabase.from('trial_claims').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!claim) throw httpError(404, 'Trial claim not found');

  const { error: delErr } = await supabase.from('trial_claims').delete().eq('id', id);
  if (delErr) throw delErr;

  logger.info('Trial claim deleted by Super Admin', {
    claimId: id, phoneE164: claim.phone_e164, businessId: claim.business_id,
    subscriptionId: claim.subscription_id, adminUserId, reason: cleanReason
  });
  return claim;
};

module.exports = {
  normalizePhoneE164,
  getTrialSettings,
  updateTrialSettings,
  grantTrialOnFirstConnect,
  listTrialClaims,
  deleteTrialClaim
};
