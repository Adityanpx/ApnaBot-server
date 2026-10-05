-- #6 Phase 4: what ApnaBot does when a customer taps a template's quick-reply
-- button.
--
-- button_actions = [{ "index": 0, "text": "Yes", "action": <action> }], one entry
-- per QUICK_REPLY button the owner gave an action. index is the button's
-- position in the template's BUTTONS list (URL / phone buttons count too), text
-- is the label it had when the action was set - an inbound tap only uses an
-- entry whose index AND text both still match, so a button Meta later changed
-- is ignored rather than mis-routed. <action> is one of
--   { "type": "keyword", "keyword": "price" }   behave as if the customer typed it
--   { "type": "node", "nodeId": "<uuid>" }      a reply node or a question node
--   { "type": "menu" }                          same as the customer saying "hi"
--   { "type": "optout" }                        same as STOP
-- Kept apart from meta_components on purpose: the template sync overwrites that
-- column wholesale, but never touches this one.
--
-- DEPLOY ORDER: apply before the server code from the same change. (The inbound
-- routing tolerates a missing column - it falls back to the button's text - but
-- the API that writes actions does not.)
alter table message_templates
  add column button_actions jsonb
    check (button_actions is null or jsonb_typeof(button_actions) = 'array');
