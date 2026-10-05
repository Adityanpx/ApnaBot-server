// Follow-up automations — the owner's side (/api/followups): list with send
// stats, create / edit / switch on / delete, the send log, the presets and
// the wizard's "who would get this right now" count. Sending is
// followupSweep.service.js. Every function takes the businessId from the
// logged-in user and only touches that business's rows.
//
// Errors the owner can fix come back as { status, error }, like
// demoReminder.service.js#setDemoTime.
const supabase = require('../config/supabase');
const { countDueCustomers } = require('./followupSweep.service');
const {
  PRESETS, presetsForWeb, validateAutomation, rowToInput, ruleFor, maskNumber, countTemplateVariables
} = require('../utils/followup');
const { istDayStart } = require('../utils/ist');
const { toCamelCase } = require('../utils/caseConvert');

const DAY_MS = 24 * 60 * 60 * 1000;
const SENT_STATUSES = ['sent_text', 'sent_template'];
const TEMPLATE_COLUMNS = 'id, name, status, category, language, body_text, header_type, send_support';

const toApi = (row) => {
  const { template, ...rest } = row;
  return { ...toCamelCase(rest), template: template ? toCamelCase(template) : null };
};

const loadTemplate = async (businessId, templateId) => {
  if (!templateId) return null;
  const { data, error } = await supabase.from('message_templates').select('*')
    .eq('id', templateId).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

const loadRow = async (businessId, id) => {
  const { data, error } = await supabase.from('followup_automations').select('*')
    .eq('id', id).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

const loadWithTemplate = async (businessId, id) => {
  const { data, error } = await supabase.from('followup_automations')
    .select(`*, template:message_templates(${TEMPLATE_COLUMNS})`)
    .eq('id', id).eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

/** Validates input against the business's own template (if any). */
const validate = async (businessId, input) => {
  const templateId = input && input.templateId ? input.templateId : null;
  const templateRow = await loadTemplate(businessId, templateId);
  return validateAutomation(input, { templateRow });
};

/** Every automation, newest first, each with sentToday / sent7d / skipped7d. */
const list = async (businessId, now = new Date()) => {
  const { data: rows, error } = await supabase.from('followup_automations')
    .select(`*, template:message_templates(${TEMPLATE_COLUMNS})`)
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const weekAgo = new Date(new Date(now).getTime() - 7 * DAY_MS).toISOString();
  const todayStart = istDayStart(now).getTime();
  const stats = new Map((rows || []).map(r => [r.id, { sentToday: 0, sent7d: 0, skipped7d: 0 }]));
  for (let from = 0; ; from += 1000) {
    const { data, error: sendsErr } = await supabase.from('followup_sends').select('automation_id, status, created_at')
      .eq('business_id', businessId).gte('created_at', weekAgo)
      .order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
    if (sendsErr) throw sendsErr;
    for (const s of data || []) {
      const st = stats.get(s.automation_id);
      if (!st) continue;
      if (SENT_STATUSES.includes(s.status)) {
        st.sent7d += 1;
        if (new Date(s.created_at).getTime() >= todayStart) st.sentToday += 1;
      } else if (s.status === 'skipped') {
        st.skipped7d += 1;
      }
    }
    if (!data || data.length < 1000) break;
  }
  return (rows || []).map(r => ({ ...toApi(r), stats: stats.get(r.id) }));
};

const get = async (businessId, id) => {
  const row = await loadWithTemplate(businessId, id);
  return row ? toApi(row) : { status: 404, error: 'Automation not found' };
};

/** New automations start switched off. */
const create = async (businessId, userId, input) => {
  const checked = await validate(businessId, input);
  if (checked.error) return { status: 400, error: checked.error };
  const { data, error } = await supabase.from('followup_automations').insert({
    ...checked.value,
    business_id: businessId,
    created_by: userId || null,
    is_active: false
  }).select('id').single();
  if (error) throw error;
  return get(businessId, data.id);
};

/** Edits merge over the saved automation and are checked again. The preset can't change. */
const update = async (businessId, id, input) => {
  const existing = await loadRow(businessId, id);
  if (!existing) return { status: 404, error: 'Automation not found' };
  if (input && input.preset !== undefined && input.preset !== existing.preset) {
    return { status: 400, error: "An automation's preset can't be changed — create a new one" };
  }
  const merged = { ...rowToInput(existing), ...(input || {}), preset: existing.preset };
  // A new trigger on a custom automation starts from that trigger's defaults.
  if (input && input.triggerType && input.triggerType !== existing.trigger_type && input.triggerParams === undefined) {
    merged.triggerParams = undefined;
  }
  const checked = await validate(businessId, merged);
  if (checked.error) return { status: 400, error: checked.error };
  const { error } = await supabase.from('followup_automations').update(checked.value)
    .eq('id', id).eq('business_id', businessId);
  if (error) throw error;
  return get(businessId, id);
};

/** Switching on re-checks everything (e.g. a template WhatsApp has since rejected). */
const setActive = async (businessId, id, isActive) => {
  if (typeof isActive !== 'boolean') return { status: 400, error: 'isActive must be true or false' };
  const existing = await loadRow(businessId, id);
  if (!existing) return { status: 404, error: 'Automation not found' };
  if (isActive) {
    const checked = await validate(businessId, rowToInput(existing));
    if (checked.error) return { status: 400, error: checked.error };
  }
  const { error } = await supabase.from('followup_automations').update({ is_active: isActive })
    .eq('id', id).eq('business_id', businessId);
  if (error) throw error;
  return get(businessId, id);
};

/** Deletes the automation and (cascade) its send log. */
const remove = async (businessId, id) => {
  const { data, error } = await supabase.from('followup_automations').delete()
    .eq('id', id).eq('business_id', businessId).select('id');
  if (error) throw error;
  return data && data.length ? { deleted: true } : { status: 404, error: 'Automation not found' };
};

/** The automation's send log, newest first, with the customer's name and masked number. */
const listSends = async (businessId, automationId, { page = 1, limit = 20 } = {}) => {
  const existing = await loadRow(businessId, automationId);
  if (!existing) return { status: 404, error: 'Automation not found' };
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const { data, error, count } = await supabase.from('followup_sends')
    .select('*, customer:customers(name, whatsapp_number)', { count: 'exact' })
    .eq('automation_id', automationId).eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .range((pageNum - 1) * limitNum, pageNum * limitNum - 1);
  if (error) throw error;
  const sends = (data || []).map(({ customer, ...row }) => ({
    ...toCamelCase(row),
    customerName: customer ? customer.name : null,
    customerNumber: customer ? maskNumber(customer.whatsapp_number) : null
  }));
  return { sends, page: pageNum, limit: limitNum, total: count || 0 };
};

const presets = () => presetsForWeb();

/**
 * The business's templates a follow-up can send: approved, body-only (no
 * image header) and send_support 'ok'. The web narrows further per preset
 * with its templateFilter (category).
 */
const listTemplates = async (businessId) => {
  const { data, error } = await supabase.from('message_templates')
    .select('id, name, category, language, body_text, header_type')
    .eq('business_id', businessId).eq('status', 'approved').eq('send_support', 'ok').eq('header_type', 'NONE')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data || []).map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    language: t.language,
    bodyText: t.body_text,
    variableCount: countTemplateVariables(t.body_text)
  }));
};

