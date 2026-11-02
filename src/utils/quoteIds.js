// WhatsApp button ids of a travel quote: "quote:{quoteId}:{action}". They are system taps (like
// "lang_", "optin_", "cat:"): they never answer a booking question and never name a flow edge.
//   confirm  accept the quote (and pay the advance when one is asked)
//   change   start the quote flow again
//   talk     hand over to the team
//   paid     "I've paid" - tells the owner; never marks the booking paid
const PREFIX = 'quote:';
const ACTIONS = ['confirm', 'change', 'talk', 'paid'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quoteTapId = (quoteId, action) => `${PREFIX}${quoteId}:${action}`;

// "quote:start:{entryNodeId}": the "Get a quote" button of the expired-chat reply - starts the quote flow at that entry question.
const START = 'start';
const quoteStartTapId = (entryNodeId) => `${PREFIX}${START}:${entryNodeId}`;

/** @returns {{ entryNodeId: string } | null} */
const parseQuoteStartTapId = (id) => {
  if (typeof id !== 'string' || !id.startsWith(`${PREFIX}${START}:`)) return null;
  const entryNodeId = id.slice(`${PREFIX}${START}:`.length);
  return UUID.test(entryNodeId) ? { entryNodeId: entryNodeId.toLowerCase() } : null;
};

/** @returns {{ quoteId: string, action: string } | null} null for anything that is not a well-formed quote tap */
const parseQuoteTapId = (id) => {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  const [quoteId, action, ...rest] = id.slice(PREFIX.length).split(':');
  if (rest.length > 0 || !UUID.test(quoteId || '') || !ACTIONS.includes(action)) return null;
  return { quoteId: quoteId.toLowerCase(), action };
};

module.exports = { QUOTE_TAP_PREFIX: PREFIX, QUOTE_ACTIONS: ACTIONS, quoteTapId, parseQuoteTapId, quoteStartTapId, parseQuoteStartTapId };
