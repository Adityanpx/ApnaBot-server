-- Per-node location override for content_type='location' reply nodes, so a
-- multi-property business (e.g. 3 separate hotels under one WhatsApp
-- number) can send a different pin per reply node instead of always
-- falling back to the single businesses.business_latitude/
-- business_longitude pin (webhook.controller.js's content_type==='location'
-- branch -- confirmed by reading it: one pin per business today, no
-- per-node override).
-- Nullable, no backfill: existing location nodes (confirmed live --
-- Internet Cafe Katta, SG Travels) keep resolving to the business-level pin
-- exactly as they do today. Meaningful only on nodes with
-- content_type='location'; not DB-enforced, same looseness as button_text/
-- form_fields elsewhere on this table. All-or-nothing at the read site: a
-- node needs BOTH latitude and longitude set to override, or neither.
alter table flow_nodes add column latitude numeric;
alter table flow_nodes add column longitude numeric;
alter table flow_nodes add column location_name text;
alter table flow_nodes add column address text;
