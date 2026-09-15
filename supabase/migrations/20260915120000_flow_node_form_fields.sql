-- Per-node field config for web_form_trigger nodes, so a business with more
-- than one web_form_trigger reply node can render a different form per
-- node instead of one business-wide flow_fields array for all of them.
-- Nullable / no backfill: existing booking_form_tokens rows and nodes with
-- no form_fields configured keep resolving to businesses.flow_fields
-- exactly as they do today (see publicServiceForm.controller.js's
-- resolveFlowFields).
alter table booking_form_tokens
  add column flow_node_id uuid references flow_nodes(id) on delete set null;

alter table flow_nodes
  add column form_fields jsonb;
-- Same shape as businesses.flow_fields (array of
-- { name, type, label, required, options?, visibleWhen? }, see
-- 20260913120000_web_form_booking_link.sql / utils/flowFieldsValidation.js)
-- — meaningful only on nodes with reply_kind = 'web_form_trigger'; not
-- DB-enforced, same looseness as content_type elsewhere in this schema.
