/**
 * Shared validation for the web-form booking link's field-list shape —
 * businesses.flow_fields (one list per business) and flow_nodes.form_fields
 * (one list per web_form_trigger node, added in
 * 20260915120000_flow_node_form_fields.sql). Both are validated identically;
 * extracted here so business.controller.js (PUT /api/business/flow-fields)
 * and flowGraph.controller.js (PUT /api/flow-graph/reply-nodes/:id) share one
 * copy instead of forking the rules.
 */

const VALID_FLOW_FIELD_TYPES = ['dropdown', 'radio', 'date', 'text', 'textarea', 'toggle', 'icon_select', 'address_autocomplete'];

// Which field types each vehicle-quote role may be attached to — see
// validateFlowFields' doc comment. Keyed by role value.
const ROLE_ALLOWED_TYPES = {
  pickup: ['address_autocomplete'],
  drop: ['address_autocomplete'],
  tripType: ['dropdown', 'radio'],
  numberOfDays: ['text', 'textarea']
};

/**
 * Validates a proposed flow_fields array (the web-form booking link's field
 * config — businesses.flow_fields or a flow_nodes.form_fields row). Returns
 * an error message, or null if valid.
 * - Every field needs a non-empty name and label.
 * - type must be one of VALID_FLOW_FIELD_TYPES.
 * - dropdown/radio need at least 2 options.
 * - icon_select needs source: 'vehicle_catalog' (its real options are this
 *   business's live Vehicle Catalog rows, looked up at render/submit time,
 *   never hand-typed into the stored field definition).
 * - address_autocomplete stores like text/date — no extra config here — but
 *   its SUBMITTED VALUE is structurally different from every other field
 *   type: instead of a plain string, it's a JSON string encoding
 *   { description, lat, lng } (see publicServiceForm.controller.js's
 *   places-autocomplete/place-details endpoints, which the public form
 *   calls to build that JSON before submit, and submitServiceForm, which
 *   parses it back out).
 * - Any field may also carry an optional role, used by the vehicle-quote
 *   flow to find the fields it needs without guessing by name: 'pickup'|
 *   'drop' (address_autocomplete only), 'tripType' (dropdown|radio only —
 *   its options should include booking.service.js's tripTypeMap values,
 *   e.g. 'One Way'/'Round Trip', for the round-trip day-based fare
 *   estimate to kick in; not enforced here), 'numberOfDays' (text|textarea
 *   only). At most one field per role across the whole array.
 * - visibleWhen.field must reference an EARLIER field in the array (by
 *   name) — never itself, never a field defined later — since the form
 *   renders fields top-to-bottom and a later/self reference could never
 *   resolve. If that earlier field is dropdown/radio, visibleWhen.equals
 *   must be one of its options.
 * - names must be unique — not explicitly asked for, but `name` doubles as
 *   both the visibleWhen back-reference key and the submitted-value key
 *   (fieldKey) downstream, so a duplicate would make both ambiguous.
 */
const validateFlowFields = (fields) => {
  if (!Array.isArray(fields)) {
    return 'fields must be an array';
  }

  const seenNames = new Map(); // name -> field, in array order (earlier fields only, built up as we go)
  const seenRoles = new Map(); // 'pickup'|'drop' -> name of the field that already claimed it

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || typeof field !== 'object') {
      return `fields[${i}] must be an object`;
    }

    const { name, type, label, options, visibleWhen } = field;

    if (typeof name !== 'string' || !name.trim()) {
      return `fields[${i}] must have a non-empty name`;
    }
    if (seenNames.has(name)) {
      return `fields[${i}] ("${name}") duplicates an earlier field's name — names must be unique`;
    }
    if (typeof label !== 'string' || !label.trim()) {
      return `fields[${i}] ("${name}") must have a non-empty label`;
    }
    if (!VALID_FLOW_FIELD_TYPES.includes(type)) {
      return `fields[${i}] ("${name}") type must be one of: ${VALID_FLOW_FIELD_TYPES.join(', ')}`;
    }

    if (type === 'dropdown' || type === 'radio') {
      if (!Array.isArray(options) || options.length < 2 ||
          options.some(opt => typeof opt !== 'string' || !opt.trim())) {
        return `fields[${i}] ("${name}") is ${type} and needs at least 2 non-empty options`;
      }
    }

    if (type === 'icon_select' && field.source !== 'vehicle_catalog') {
      return `fields[${i}] ("${name}") is icon_select and needs source: 'vehicle_catalog'`;
    }

    if (field.role !== undefined && field.role !== null) {
      const allowedTypes = ROLE_ALLOWED_TYPES[field.role];
      if (!allowedTypes) {
        return `fields[${i}] ("${name}") role must be one of: ${Object.keys(ROLE_ALLOWED_TYPES).join(', ')}`;
      }
      if (!allowedTypes.includes(type)) {
        return `fields[${i}] ("${name}") has role '${field.role}' but that role is only valid on ${allowedTypes.join('/')} fields`;
      }
      if (seenRoles.has(field.role)) {
        return `fields[${i}] ("${name}") duplicates role '${field.role}', already used by "${seenRoles.get(field.role)}" — at most one field may have each role`;
      }
      seenRoles.set(field.role, name);
    }

    if (visibleWhen !== undefined && visibleWhen !== null) {
      if (typeof visibleWhen !== 'object' || typeof visibleWhen.field !== 'string' || typeof visibleWhen.equals !== 'string') {
        return `fields[${i}] ("${name}") visibleWhen must be { field, equals }`;
      }
      const earlierField = seenNames.get(visibleWhen.field);
      if (!earlierField) {
        return `fields[${i}] ("${name}") visibleWhen.field "${visibleWhen.field}" must reference an earlier field in the array, not itself or a later one`;
      }
      if ((earlierField.type === 'dropdown' || earlierField.type === 'radio') &&
          !earlierField.options.includes(visibleWhen.equals)) {
        return `fields[${i}] ("${name}") visibleWhen.equals "${visibleWhen.equals}" must be one of "${visibleWhen.field}"'s options`;
      }
    }

    seenNames.set(name, field);
  }

  return null;
};

module.exports = { validateFlowFields };
