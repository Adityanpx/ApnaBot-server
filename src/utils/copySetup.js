// Pure helpers for POST /api/admin/businesses/:id/copy-setup (SuperAdmin "Copy setup"):
// request parsing, source/target compatibility, the per-node transform applied to copied
// flow_nodes rows, and the dry-run warning builder. No I/O — services/copySetup.service.js
// does the reads/writes. Tests: copySetup.test.js.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LISTED_LABELS = 10;
// Below this a business name ("Ab") would match inside ordinary words.
const MIN_NAME_MATCH_LENGTH = 3;

const fail = (status, message) => ({ error: { status, message } });
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/**
 * Validates the request body. Returns { value: { source: {type, id}, include: {flow,
 * serviceForm}, dryRun } } or { error: { status, message } }. dryRun defaults to TRUE when
 * omitted (CLAUDE.md rule 5 — nothing writes unless the caller says dryRun:false).
 */
const parseCopySetupRequest = (body) => {
  const b = body && typeof body === 'object' ? body : {};
  const { source, include, dryRun } = b;

  if (!source || typeof source !== 'object') return fail(400, 'source is required');
  if (source.type !== 'business' && source.type !== 'template') {
    return fail(400, 'source.type must be "business" or "template"');
  }
  if (!isUuid(source.id)) {
    return fail(400, 'source.id must be a valid id');
  }
  if (!include || typeof include !== 'object') return fail(400, 'include is required');
  for (const key of ['flow', 'serviceForm']) {
    if (include[key] !== undefined && typeof include[key] !== 'boolean') {
      return fail(400, `include.${key} must be true or false`);
    }
  }
  if (!include.flow && !include.serviceForm) {
    return fail(400, 'include.flow and include.serviceForm cannot both be false — nothing to copy');
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    return fail(400, 'dryRun must be true or false');
  }

  return {
    value: {
      source: { type: source.type, id: source.id },
      include: { flow: include.flow === true, serviceForm: include.serviceForm === true },
      dryRun: dryRun !== false
    }
  };
};

/**
 * Checks a loaded source against the target. sourceRow is the businesses row (type
 * 'business') or the flow_snapshots row (type 'template'), or null when not found.
 * Returns null when OK, else { status, message }.
 */
const checkCopyCompatibility = ({ sourceType, sourceRow, target }) => {
  if (sourceType === 'business') {
    if (!sourceRow) return { status: 404, message: 'Source business not found' };
    if (sourceRow.id === target.id) {
      return { status: 400, message: 'Source and target are the same business' };
    }
    if (sourceRow.business_category !== target.business_category) {
      return {
        status: 400,
        message: `Category mismatch: source is "${sourceRow.business_category}", target is "${target.business_category}". Copying across categories is not supported.`
      };
    }
    return null;
  }

  if (!sourceRow || !sourceRow.is_category_template) return { status: 404, message: 'Source template not found' };
  if (!sourceRow.is_active) return { status: 400, message: 'Source template is not active' };
  if (sourceRow.category !== target.business_category) {
    return {
      status: 400,
      message: `Category mismatch: template is for "${sourceRow.category}", target is "${target.business_category}". Copying across categories is not supported.`
    };
  }
  return null;
};

/** Edges whose from/to node is not among `nodes` — writeBusinessGraphRows would insert a null FK. */
const findDanglingEdges = (nodes, edges) => {
  const ids = new Set((nodes || []).map(n => n.id));
  return (edges || []).filter(e => !ids.has(e.from_node_id) || !ids.has(e.to_node_id));
};

/**
 * Per-node transform for a graph copied into ANOTHER business. Pure — returns new rows.
 *   - latitude/longitude/location_name/address -> null (a copied pin would send the source
 *     business's location; null falls back to the target's own business pin)
 *   - trigger_count -> 0 (live per-node analytics counter of the source)
 *   - media_id -> null always (FK into the SOURCE business's business_media library)
 *   - image_url -> null when isStorageUrl(url) (one of our R2 files: owned by the source
 *     business's library, so a copy would die with it); other URLs are kept
 *   - image_removed_at -> null (the source's "removed by storage cleanup" marker)
 *   - gallery_media_ids -> [] and video_media_id -> null (same reason as media_id: library ids of the SOURCE
 *     business; photos beyond #1 and the video are plan-limited, the target re-adds its own)
 * form_fields (per-node service form) and everything else is left as-is. Node ids are NOT
 * touched here — writeBusinessGraphRows({ reuseIds:false }) mints fresh ones.
 *
 * Returns { nodes, imagesDropped, locationsCleared } (counts are nodes).
 */
const transformNodesForCopy = (nodes, { isStorageUrl }) => {
  let imagesDropped = 0;
  let locationsCleared = 0;

  const out = (nodes || []).map(n => {
    const dropUrl = !!n.image_url && isStorageUrl(n.image_url);
    const hadGallery = Array.isArray(n.gallery_media_ids) && n.gallery_media_ids.length > 0;
    if (n.media_id != null || dropUrl || hadGallery || n.video_media_id != null) imagesDropped += 1;

    const hadLocation = [n.latitude, n.longitude, n.location_name, n.address].some(v => v !== null && v !== undefined);
    if (hadLocation) locationsCleared += 1;

    return {
      ...n,
      latitude: null,
      longitude: null,
      location_name: null,
      address: null,
      trigger_count: 0,
      media_id: null,
      gallery_media_ids: [],
      video_media_id: null,
      image_url: dropUrl ? null : (n.image_url ?? null),
      image_removed_at: null
    };
  });

  return { nodes: out, imagesDropped, locationsCleared };
};

