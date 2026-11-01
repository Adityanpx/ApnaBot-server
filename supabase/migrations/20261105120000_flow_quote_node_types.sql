-- Travel quotes, part C / commit 1: the two new node types for the chat quote.
--
--   route_picker   computed list question: From region/city -> To region/city -> "Other route"
--   quote          computed terminal node: prices the trip and sends the quote message
--
-- Both are is_computed = true (like vehicle_carousel): the canvas editors already show a computed
-- node read-only, and the batch save keeps it as stored (position only). Nothing creates them from
-- the API - only the SG Travels seed script of a later commit does - so applying this migration
-- changes no behaviour for any business.
--
-- CHECKs restated in full (drop + add; definitions confirmed against pg_constraint on the live database before
-- applying):
--   flow_nodes_node_type_check
--       was: reply, question, vehicle_carousel, rentalPackage
--       now: reply, question, vehicle_carousel, rentalPackage, route_picker, quote
--   flow_nodes_is_computed_only_for_computed_types
--       was: not is_computed or node_type in (vehicle_carousel, rentalPackage)
--       now: not is_computed or node_type in (vehicle_carousel, rentalPackage, route_picker, quote)
-- Not touched: flow_nodes_reply_kind_check (text, booking_trigger, payment_trigger, web_form_trigger,
-- handoff), flow_nodes_content_type_check (text, buttons, list, location, location_request, carousel,
-- catalog, file), flow_nodes_reply_needs_keyword, flow_nodes_question_needs_field_key (the new nodes
-- carry a field_key), node_library_entries.node_type (reply, question - these nodes are not library
-- entries). save_flow_graph_full needs no change: no new column.
--
-- ROLLBACK (delete the rows of the new types FIRST, or re-adding the old checks fails):
--   delete from flow_nodes where node_type in ('route_picker', 'quote');   -- their edges cascade
--   alter table flow_nodes drop constraint flow_nodes_is_computed_only_for_computed_types;
--   alter table flow_nodes add constraint flow_nodes_is_computed_only_for_computed_types
--     check (not is_computed or node_type in ('vehicle_carousel','rentalPackage'));
--   alter table flow_nodes drop constraint flow_nodes_node_type_check;
--   alter table flow_nodes add constraint flow_nodes_node_type_check
--     check (node_type in ('reply','question','vehicle_carousel','rentalPackage'));

alter table flow_nodes drop constraint flow_nodes_node_type_check;
alter table flow_nodes add constraint flow_nodes_node_type_check
  check (node_type in ('reply','question','vehicle_carousel','rentalPackage','route_picker','quote'));

alter table flow_nodes drop constraint flow_nodes_is_computed_only_for_computed_types;
alter table flow_nodes add constraint flow_nodes_is_computed_only_for_computed_types
  check (not is_computed or node_type in ('vehicle_carousel','rentalPackage','route_picker','quote'));
