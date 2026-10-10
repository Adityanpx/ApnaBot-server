-- WhatsApp payment-method problem (Meta error 131042), remembered per business.
--
-- businesses.payment_issue_at    when the FIRST 131042 not yet cleared was seen
-- businesses.payment_issue_code  the Meta code behind it (131042 today)
--   Both NULL = no known problem. Set by the server when a send or a status
--   webhook fails with 131042 (accountHealth.service.js): the first failure
--   wins, so "since" stays put while more fail. Cleared when a broadcast
--   recipient sent AFTER payment_issue_at is delivered or read, or by the owner
--   (POST /api/business/payment-issue/dismiss). GET /api/business shows it as
--   paymentIssue { since, code } | null; the raw columns are never returned.
--
-- Safe to re-run (add column if not exists); no data is touched and no row gets
-- a value. DEPLOY ORDER: apply this BEFORE the server code that writes it - the
-- code only writes these columns after a real 131042, and a write against a
-- missing column is logged, never thrown.

alter table businesses
  add column if not exists payment_issue_at timestamptz,
  add column if not exists payment_issue_code integer;

comment on column businesses.payment_issue_at is
  'First WhatsApp payment-method failure (Meta 131042) not yet cleared; NULL = none known.';
comment on column businesses.payment_issue_code is
  'Meta error code behind payment_issue_at (131042).';