/**
 * Nodes whose label or any label_translations value contains one of `names`
 * (case-insensitive). Returns [{ nodeId, label }] with label shortened for display.
 */
const findHardcodedNameNodes = (nodes, names) => {
  const needles = [...new Set((names || [])
    .map(s => (typeof s === 'string' ? s.trim().toLowerCase() : ''))
    .filter(s => s.length >= MIN_NAME_MATCH_LENGTH))];
  if (needles.length === 0) return [];

  const hit = [];
  for (const n of nodes || []) {
    const texts = [n.label];
    if (n.label_translations && typeof n.label_translations === 'object') {
      texts.push(...Object.values(n.label_translations));
    }
    const haystack = texts.filter(t => typeof t === 'string').join('\n').toLowerCase();
    if (needles.some(needle => haystack.includes(needle))) {
      const shown = String(n.label || n.keyword || n.id).replace(/\s+/g, ' ').trim();
      hit.push({ nodeId: n.id, label: shown.length > 40 ? `${shown.slice(0, 40)}…` : shown });
    }
  }
  return hit;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What a business-source copy does NOT bring along. key = SourceCounts key.
const NOT_COPIED = [
  ['vehicles', (n) => `Source has ${plural(n, 'vehicle', 'vehicles')} — vehicle carousels in the copied flow will be empty until the target adds vehicles.`],
  ['routeFares', (n) => `Source has ${plural(n, 'route fare', 'route fares')} — fares are not copied; the target must add its own.`],
  ['rentalPackages', (n) => `Source has ${plural(n, 'rental package', 'rental packages')} — rental package steps in the copied flow will be empty until the target adds packages.`],
  ['courses', (n) => `Source has ${plural(n, 'course', 'courses')} — course lists in the copied flow/form will be empty until the target adds courses.`],
  ['botSettings', () => 'Source has Bot Builder settings — not copied. Publishing Bot Builder in the target regenerates its flow and overwrites the copied one.'],
  ['travelSettings', () => 'Source has travel settings — not copied; the target keeps its own.']
];

/**
 * Builds the dry-run / apply warnings.
 *   include           { flow, serviceForm } as requested
 *   sourceType        'business' | 'template'
 *   sourceNodes       the UNtransformed source nodes (for the hard-coded-name scan)
 *   sourceNames       [source businesses.name, display_name] (business source only)
 *   target            { currentNodeCount, hasFlowFields, flowFieldsCount }
 *   sourceFormFields  source flow_fields count (business source only)
 *   stats             { imagesDropped, locationsCleared } from transformNodesForCopy
 *   sourceCounts      { vehicles, routeFares, rentalPackages, courses, botSettings, travelSettings }
 *   serviceFormSkipped  true when serviceForm was requested with a template source
 */
const buildCopyWarnings = ({
  include, sourceType, sourceNodes, sourceNames, target, sourceFormFields = 0,
  stats = { imagesDropped: 0, locationsCleared: 0 }, sourceCounts = {}, serviceFormSkipped = false
}) => {
  const warnings = [];

  if (serviceFormSkipped) {
    warnings.push('Service form was not copied: templates hold no service form fields.');
  }

  if (include.flow) {
    if (target.currentNodeCount > 0) {
      warnings.push(`Target already has ${target.currentNodeCount} nodes — they will be replaced (a restore point is saved first).`);
    }
    if (stats.imagesDropped > 0) {
      warnings.push(`${stats.imagesDropped} ${stats.imagesDropped === 1 ? 'image' : 'images'} will not be copied — re-upload them in the target business.`);
    }
    if (stats.locationsCleared > 0) {
      warnings.push(`${stats.locationsCleared} location ${stats.locationsCleared === 1 ? 'pin' : 'pins'} cleared — target will use its own business address.`);
    }
    if (sourceType === 'business') {
      const named = findHardcodedNameNodes(sourceNodes, sourceNames);
      if (named.length > 0) {
        const listed = named.slice(0, MAX_LISTED_LABELS).map(x => `"${x.label}"`).join(', ');
        const more = named.length > MAX_LISTED_LABELS ? ` and ${named.length - MAX_LISTED_LABELS} more` : '';
        warnings.push(`Source business name is hard-coded in ${plural(named.length, 'node label', 'node labels')} (not replaced — edit them in the target): ${listed}${more}.`);
      }
    }
  }

  if (include.serviceForm && !serviceFormSkipped) {
    // Unlike the flow, the service form has no restore point.
    if (target.hasFlowFields) {
      warnings.push(`Target's existing service form (${plural(target.flowFieldsCount, 'field', 'fields')}) will be replaced — no restore point is saved for it.`);
    }
    if (sourceFormFields === 0) {
      warnings.push('Source has no service form fields — the target\'s service form will be emptied.');
    }
  }

  if (sourceType === 'business') {
    for (const [key, message] of NOT_COPIED) {
      const count = sourceCounts[key] || 0;
      if (count > 0) warnings.push(message(count));
    }
  }

  return warnings;
};

module.exports = {
  isUuid,
  parseCopySetupRequest,
  checkCopyCompatibility,
  findDanglingEdges,
  transformNodesForCopy,
  findHardcodedNameNodes,
  buildCopyWarnings
};
