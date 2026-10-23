// A message's place in the chat: WhatsApp's send time (messages.wa_timestamp), else when we stored it
// (created_at). The database holds the same value as the generated column messages.message_time.

/** @param {Object} m - a message row, snake_case or camelCase */
const messageTimeOf = (m) => {
  if (!m) return null;
  return m.message_time ?? m.messageTime ?? m.wa_timestamp ?? m.waTimestamp ?? m.created_at ?? m.createdAt ?? null;
};

/** The message with `messageTime` and `waTimestamp` set (camelCase keys, for the socket payload). */
const withMessageTime = (message) => {
  if (!message || typeof message !== 'object') return message;
  return {
    ...message,
    waTimestamp: message.waTimestamp ?? message.wa_timestamp ?? null,
    messageTime: messageTimeOf(message)
  };
};

/** The chat-history cursor for the page ending at this (oldest) message: `<messageTime>|<id>`. */
const cursorOf = (row) => `${messageTimeOf(row)}|${row.id}`;

/**
 * Parse ?before=. Either `<time>` (plain) or `<time>|<id>`. The time is kept as given, not re-rendered
 * through Date: the stored value can have microseconds, and the tie-break compares for equality.
 * A '+' in an offset that a client sent unencoded arrives as a space; it is put back.
 * @returns {{time:string, id:string|null}|null} null when the time is not a date
 */
const parseCursor = (raw) => {
  const text = String(raw);
  const bar = text.indexOf('|');
  const time = (bar === -1 ? text : text.slice(0, bar)).trim().replace(/ (\d\d:\d\d)$/, '+$1');
  const id = bar === -1 ? '' : text.slice(bar + 1).trim();
  if (Number.isNaN(Date.parse(time))) return null;
  return { time, id: id || null };
};

module.exports = { messageTimeOf, withMessageTime, cursorOf, parseCursor };
