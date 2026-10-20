// Thin client for Azure Translator (F0 free tier). No DB, no caps - translation.service.js adds
// those. English in, one target language per call, HTML mode so translateProtect.js's tags
// survive. Not configured (AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION missing) is a clear
// 503, never a crash.
const axios = require('axios');
const logger = require('../utils/logger');
const { LANGUAGE_CATALOG } = require('../utils/languageCatalog');

const ENDPOINT = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
const REQUEST_TIMEOUT_MS = 10000;
// Azure allows 1000 texts / 50,000 characters per request; stay well under both.
const MAX_TEXTS_PER_REQUEST = 50;
const MAX_CHARS_PER_REQUEST = 20000;

class TranslateError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'TranslateError';
    this.statusCode = status;
    this.code = code;
  }
}

const NOT_CONFIGURED_MESSAGE = 'Auto-translate is not configured on this server. You can still type translations manually.';

const isConfigured = () => !!(process.env.AZURE_TRANSLATOR_KEY && process.env.AZURE_TRANSLATOR_REGION);

const assertConfigured = () => {
  if (!isConfigured()) throw new TranslateError(503, NOT_CONFIGURED_MESSAGE, 'TRANSLATE_NOT_CONFIGURED');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const post = async (htmlTexts, azureTo) => {
  const request = () => axios.post(
    `${ENDPOINT}/translate`,
    htmlTexts.map((Text) => ({ Text })),
    {
      params: { 'api-version': '3.0', from: 'en', to: azureTo, textType: 'html' },
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY,
        'Ocp-Apim-Subscription-Region': process.env.AZURE_TRANSLATOR_REGION,
        'Content-Type': 'application/json'
      },
      timeout: REQUEST_TIMEOUT_MS
    }
  );
  try {
    return await request();
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 429 || (status >= 500 && status < 600) || !status) {
      await sleep(500);
      return request();
    }
    throw error;
  }
};

/**
 * Translates already-protected HTML fragments (translateProtect.protect) from English into one
 * language. Splits into several requests when large. Resolves to an array aligned with `htmlTexts`.
 * @param {string[]} htmlTexts
 * @param {string} lang catalog code
 * @returns {Promise<string[]>}
 * @throws {TranslateError} 503 not configured / provider unavailable
 */
const translateHtml = async (htmlTexts, lang) => {
  assertConfigured();
  const azureTo = LANGUAGE_CATALOG[lang] && LANGUAGE_CATALOG[lang].azure;
  if (!azureTo || lang === 'en') throw new TranslateError(400, `Cannot translate into "${lang}".`, 'TRANSLATE_BAD_LANGUAGE');

  const batches = [];
  let current = [];
  let chars = 0;
  htmlTexts.forEach((text, index) => {
    if (current.length > 0 && (current.length >= MAX_TEXTS_PER_REQUEST || chars + text.length > MAX_CHARS_PER_REQUEST)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push({ text, index });
    chars += text.length;
  });
  if (current.length > 0) batches.push(current);

  const out = new Array(htmlTexts.length).fill(null);
  for (const batch of batches) {
    let response;
    try {
      response = await post(batch.map((b) => b.text), azureTo);
    } catch (error) {
      logger.error('Azure Translator request failed', {
        status: error.response && error.response.status,
        azure: error.response && error.response.data && error.response.data.error,
        message: error.message
      });
      throw new TranslateError(503, 'Auto-translate is temporarily unavailable. You can still type translations manually.', 'TRANSLATE_UNAVAILABLE');
    }
    const results = Array.isArray(response.data) ? response.data : [];
    batch.forEach((b, i) => {
      const translated = results[i] && results[i].translations && results[i].translations[0] && results[i].translations[0].text;
      out[b.index] = typeof translated === 'string' ? translated : null;
    });
  }
  return out;
};

module.exports = { TranslateError, NOT_CONFIGURED_MESSAGE, isConfigured, assertConfigured, translateHtml };
