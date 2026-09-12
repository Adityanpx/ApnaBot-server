-- Web-form booking link: an alternative to a Meta WhatsApp Flow for
-- collecting booking fields. Customer taps a button, gets a secure link
-- to a plain authenticated web page (src/controllers/publicServiceForm.controller.js),
-- fills it in, submits to a normal server endpoint, and gets their
-- confirmation back as a normal WhatsApp text message. No Meta Flow
-- registration, no Data Endpoint, no Business Verification dependency.

-- businesses.flow_fields — the field list an owner configures for their web
-- form. Array of { name, type, label, required, options?, visibleWhen? }.
-- type is one of dropdown/radio/date/text/textarea. options is a plain
-- string[] (this renders on a real HTML page, not a WhatsApp interactive
-- message, so there's no need for the {value,label,labelTranslations} shape
-- flow_nodes.options uses). visibleWhen, when set, is
-- { field: string, equals: string } and must reference an EARLIER field in
-- the array (enforced at the API layer in business.controller.js, not here).
alter table businesses add column flow_fields jsonb not null default '[]';

-- booking_form_tokens — one-time, expiring, token-gated link. Looked up by
-- `token` (never by `id`) from the unauthenticated public endpoints in
-- publicServiceForm.controller.js. business_id/customer_id are not null:
-- a token with no owning conversation is meaningless.
create table booking_form_tokens (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  customer_id uuid not null references customers(id),
  customer_number text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
-- `unique` above already creates a unique btree index on token, which is
-- what every lookup in publicServiceForm.controller.js uses.

-- New reply_kind: a 'reply' node whose trigger sends the customer this link
-- instead of starting a graph booking session or asking for payment.
alter table flow_nodes drop constraint flow_nodes_reply_kind_check;
alter table flow_nodes add constraint flow_nodes_reply_kind_check
  check (reply_kind in ('text','booking_trigger','payment_trigger','web_form_trigger'));
