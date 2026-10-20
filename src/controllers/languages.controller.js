const { successResponse, errorResponse } = require('../utils/response');
const {
  catalogList, STATES, STATE_LANGUAGES, DEFAULT_SUGGESTED_LANGUAGES, MAX_ENABLED_LANGUAGES,
  canonicalState, suggestedLanguagesForState
} = require('../utils/languageCatalog');

/**
 * GET /api/public/languages (no auth)
 * -> { languages: [{ code, name, englishName }], maxEnabled: 3, defaultSuggested: ['en','hi'],
 *      states: [{ name, suggested: ['en', ...] }] }
 * Static catalog data only - nothing from app_config or the database.
 */
const getLanguages = (req, res) => successResponse(res, 200, {
  languages: catalogList(),
  maxEnabled: MAX_ENABLED_LANGUAGES,
  defaultSuggested: DEFAULT_SUGGESTED_LANGUAGES,
  states: STATES.map((name) => ({ name, suggested: STATE_LANGUAGES[name] }))
});

/**
 * GET /api/public/languages/suggested?state=Gujarat (no auth)
 * -> { state: 'Gujarat'|null, suggested: ['en','hi','gu'] }  (unknown / missing state -> state null, ['en','hi'])
 */
const getSuggestedLanguages = (req, res) => {
  const { state } = req.query;
  if (state !== undefined && typeof state !== 'string') return errorResponse(res, 400, 'state must be a single value.');
  return successResponse(res, 200, { state: canonicalState(state), suggested: suggestedLanguagesForState(state) });
};

module.exports = { getLanguages, getSuggestedLanguages };
