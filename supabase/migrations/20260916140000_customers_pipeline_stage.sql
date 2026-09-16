-- CRM pipeline stage: current relationship status with a customer, one value
-- per customer (not per booking_leads event — booking_leads is a plain event
-- log with no status column, a different concept).
--
-- Default 'new' — every customer starts here at creation, matching
-- upsertCustomerForInboundMessage's insert path in webhook.controller.js,
-- which never sets this column itself.
--
-- Auto-transitions (New->Contacted on a genuine human reply, Contacted-or-New
-- ->Converted on a customer's first confirmed/completed booking) live in
-- application code (src/services/customerPipeline.service.js), not here —
-- see that file for the rank-based guard that stops an automatic transition
-- from ever downgrading a stage or reviving a manually-set 'lost' customer.
-- 'lost' itself is manual-only for this phase: there's no reliable automatic
-- signal for it yet, and a wrong auto-Lost (a negative label that then has to
-- be discovered and corrected) is worse than no auto-Lost.
alter table customers
  add column pipeline_stage text not null default 'new'
  check (pipeline_stage in ('new', 'contacted', 'converted', 'lost'));
