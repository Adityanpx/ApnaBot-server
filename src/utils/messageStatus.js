// Delivery status of an outbound message only ever moves forward:
// sent -> delivered -> read. Meta's status webhooks can arrive out of order, and
// a late "delivered" must not turn a message that is already "read" back.

const FORWARD_FROM = {
  // Rows start as 'sent' (the queue worker / insert), so a 'sent' event changes nothing.
  sent: [],
  delivered: ['sent'],
  read: ['sent', 'delivered'],
  // A failure is only meaningful for a message that never got delivered.
  failed: ['sent']
};

/**
 * Statuses a row may currently have for `incoming` to be applied to it.
 * @param {string} incoming - the status Meta reported
 * @returns {string[]|null} the allowed current statuses ([] = nothing to change),
 *   or null for a status the messages table does not store (e.g. 'deleted')
 */
const statusesBefore = (incoming) => (Object.prototype.hasOwnProperty.call(FORWARD_FROM, incoming) ? FORWARD_FROM[incoming] : null);

module.exports = { statusesBefore };
