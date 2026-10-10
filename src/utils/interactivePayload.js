// What the customer saw for an interactive WhatsApp message, as the object kept in
// messages.interactive_payload (migration 20261014140000) so the chat can draw the
// list / buttons / link instead of only the body text:
//   { kind: 'list' | 'buttons' | 'cta_url' | 'location_request', body,
//     buttonText?, options?: [{ id, title, description? }], label?, imageUrl? }
//   A cta_url payload keeps its label but NOT the link: the booking-form link carries a
//   single-use token, which has no business in the chat history.
//
// It is built from the same job data the outbound queue receives and follows the
// worker's dispatch order (queues/whatsapp.worker.js) and the senders' limits
// (services/whatsapp.service.js), so the stored text is what Meta was given. Nothing
// here sends anything; the senders do not use it. interactivePayload.test.js drives
// the real worker and senders and fails if the two ever drift apart.
//
// Only a message that has something to show gets a payload; plain text, an image, a
// location pin and a template get null (the row stays plain text). No requires
// outside utils, so it loads in tests without any config.
const { LIMITS, truncate } = require('./textLimits');

// Same default as localization.js (DEFAULT_LIST_BUTTON_LABEL), not imported: that
// module pulls in more than this needs.
const DEFAULT_LIST_BUTTON_LABEL = 'Choose';

const hasItems = (value) => Array.isArray(value) && value.length > 0;

const listPayload = (body, buttonText, options) => ({
  kind: 'list',
  body,
  buttonText: truncate(buttonText, LIMITS.LIST_BUTTON_LABEL) || DEFAULT_LIST_BUTTON_LABEL,
  options
});

const buttonsPayload = (body, options, imageUrl) => ({
  kind: 'buttons',
  body,
  options: options.slice(0, LIMITS.MAX_BUTTONS),
  ...(imageUrl ? { imageUrl } : {})
});

/**
 * @param {Object} job - the outbound queue job data (message, imageUrl, buttons,
 *   listOptions, interactiveButtons, interactiveList, listButtonLabel, step,
 *   ctaButton, locationRequest, location)
 * @returns {Object|null} the payload, or null when there is nothing interactive to show
 */
const buildInteractivePayload = (job) => {
  const {
    message, imageUrl = null, buttons, listOptions, interactiveButtons, interactiveList,
    listButtonLabel = DEFAULT_LIST_BUTTON_LABEL, step = null, ctaButton = null,
    locationRequest = false, location = null
  } = job || {};

  if (location) return null;
  if (locationRequest) return { kind: 'location_request', body: truncate(message, LIMITS.TEXT_BODY) };

  const body = truncate(message, LIMITS.INTERACTIVE_BODY);

  if (ctaButton) {
    return { kind: 'cta_url', body, label: truncate(ctaButton.buttonText, LIMITS.BUTTON_TITLE) };
  }
  if (hasItems(interactiveList)) {
    // A booking-field list: ids are "{step}:{index}". The sender sets no header image on lists.
    return listPayload(body, listButtonLabel, interactiveList.map((opt, index) => ({
      id: `${step}:${index}`,
      title: truncate(opt, LIMITS.LIST_ROW_TITLE)
    })));
  }
  if (hasItems(interactiveButtons)) {
    // Ids are built from the whole list before the cap of 3, as the worker does.
    return buttonsPayload(body, interactiveButtons.map((opt, index) => ({
      id: `${step}:${index}`,
      title: truncate(opt, LIMITS.BUTTON_TITLE)
    })), imageUrl);
  }
  if (hasItems(buttons)) {
    return buttonsPayload(body, buttons.map((b) => ({
      id: b.nextKeyword,
      title: truncate(b.title, LIMITS.BUTTON_TITLE)
    })), imageUrl);
  }
  if (hasItems(listOptions)) {
    return listPayload(body, listButtonLabel, listOptions.map((opt) => ({
      id: opt.nextKeyword,
      title: truncate(opt.label, LIMITS.LIST_ROW_TITLE),
      ...(opt.description ? { description: truncate(opt.description, LIMITS.LIST_ROW_DESCRIPTION) } : {})
    })));
  }
  return null;
};

module.exports = { buildInteractivePayload };
