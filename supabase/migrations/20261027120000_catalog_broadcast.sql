-- "Send catalogue" broadcast: a Meta media-card CAROUSEL marketing template built from the Catalogue's
-- collections, sent to a broadcast audience.
--
-- message_templates.kind  'standard' (everything that exists today) or 'catalog_carousel' (the reusable system
--                         templates apnabot_catalog_<cards>_<lang>_<buttons>, created on demand by
--                         services/catalogBroadcast.service.js). GET /api/message-templates hides the latter.
-- broadcasts.kind         'template' (today's broadcasts) or 'catalog'. A catalogue broadcast keeps template_id
--                         (the English variant) so the FK, the category / opt-in rules and the stats work
--                         unchanged; catalog_config holds { collectionIds, cardCount, buttons, templates }.
-- catalog_events.source / broadcast_id
--                         where a Catalogue event came from: 'bot' (default, today's behaviour) or 'broadcast'
--                         (the customer tapped a card button of a catalogue broadcast; the payload carries
--                         ":b:<broadcastId>"). broadcast_id is SET NULL if the broadcast row is deleted.
--
-- Additive only: every column has a default, no existing row changes. DEPLOY ORDER: apply this BEFORE the
-- server code from the same change (GET /api/message-templates filters on kind).
alter table message_templates
  add column kind text not null default 'standard' check (kind in ('standard', 'catalog_carousel'));

create index idx_message_templates_catalog_carousel
  on message_templates (business_id) where kind = 'catalog_carousel';

alter table broadcasts
  add column kind text not null default 'template' check (kind in ('template', 'catalog')),
  add column catalog_config jsonb;

alter table catalog_events
  add column source text not null default 'bot' check (source in ('bot', 'broadcast')),
  add column broadcast_id uuid references broadcasts(id) on delete set null;

create index idx_catalog_events_broadcast
  on catalog_events (broadcast_id) where broadcast_id is not null;
