-- travel_routes: translations of the three customer-facing route texts (the list rows of the route picker
-- and the route line of the quote), per language, filled by the auto-translate and editable by the owner.
--
--   from_label_translations  { "<lang>": "<text>" }  the From city name; the English text is from_label, or the
--   to_label_translations                            title-cased city key when from_label / to_label is empty
--   region_translations      { "<lang>": "<text>" }  the region heading ("Western Maharashtra")
--   auto_translations        { "<slot>": { "<lang>": "<hash>" } }  which of those the machine filled, so the apps can
--                            badge them (same bookkeeping as flow_nodes.auto_translations). Slots: fromLabel, toLabel, region.
--
-- NO BEHAVIOUR CHANGE FROM THIS FILE: four nullable columns, nothing backfilled, nothing reads them until the
-- server code from the same commit is deployed. A route with a null column shows its English text, as before.
-- A translation, like the English label, must fit a WhatsApp list row (24 characters); the server enforces that
-- (jsonb values cannot be checked per language here).
--
-- Existing CHECK constraints on travel_routes: from_label / to_label / region char_length <= 24
-- (restated from 20261104120000_travel_quotes.sql / 20261106120000_round_trip_pricing.sql; not altered here).
--
-- DEPLOY ORDER: apply BEFORE the server code that reads / writes the columns (the quotable-route list and the
-- route editor select them).
--
-- ROLLBACK:
--   alter table travel_routes
--     drop column from_label_translations, drop column to_label_translations,
--     drop column region_translations, drop column auto_translations;

begin;

alter table travel_routes
  add column from_label_translations jsonb,
  add column to_label_translations jsonb,
  add column region_translations jsonb,
  add column auto_translations jsonb;

commit;
