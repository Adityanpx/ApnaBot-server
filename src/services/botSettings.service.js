// Settings-driven bot builder (business_bot_settings). An owner saves
// structured settings (draft) as often as they like — that never touches
// the live bot. Publish maps the saved settings to a FlowSpec v2 and commits
// it through aiFlow.service.js#executeApply: snapshot of the current flow
// first, then flowGraph.service.js#saveFullGraph (the canvas batch-save
// core), then records what was published.
//
// Presets: only 'coaching' today (coachingBotSettings.js), usable only by a
// business whose business_category is 'coaching'.
const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const { readBusinessGraphRows } = require('./flowSnapshot.service');
const aiFlowService = require('./aiFlow.service');
const { compileFlowSpecV2 } = require('../utils/flowSpecV2');
const { validateCoachingSettings, mapCoachingSettingsToSpec, FIELD_LIBRARY } = require('../utils/coachingBotSettings');
const { listInstitutePresets } = require('../utils/coachingInstitutePresets');
const logger = require('../utils/logger');

const PRESETS = {
  coaching: {
    category: 'coaching',
    validate: validateCoachingSettings,
    mapToSpec: mapCoachingSettingsToSpec,
    fieldLibrary: FIELD_LIBRARY,
    // "What kind of institute are you?" starting points (coachingInstitutePresets.js)
    institutePresets: listInstitutePresets()
  }
};

const loadBusiness = async (businessId) => {
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, display_name, business_category, welcome_message, welcome_message_translations, business_latitude, business_longitude')
    .eq('id', businessId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const OPTIONAL_COURSE_KEYS = ['groupName', 'ageGroup', 'duration', 'fees', 'mode', 'moreDetails', 'batches'];

/**
 * The business's ACTIVE courses (business_courses) in display order, in the
 * shape coachingBotSettings.js#mapCoachingSettingsToSpec expects. Also what
 * a publish records (published_settings.courses) to detect later edits.
 */
const loadActiveCourses = async (businessId) => {
  const { data, error } = await supabase
    .from('business_courses')
    .select('name, description, details, show_demo_button, show_admission_button, group_name, age_group, duration, fees, mode, more_details, batches')
    .eq('business_id', businessId).eq('is_active', true)
    .order('order', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw error;
  // Keys added after the first publishes (group, structured details) only
  // when set: courses published before they existed have no such keys, so a
  // null here would wrongly flag "unpublished changes".
  return (data || []).map(row => {
    const course = toCamelCase(row);
    for (const key of OPTIONAL_COURSE_KEYS) {
      const v = course[key];
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) delete course[key];
    }
    return course;
  });
};

// Key-order-independent JSON for comparing what was published (read back
// from jsonb, which reorders object keys) with the current settings+courses.
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

const loadRow = async (businessId) => {
  const { data, error } = await supabase
    .from('business_bot_settings').select('*').eq('business_id', businessId).maybeSingle();
  if (error) throw error;
  return data;
};

/** The preset this business may use, or a { status, error } refusal. */
const resolvePreset = (presetName, graphBusiness) => {
  const preset = PRESETS[presetName];
  if (!preset) return { status: 400, error: `Unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}` };
  if (graphBusiness.businessCategory !== preset.category) {
    return { status: 409, error: `The "${presetName}" bot settings are only available for ${preset.category} businesses.` };
  }
  return { preset };
};

/**
 * GET: saved settings (or null) plus what the settings screen needs to
 * render the field picker.
 */
const getSettings = async ({ businessId }) => {
  const row = await loadRow(businessId);
  const out = row ? toCamelCase(row) : null;
  return {
    settings: out ? {
      preset: out.preset,
      settings: out.settings,
      publishedAt: out.publishedAt,
      publishedSnapshotId: out.publishedSnapshotId,
      // What's live = published_settings ({ settings, courses } at the last
      // publish); editing either the bot settings or My courses since then
      // counts as unpublished changes.
      hasUnpublishedChanges: stableStringify(row.published_settings) !==
        stableStringify({ settings: row.settings, courses: await loadActiveCourses(businessId) })
    } : null,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([name, p]) => [name, {
      category: p.category, fieldLibrary: p.fieldLibrary, institutePresets: p.institutePresets
    }]))
  };
};

/**
 * PUT: save a draft. Validated in draft mode (incomplete setups allowed);
 * never touches flow_nodes/flow_edges or the published_* columns.
 */
const saveDraft = async ({ businessId, graphBusiness, preset: presetName, settings }) => {
  const resolved = resolvePreset(presetName, graphBusiness);
  if (resolved.error) return resolved;
  const error = resolved.preset.validate(settings, { forPublish: false });
  if (error) return { status: 400, error };

  const { data, error: upsertErr } = await supabase
    .from('business_bot_settings')
    .upsert({ business_id: businessId, preset: presetName, settings }, { onConflict: 'business_id' })
    .select('*').single();
  if (upsertErr) throw upsertErr;
  return { saved: toCamelCase(data) };
};

