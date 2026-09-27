-- messages.type only allowed ('text','image','document','audio','interactive')
-- since init_schema, but webhook.controller.js saves Meta's message.type
-- verbatim for every inbound message. A customer sharing a location (the
-- answer to a 'location_request' booking field), a sticker, video, contact
-- card or reaction failed the insert with 23514, so the whole inbound message
-- was dropped and the bot never replied. Allow every type Meta sends; the
-- webhook also maps anything not listed here to 'unsupported'
-- (INBOUND_MESSAGE_TYPES) so a new Meta type can't reintroduce the failure.
alter table messages drop constraint messages_type_check;
alter table messages add constraint messages_type_check check (type in (
  'text', 'image', 'document', 'audio', 'interactive',
  'video', 'sticker', 'location', 'contacts', 'button', 'reaction',
  'order', 'system', 'unsupported'
));
