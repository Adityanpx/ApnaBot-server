const axios = require('axios');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const META_API_BASE = 'https://graph.facebook.com/v18.0';

/**
 * Send a text message via WhatsApp
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} message - Message text
 * @returns {Promise<Object>}
 */
const sendTextMessage = async (phoneNumberId, encryptedAccessToken, to, message) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);

    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: message, preview_url: false }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error sending text message:', {
      phoneNumberId,
      to,
      error: error.response?.data || error.message
    });
    throw error;
  }
};

/**
 * Send an image message via WhatsApp (image on top, reply text as caption)
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} imageUrl - Publicly reachable image URL
 * @param {string} caption - Caption text
 * @returns {Promise<Object>}
 */
const sendImageMessage = async (phoneNumberId, encryptedAccessToken, to, imageUrl, caption) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: { link: imageUrl, caption: caption || undefined }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending image message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a location message via WhatsApp (the business's own saved coordinates
 * as a map pin, e.g. a reply/question node with contentType 'location').
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {number} latitude
 * @param {number} longitude
 * @param {string} [name] - Location name shown under the pin
 * @param {string} [address] - Location address shown under the pin
 * @returns {Promise<Object>}
 */
const sendLocationMessage = async (phoneNumberId, encryptedAccessToken, to, latitude, longitude, name, address) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'location',
        location: { latitude, longitude, name, address }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending location message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send an interactive reply-buttons message (optional image header + body + up to 3 buttons).
 * Each button's id is its nextKeyword (chatbot.service.js's getOutgoingEdges
 * sets this to the edge's own id), which the webhook resolves back to
 * whatever the edge targets — another reply node or a question node —
 * when tapped.
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {Array} buttons - [{ title, nextKeyword }]
 * @param {string} [imageUrl] - Optional header image URL
 * @returns {Promise<Object>}
 */
const sendInteractiveButtons = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttons, imageUrl) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const interactive = {
      type: 'button',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.nextKeyword, title: (b.title || '').slice(0, 20) }
        }))
      }
    };
    if (imageUrl) {
      interactive.header = { type: 'image', image: { link: imageUrl } };
    }
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending interactive buttons:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send an interactive list message (single section, tappable rows).
 * Each option becomes a row whose id is "{step}:{index}" — the booking-
 * session step this list was generated for, plus the option's index — so
 * a stale tap from an earlier, already-answered question can be detected
 * on the inbound side instead of being silently misresolved against
 * whatever field is currently active.
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {string} buttonLabel - Text on the list-opening button
 * @param {Array<string>} options - Option labels, one per row
 * @param {number} step - The booking session step these options belong to
 * @returns {Promise<Object>}
 */
const sendListMessage = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttonLabel, options, step) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const interactive = {
      type: 'list',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        button: (buttonLabel || '').slice(0, 20),
        sections: [
          {
            rows: options.map((opt, index) => ({
              id: `${step}:${index}`,
              title: (opt || '').slice(0, 24)
            }))
          }
        ]
      }
    };
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending list message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a WhatsApp list message where each row chains to a specific rule/edge.
 * Unlike sendListMessage (index-based, used by the booking flow's choice questions),
 * each row's id is the edge's nextKeyword (= edge.id, see getOutgoingEdges).
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {string} buttonLabel - Text on the list-opening button
 * @param {Array<{label: string, description?: string, nextKeyword: string}>} options - Rule list options
 * @returns {Promise<Object>}
 */
const sendRuleListMessage = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttonLabel, options) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const interactive = {
      type: 'list',
      body: { text: (bodyText || '').slice(0, 1024) },
      action: {
        button: (buttonLabel || 'Choose').slice(0, 20),
        sections: [
          {
            rows: options.map((opt) => ({
              id: opt.nextKeyword,
              title: (opt.label || '').slice(0, 24),
              ...(opt.description ? { description: opt.description.slice(0, 72) } : {})
            }))
          }
        ]
      }
    };
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive', interactive },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending rule list message:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a native WhatsApp CTA-URL interactive message (a single button that
 * opens `url` directly in the device browser when tapped — no separate
 * text message with a tappable link needed).
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} bodyText - Message body text
 * @param {string} buttonText - Text on the CTA button
 * @param {string} url - URL opened when the button is tapped
 * @returns {Promise<Object>}
 */
const sendCtaUrlButton = async (phoneNumberId, encryptedAccessToken, to, bodyText, buttonText, url) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);
    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: (bodyText || '').slice(0, 1024) },
          action: {
            name: 'cta_url',
            parameters: { display_text: (buttonText || '').slice(0, 20), url }
          }
        }
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (error) {
    logger.error('Error sending CTA URL button:', { phoneNumberId, to, error: error.response?.data || error.message });
    throw error;
  }
};

/**
 * Send a template message via WhatsApp
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} to - Recipient phone number
 * @param {string} templateName - Template name
 * @param {string} languageCode - Language code (default: 'en')
 * @param {Array} components - Template components
 * @returns {Promise<Object>}
 */
const sendTemplateMessage = async (
  phoneNumberId,
  encryptedAccessToken,
  to,
  templateName,
  languageCode = 'en',
  components = []
) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);

    const response = await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: components
        }
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    logger.error('Error sending template message:', {
      phoneNumberId,
      to,
      templateName,
      error: error.response?.data || error.message
    });
    throw error;
  }
};

/**
 * Mark a message as read
 * @param {string} phoneNumberId - The WhatsApp phone number ID
 * @param {string} encryptedAccessToken - Encrypted Meta access token
 * @param {string} metaMessageId - Meta message ID to mark as read
 */
const markMessageAsRead = async (phoneNumberId, encryptedAccessToken, metaMessageId) => {
  try {
    const accessToken = decrypt(encryptedAccessToken);

    await axios.post(
      `${META_API_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: metaMessageId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    // Do not throw - just log warning
    logger.warn('Failed to mark message as read:', {
      phoneNumberId,
      metaMessageId,
      error: error.response?.data || error.message
    });
  }
};

module.exports = {
  sendTextMessage,
  sendImageMessage,
  sendLocationMessage,
  sendInteractiveButtons,
  sendListMessage,
  sendRuleListMessage,
  sendCtaUrlButton,
  sendTemplateMessage,
  markMessageAsRead,
  META_API_BASE
};
