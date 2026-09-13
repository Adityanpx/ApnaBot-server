const axios = require('axios');
const logger = require('../utils/logger');

const AUTOCOMPLETE_BASE = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS_BASE = 'https://maps.googleapis.com/maps/api/place/details/json';

/**
 * Google Places Autocomplete predictions for a partial address string.
 * @param {string} input
 * @returns {Promise<Array<{placeId: string, description: string}>|null>} null on failure
 */
const getAutocompletePredictions = async (input) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    logger.error('GOOGLE_MAPS_API_KEY is not configured but a places autocomplete lookup was requested');
    return null;
  }

  try {
    const response = await axios.get(AUTOCOMPLETE_BASE, {
      params: { input, key: process.env.GOOGLE_MAPS_API_KEY }
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      logger.error('Google Places Autocomplete returned non-OK status:', response.data.status);
      return null;
    }

    return (response.data.predictions || []).map((p) => ({ placeId: p.place_id, description: p.description }));
  } catch (error) {
    logger.error('Error calling Google Places Autocomplete API:', error.response?.data || error.message);
    return null;
  }
};

/**
 * Google Place Details for a place_id, reshaped to { lat, lng, city, state,
 * formattedAddress }. The API has no direct city/state field — they're
 * derived from address_components entries typed 'locality' and
 * 'administrative_area_level_1' respectively, and can legitimately come
 * back null for a place with no matching component.
 * @param {string} placeId
 * @returns {Promise<{lat: number|null, lng: number|null, city: string|null, state: string|null, formattedAddress: string|null}|null>} null on failure
 */
const getPlaceDetails = async (placeId) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    logger.error('GOOGLE_MAPS_API_KEY is not configured but a place details lookup was requested');
    return null;
  }

  try {
    const response = await axios.get(DETAILS_BASE, {
      params: {
        place_id: placeId,
        key: process.env.GOOGLE_MAPS_API_KEY,
        fields: 'geometry,address_components,formatted_address'
      }
    });

    if (response.data.status !== 'OK' || !response.data.result) {
      logger.error('Google Place Details returned non-OK status:', response.data.status);
      return null;
    }

    const result = response.data.result;
    const components = result.address_components || [];
    const city = components.find((c) => c.types.includes('locality'))?.long_name || null;
    const state = components.find((c) => c.types.includes('administrative_area_level_1'))?.long_name || null;

    return {
      lat: result.geometry?.location?.lat ?? null,
      lng: result.geometry?.location?.lng ?? null,
      city,
      state,
      formattedAddress: result.formatted_address || null
    };
  } catch (error) {
    logger.error('Error calling Google Place Details API:', error.response?.data || error.message);
    return null;
  }
};

module.exports = {
  getAutocompletePredictions,
  getPlaceDetails
};