/**
 * How many customers this (unsaved) setup would reach right now — trigger,
 * delay and trigger options only; caps, send hours, template and text are
 * ignored, so the wizard can ask before a template is picked.
 */
const previewAudience = async (businessId, input, now = new Date()) => {
  const p = input || {};
  const preset = PRESETS[p.preset];
  if (!preset) return { status: 400, error: `preset must be one of: ${Object.keys(PRESETS).join(', ')}` };
  if (!preset.available) return { status: 400, error: `"${preset.label}" is available soon` };
  const triggerType = p.preset === 'custom' ? p.triggerType : preset.triggerType;
  const rule = ruleFor(p.preset, triggerType);
  if (!rule) return { status: 400, error: 'triggerType must be after_last_inbound or inactive_for' };

  // Check the trigger fields the same way a save would; a placeholder name /
  // text / template stand in for the parts this count doesn't use.
  const probe = validateAutomation({
    preset: p.preset,
    name: 'preview',
    triggerType,
    delayMinutes: p.delayMinutes,
    triggerParams: p.triggerParams,
    messageCategory: p.messageCategory,
    messageText: 'preview',
    templateId: rule.template === 'required' ? 'preview' : null,
    templateVariableMapping: []
  }, {
    templateRow: rule.template === 'required'
      ? { id: 'preview', name: 'preview', status: 'approved', category: rule.templateCategory || (p.messageCategory || 'marketing').toUpperCase(), header_type: 'NONE', body_text: '' }
      : null
  });
  if (probe.error) return { status: 400, error: probe.error };

  const automation = { ...probe.value, business_id: businessId };
  return countDueCustomers(automation, now);
};

module.exports = { list, get, create, update, setActive, remove, listSends, presets, listTemplates, previewAudience };