/**
 * Settings -> spec -> compiled graph, plus warnings. Read-only. Uses the
 * given settings if provided (preview unsaved edits), else the saved draft.
 */
const buildFromSettings = async ({ businessId, graphBusiness, presetName, settings }) => {
  const resolved = resolvePreset(presetName, graphBusiness);
  if (resolved.error) return resolved;
  const business = await loadBusiness(businessId);
  if (!business) return { status: 404, error: 'Business not found' };

  const courses = await loadActiveCourses(businessId);
  const { spec, error } = resolved.preset.mapToSpec(settings, { businessName: business.display_name || business.name, courses });
  if (error) return { status: 400, error };

  if (spec.location && (business.business_latitude == null || business.business_longitude == null)) {
    return { status: 400, error: 'Location is switched on, but the shop location (latitude/longitude) is not set in Settings. Set it, or switch Location off.' };
  }

  const { warnings, ...graph } = compileFlowSpecV2(spec);
  return { business, spec, graph, warnings, courses };
};

/** POST /compile: what Publish would produce. No writes. */
const compile = async ({ businessId, graphBusiness, preset, settings }) => {
  let presetName = preset;
  let source = settings;
  if (source === undefined || source === null) {
    const row = await loadRow(businessId);
    if (!row) return { status: 404, error: 'No bot settings saved yet.' };
    presetName = row.preset;
    source = row.settings;
  }
  const built = await buildFromSettings({ businessId, graphBusiness, presetName, settings: source });
  if (built.error) return built;
  // businessName: what {{businessName}} becomes when sent (messageTemplating.js
  // — display name, else name), so the dashboard preview can show it.
  return {
    spec: built.spec, graph: built.graph, warnings: built.warnings,
    businessName: built.business.display_name || built.business.name
  };
};

/**
 * Everything Publish decides before writing. Read-only. Always publishes
 * the SAVED settings (never a request body), so what goes live is exactly
 * what the owner saved.
 */
const preparePublish = async ({ businessId, graphBusiness }) => {
  const row = await loadRow(businessId);
  if (!row) return { status: 404, error: 'No bot settings saved yet.' };

  const built = await buildFromSettings({ businessId, graphBusiness, presetName: row.preset, settings: row.settings });
  if (built.error) return built;

  const currentRows = await readBusinessGraphRows(businessId);
  const computed = currentRows.nodes.find(n => n.is_computed);
  if (computed) {
    return {
      status: 409,
      error: `This business's flow contains a computed node (fieldKey "${computed.field_key}") that bot settings can't replace. Edit the flow in the canvas editor instead.`
    };
  }

  const warnings = [...built.warnings];
  if (aiFlowService.hasWelcomeMessage(built.business)) {
    warnings.push('This business has a welcome message set. Greeting words (hi, hello, menu, …) will keep sending that message instead of the menu — clear the welcome message in Settings if you want the menu to show.');
  }
  if (currentRows.nodes.length > 0) {
    const sessions = await aiFlowService.countBookingSessions(businessId);
    if (sessions === null) {
      warnings.push('Any customer who is in the middle of a booking right now will have that booking ended, and buttons already sent in old messages will stop working.');
    } else if (sessions > 0) {
      warnings.push(`${sessions} customer(s) are in the middle of a booking right now — those bookings will end, and buttons already sent in old messages will stop working.`);
    }
    warnings.push('Publishing replaces the current flow (including any changes made in the canvas editor). The current flow is saved first and can be restored from Versions.');
  }

  return { row, courses: built.courses, spec: built.spec, compiled: built.graph, currentRows, warnings };
};

/**
 * The write half of Publish: aiFlow.service.js#executeApply (snapshot ->
 * saveFullGraph -> snapshot housekeeping), then record what was published.
 * If recording fails after a successful apply, the flow IS live — that's
 * logged and returned as a warning, not an error.
 */
const executePublish = async ({ businessId, graphBusiness, prepared }) => {
  const result = await aiFlowService.executeApply({
    businessId,
    graphBusiness,
    prepared: { compiled: prepared.compiled, currentRows: prepared.currentRows, warnings: prepared.warnings },
    snapshotLabel: 'Before bot settings publish'
  });
  if (result.error) return result;

  const warnings = [...result.warnings];
  const { error: recordErr } = await supabase
    .from('business_bot_settings')
    .update({
      published_settings: { settings: prepared.row.settings, courses: prepared.courses },
      published_at: new Date().toISOString(),
      published_snapshot_id: result.snapshot ? result.snapshot.id : null
    })
    .eq('business_id', businessId);
  if (recordErr) {
    logger.error('botSettings: flow published but publish record not saved', { businessId, message: recordErr.message });
    warnings.push('The bot is live, but its "published" status could not be saved — the dashboard may still show unpublished changes.');
  }
  return { snapshot: result.snapshot, warnings };
};

module.exports = {
  PRESETS,
  getSettings,
  saveDraft,
  buildFromSettings,
  compile,
  preparePublish,
  executePublish
};
