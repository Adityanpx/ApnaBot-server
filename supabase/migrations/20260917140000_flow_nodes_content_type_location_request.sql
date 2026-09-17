-- Allow content_type='location_request' on flow_nodes (a question node that
-- asks the CUSTOMER to share their live WhatsApp location via the native
-- location picker), alongside the existing text/buttons/list/location.
-- Distinct from content_type='location' (20260906140000_flow_nodes_content_type_location.sql),
-- which sends the BUSINESS's own saved coordinates as an outbound map pin —
-- opposite direction, deliberately kept as a separate value rather than
-- reusing/renaming either one. The API-layer VALID_CONTENT_TYPES check in
-- flowGraph.controller.js mirrors this constraint, same as it already does
-- for flow_edges.condition/preset shape.
alter table flow_nodes drop constraint flow_nodes_content_type_check;
alter table flow_nodes add constraint flow_nodes_content_type_check
  check (content_type in ('text','buttons','list','location','location_request'));
