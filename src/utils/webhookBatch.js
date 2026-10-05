// Meta can batch several messages into one webhook change. The handler works
// one message at a time (value.messages[0], value.contacts[0]), so a change
// with more than one message is split into one change per message.

/**
 * @param {Object} change - one entry of entry[].changes[]
 * @returns {Object[]} the change itself, or one copy per message with `messages`
 *   holding just that message and `contacts` narrowed to its sender
 */
const splitMessages = (change) => {
  const messages = change && change.value && change.value.messages;
  if (!Array.isArray(messages) || messages.length <= 1) return [change];

  const contacts = Array.isArray(change.value.contacts) ? change.value.contacts : null;
  return messages.map((message) => {
    const own = contacts ? contacts.filter((c) => c && c.wa_id === message.from) : null;
    return {
      ...change,
      value: {
        ...change.value,
        messages: [message],
        // A sender with no matching contact keeps the full list, as a lone message would.
        ...(contacts ? { contacts: own.length > 0 ? own : contacts } : {})
      }
    };
  });
};

module.exports = { splitMessages };
