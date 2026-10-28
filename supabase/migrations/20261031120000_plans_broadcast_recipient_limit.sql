-- Max recipients in one broadcast, per plan. -1 = unlimited (the MAX_BROADCAST_RECIPIENTS env cap
-- still applies). Effective cap = min(plan limit, env cap). Additive, defaulted; apply before the server.
alter table plans add column if not exists broadcast_recipient_limit integer not null default 100;

alter table plans drop constraint if exists plans_broadcast_recipient_limit_valid;
alter table plans add constraint plans_broadcast_recipient_limit_valid
  check (broadcast_recipient_limit = -1 or broadcast_recipient_limit >= 1);

update plans set broadcast_recipient_limit = 100 where name = 'basic';
update plans set broadcast_recipient_limit = 500 where name = 'pro';
update plans set broadcast_recipient_limit = -1  where name = 'business';
