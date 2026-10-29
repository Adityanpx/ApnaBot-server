// Non-blocking warnings about a saved flow, returned by GET / PUT /api/flow-graph/full as `warnings`
// (the save itself is never refused for them). Pure: no I/O.
//
// Today: a 'file' question (answered with a photo / PDF / document) the web booking form will not ask.
// The web form takes its fields from the form node's own form_fields (it has no file upload), never
// from question nodes, so a file question is only ever asked in a WhatsApp chat booking. It is flagged
// when a web_form_trigger reply leads to it, or when the business has a web form and no
// booking_trigger reply leads to it (so the question could not be asked in chat either).

const reachableFrom = (startIds, edges) => {
  const next = new Map();
  for (const e of edges) {
    if (!next.has(e.from_node_id)) next.set(e.from_node_id, []);
    next.get(e.from_node_id).push(e.to_node_id);
  }
  const seen = new Set(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    for (const to of next.get(queue.shift()) || []) {
      if (to && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  return seen;
};

/**
 * @param {{replyNodes: object[], questionNodes: object[], edges: object[]}} graph - snake_case flow_nodes / flow_edges rows
 * @returns {{code: string, nodeId: string, fieldKey: string, message: string}[]}
 */
const flowWarnings = ({ replyNodes, questionNodes, edges }) => {
  const fileNodes = questionNodes.filter(n => n.content_type === 'file');
  if (fileNodes.length === 0) return [];
  const webFormIds = replyNodes.filter(n => n.reply_kind === 'web_form_trigger').map(n => n.id);
  if (webFormIds.length === 0) return [];
  const fromWebForm = reachableFrom(webFormIds, edges);
  const fromBooking = reachableFrom(replyNodes.filter(n => n.reply_kind === 'booking_trigger').map(n => n.id), edges);
  return fileNodes
    .filter(n => fromWebForm.has(n.id) || !fromBooking.has(n.id))
    .map(n => ({
      code: 'file_question_web_form',
      nodeId: n.id,
      fieldKey: n.field_key,
      message: `The file question "${n.field_key}" is not asked by the web booking form (web forms have no file upload). It is only asked in WhatsApp chat bookings.`
    }));
};

module.exports = { flowWarnings };
