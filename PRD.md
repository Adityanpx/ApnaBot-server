# ApnaBot-server — Project State

Multi-tenant WhatsApp chatbot backend for Indian SMBs (travels/cab,
software/IT, tax consulting, medical, e-seva/internet-cafe, and
multi-brand verticals so far). Node/Express + Supabase (Postgres) +
Upstash Redis + BullMQ. Owner: Suresh Gavali (Averix Solutions Pvt Ltd —
the owner's own company; **not** a business tenant on the platform, see
below).

**One LIVE production business: Search cab AI** (`8440ac0a-1f9f-4a30-95e3-19ad2adbe6a2`,
`business_category='travels'`, WhatsApp-connected, created 2026-09-21 —
confirmed live against `businesses` on 2026-09-29). It has real customers:
never reset it, never run a `--confirm` script or an AI-flow `/apply`
against it, and state explicitly whether any change to a live-traffic path
(webhook, booking engine, confirmation text, canvas save) affects it.

Every other business is a test/demo account under the owner's control —
freely resettable, no real customer data to protect. The table below lists
the test accounts as confirmed against the live database on 2026-09-16; it
is **known stale** (the live table had more businesses by 2026-09-29) —
re-check `businesses` before relying on it:

| Name | business_id | business_category | booking_engine | created_at |
|---|---|---|---|---|
| Internet Cafe Katta | `8791f4b4-817a-4487-a7e7-4f29d0cb6425` | `maha_eseva_kendra` | `graph` | 2026-09-04 |
| Tax Consultant Services | `a5e9768c-422f-4c9f-85d3-34d18fe26ccb` | `tax_consultant` | `graph` | 2026-09-05 |
| SG Travels | `a94aec66-23fb-43e1-afcc-f4e8d518134b` | `travels` | `graph` | 2026-09-07 |
| CareWell Clinic | `142d1add-73d3-48bb-b2e8-65070169f063` | `medical` | `graph` | 2026-09-12 |
| Multi-Brand Router | `c3ef8588-6195-4075-9413-e5350b462d0b` | `multi_brand` | `graph` | 2026-09-15 |

**Averix Solutions no longer exists as a business row at all** — it was
previously documented here (as of the 2026-09-02 rewrite) under
business_id `27ae8c81-efb4-4947-b617-c5f461da32b2`,
`business_category='travels'`. That id returns zero rows as of
2026-09-16. It's unclear from this pass alone when/why it was deleted
(no admin-delete script or session-log entry for it was found this
session) — flagged to the user rather than guessed at. Do not use
"Averix" as a stand-in test business name in scripts or docs going
forward; use one of the 5 real businesses above.

**`business_category` is not unique per business** (see Multi-Brand
Router, and the historical Averix churn below) — code that looks up "the"
business for a category needs an explicit, freshly-verified business id,
never a category-based `.maybeSingle()` lookup.
`verifyBookingGraph.js` reflects this (as of its 2026-09-07 generic
rewrite): it requires an explicit `--business=<id>`/`BUSINESS_ID` every
run rather than baking in a default.

Historical id churn (all superseded by the table above — kept only so
old commit messages/scripts referencing these ids aren't mistaken for
current): SG Travels was previously `b92113c1-8692-46d5-b377-998c6541486f`
(2026-08-29 wipe/recreate) then `a94aec66-...` (current, since
2026-09-07). Averix, before it was deleted outright, passed through
`014a3f2a-6a32-4c44-82df-ec6a298a2caa` (set 2026-09-02) and, before that,
`6e918384-2a7e-4342-8ab4-2b9cecbe791d` (`business_category='software_it'`,
deleted 2026-09-02 when Averix was recreated under
`business_category='travels'`).

**This section has gone stale multiple times across past sessions**
(ids drift as test businesses get reset/rebuilt, and Averix's deletion
sat undocumented here for at least one full session cycle before being
caught). Treat every id/name/category value in this section as
needing a fresh `businesses` table check before you rely on it for
anything beyond casual reference — do not assume this file is
definitionally current just because it was rewritten recently. This
whole section goes away once ad traffic starts and these stop being
disposable test accounts; update it when that happens.

## Current architecture — ONE booking engine

There is no engine choice to reason about anymore. Every business is
created with `booking_engine = 'graph'` (`business.service.js#createBusiness`
hardcodes it), and the old flat engine — `booking.service.js`'s
`startBookingSession`/`processBookingStep`, the `rules` and `business_flows`
tables, `business_saved_flows`, `flow_packs`, and their controllers
(`rule.controller.js`, `savedFlow.controller.js`, `flowPack.controller.js`,
`flowPackPublic.controller.js`) — is **deleted**, not deprecated. Confirmed
by grep: none of those names appear anywhere in `src/` except historical
comments explaining what used to be there, and the corresponding tables no
longer exist in the live database (migrations
`20260901170000_drop_flow_packs_and_business_flows.sql` and
`20260901180000_drop_menu_and_rules.sql`, both applied — `supabase
migration list` shows local and remote in sync as of 2026-09-02).
`businesses.booking_engine` itself is now a vestigial column — kept as a
no-op rather than removed outright (see `flowGraph.middleware.js`), since
nothing branches on any value but `'graph'` anymore.

The numbered-menu feature (`businesses.is_menu_enabled`/`menu_items`, the
`rules` table it pointed at) is gone the same way — columns dropped,
`webhook.controller.js`'s three menu-branches and `buildMenuListOptions`
removed, since nothing had written to `rules` since the graph-engine
cutover and the menu picker had always resolved empty in practice.

### The graph engine (flow_nodes / flow_edges)
- Tables: `flow_nodes`, `flow_edges`, `flow_snapshots` (see "Snapshots &
  category templates" below)
- Core logic: `src/services/bookingGraph.service.js` (pure, side-effect-free
  `advanceGraphSession`/`startGraphSession`), `src/services/chatbot.service.js`
  (reply-node matching), `src/controllers/webhook.controller.js` (orchestration,
  WhatsApp send)
- WhatsApp interaction ids: `flow_edges.id` for reply-node buttons/lists,
  `"{node_id}:{index}"` / `"{node_id}:other"` for question-node and
  computed-node (vehicle_carousel/rentalPackage) options
- Verified via `src/scripts/verifyBookingGraph.js`. Rewritten 2026-09-07 to
  be fully generic — no hardcoded business id, vehicle id, route-fare id,
  or expected fare/value anywhere in the script, and no default business
  (a required `--business=<id>` arg or `BUSINESS_ID` env var). This was
  necessary, not just a cleanup: businesses on this platform aren't all
  shaped like a travel booking flow (confirmed live 2026-09-07 — Internet
  Cafe Katta, category `maha_eseva_kendra`, has no `tripType`, no
  `vehicle_carousel`, no route_fares/vehicle_catalog concept at all, just a
  reply-node menu tree into a linear text-field chain), so a script that
  types literal replies like `'One Way'`/`'Pune'`/`'Mumbai'` can never run
  against it. The script now auto-walks the graph generically **by field
  type** (buttons/list → first option, vehicle_carousel → first computed
  option, free text → a fixed placeholder), never by field key or label,
  and branches once per option on the first question if it offers more
  than one (reproduces One Way/Round Trip coverage for the travel
  businesses without assuming those values exist). Per branch it asserts
  four structural properties against whatever the business's CURRENT live
  data actually is — never a frozen expected-value snapshot: reached
  `{done:true}`; every currently-`required` field has a value; if a
  vehicle/fare was selected, it's independently re-verified as still
  active in live `vehicles`/`route_fares`/`rental_packages` (not just
  trusted from the engine's own staleness check on the same run); and
  every visited node's `label_translations` values are non-empty where
  configured (or N/A if none are configured, not a false pass). Confirmed
  passing cleanly against SG Travels, Averix Solution, and Internet Cafe
  Katta by id, with zero script edits between runs (Averix Solution no
  longer exists as of 2026-09-16 — see the business table at the top of
  this doc; this line is a historical record of that 2026-09-07 run, not
  a claim it's still a live business). The Local Rental
  no-packages detour still isn't exercised — no business currently has a
  live path into it (see "Known gaps" below); this is a live-data gap, not
  a script limitation, since the walker would exercise it automatically if
  a business's `tripType` options included "Local Rental" with no
  `rental_packages` configured. Re-run this script after any change to
  `bookingGraph.service.js` or `booking.service.js`'s shared logic (CLAUDE.md
  rule 6).
- **CONFIRMED WORKING ON REAL WHATSAPP TRAFFIC** (2026-08-30) — full trip
  booked end-to-end for both One Way and the travelDate-condition fix,
  correct fare, correct confirmation, correct DB row.
- The "book" entry node routing bug (see Session log) is fixed and verified
  live in the database as of 2026-09-02: SG Travels' `booking_trigger`
  reply node's outgoing edge targets `tripType` (unconditional), not
  `pickupLocation` — every booking now actually asks trip type instead of
  silently defaulting to One Way. **Stale as of 2026-09-16:** SG Travels'
  entry reply node is no longer `booking_trigger` at all — it's now
  `reply_kind='web_form_trigger'` (confirmed live against `flow_nodes`).
  `booking_trigger` and `web_form_trigger` currently coexist as two
  different entry mechanisms across businesses on this platform (e.g.
  Internet Cafe Katta and Tax Consultant Services still use
  `booking_trigger`; Multi-Brand Router has both node types present).
  `web_form_trigger` sends the customer a tokenized link to a public,
  unauthenticated booking form (`src/controllers/publicServiceForm.controller.js`,
  `booking_form_tokens` table) instead of continuing the conversation
  in-chat — see "Web-form booking links" below.

### Web-form booking links (`web_form_trigger`) — live (Search cab AI, SG Travels, coaching forms)

A reply node with `reply_kind='web_form_trigger'` answers with a WhatsApp
CTA-URL button linking to a public web page (`apnabot-web`
`/book/[token]`) where the customer fills in a form, instead of answering
questions in chat.

- **Minting (webhook.controller.js, web_form_trigger branch):** inserts a
  `booking_form_tokens` row — `business_id`, `customer_id`,
  `customer_number`, `flow_node_id` (the form node), `source_node_id` (the
  node whose button/list row was tapped to get here; null when typed —
  added 2026-09-29), `expires_at` = now + 30 min — and sends
  `FRONTEND_URL/book/<token>` with the node's `label`/`button_text` (else
  the `webFormPrompt`/`webFormButtonText` system messages). A failed insert
  sends the `webFormLinkFailedFallback` message instead.
- **Which fields:** the form node's own `flow_nodes.form_fields` when it has
  any, else the business-wide `businesses.flow_fields` (Service Form page)
  — `publicServiceForm.controller.js#resolveFlowFields`. Both validated by
  `utils/flowFieldsValidation.js#validateFlowFields`.
- **Public endpoints (`/api/public`, token = authorization, no login):**
  `GET /service-form/:token` → `{ businessName, isTravelBusiness,
  flowFields, prefill?, formTitle?, formSubtitle? }` (optional keys only
  present when set; `formTitle` = a published Bot Builder form's page
  header, "Book a free demo class" / "Admission form" —
  `resolveFormTitle`); `POST /service-form/:token/submit { values }`;
  travel helpers `GET .../vehicle-options`, `POST .../places-autocomplete`,
  `POST .../place-details`, `POST .../vehicle-quote`. Expired → 410, used →
  410, unknown → 404.
- **Submit:** checks required fields and option values (a course-list
  value must be a current course), creates the booking via
  `bookingService.createBookingAndConfirmation` (saving `bookings.form_key` /
  `form_title` — "demo"/"Free demo", "admission"/"Admission" for a published
  Bot Builder form, else null — and `field_labels` `{fieldName: label}`, all
  snapshotted at submit since Bot Builder rebuilds its forms on publish),
  marks the token used
  (`used_at` — one link, one booking), and sends the WhatsApp
  confirmation (image + caption when a payment QR is due).
- **Dynamic options / prefill:** a dropdown with
  `source: 'business_courses'` gets the business's active courses when the
  form opens (`resolveDynamicOptions`). `prefill` (only present when
  non-empty) pre-selects the course when the form was opened from a Bot
  Builder course page (`source_node_id` keyword `page_course_N` → course N
  of `business_bot_settings.published_settings.courses`,
  `resolvePrefill`) — the customer can still change it.

### CRUD for the graph engine — full node + edge CRUD, mounted at `/api/flow-graph`
`src/middleware/flowGraph.middleware.js` (`requireGraphEngine`),
`src/controllers/flowGraph.controller.js`, `src/routes/flowGraph.routes.js`.
Structural safety lives in `src/utils/flowGraphValidation.js` (`findCycles`,
`findUnreachableNodes`, `findFallbackSiblingNodeIds`,
`resolveBookingTriggerEntryNodeIds`) — pure functions over `{nodes, edges}`,
called by every mutating handler via `assertGraphStillValid` before it
writes. `assertGraphStillValid`, the shared validators/constants, and the
core of the canvas batch save (`PUT /full`: diff → validate → one atomic
`save_flow_graph_full` RPC → `invalidateRulesCache`) live in
`src/services/flowGraph.service.js` (extracted 2026-09-29, behavior
unchanged — see session log) so AI flow generation's `/apply` commits
through the exact same path.

Endpoints: full CRUD for `reply`-type nodes (`/reply-nodes`), `question`-type
nodes (`/question-nodes`), and `flow_edges` (`/edges` — add/retarget/
set-condition/delete/reorder via `/edges/reorder`), plus `GET /full` (entire
graph — all reply nodes, question nodes, edges — in one response, added so
the frontend editor avoids N+1 fetching). All live-tested against SG
Travels' real graph. Edge writes are surgical (UPDATE in place, never
delete+recreate) — an edge's id is a live WhatsApp interaction id a
customer may already be holding, so replacing it the way the old `rules`
table's buttons-array replace pattern did would silently break an
in-flight tap.

Guards in place: reserved-field-key protection (`tripType`/`pickupLocation`/
`dropLocation`/`travelDate`/`pickupTime`, for `travels`/`cab` categories —
`RESERVED_TRAVEL_FIELD_KEYS` in `flowGraph.controller.js`), servedCities-
overlay rejection on pickupLocation/dropLocation options, cascade-delete
protection (refuses to delete a node other nodes' edges still target), the
contentType-switch-with-live-edges guard, the fallback-sibling delete guard
(blocks deleting a node like the static `vehicleType` fallback that has no
incoming edge but is still load-bearing at runtime), `flow_edges.condition`
existence-only field validation, and cycle/reachability re-validation on
every node or edge write that could break the question subgraph (including
reply-node `replyKind` edits/deletes that would remove the last
`booking_trigger` entry point). Reachability re-validation is
**differential, not absolute** — it only rejects an edit that newly strands
a node that was reachable before the edit ran; a pre-existing orphan (a
question node created but not yet wired to an edge, the normal in-between
state of the create-then-wire workflow) doesn't block unrelated edge writes
elsewhere in the graph.

`vehicle_carousel` nodes can be created via `POST /api/flow-graph/question-nodes`
with `nodeType: 'vehicle_carousel'` — server forces `is_computed=true`/
`content_type='list'` and rejects a non-empty `options` array. Still
read-only after creation (update/delete stay scoped to `node_type='question'`),
and `createEdge` refuses any edge sourced FROM a vehicle_carousel node (zero
outgoing edges — the post-selection flow is hardcoded in
`bookingGraph.service.js`, not edge-driven). `rentalPackage` nodes are still
read-only through this surface by design — engine-internal, no dashboard
concept of creating one.

### Snapshots & category templates (`flow_snapshots`) — built, in active use

One table, two purposes, distinguished by `is_category_template`
(migration `20260901120000_flow_snapshots_category_templates.sql`,
`business_id` nullable, `category` + `is_category_template` columns added,
with a check constraint enforcing exactly one of business_id/category is
set):

- **Personal versioning** (`is_category_template=false`, `business_id` set,
  `category` null) — a business owner's own point-in-time saves of their
  current `flow_nodes`/`flow_edges`. `GET/POST /api/flow-graph/snapshots`
  (list/create), `POST /api/flow-graph/snapshots/:id/restore` (full replace
  of the live graph from a saved snapshot), `DELETE /api/flow-graph/snapshots/:id`,
  plus `POST /api/flow-graph/snapshots/import-category-template` (full
  replace of the live graph from the active category template, on demand —
  not just at signup). Owner-only writes, staff can list.
- **Category starter templates** (`is_category_template=true`,
  `business_id` null, `category` set) — SuperAdmin-owned, **multiple per
  category** (an owner picks one from `GET /api/flow-graph/snapshots/
  category-templates?category=X`), managed at `/api/admin/category-templates`
  (`GET` list, `POST /clone-from-business` to seed one from an existing
  business's live graph or one of its snapshots, `GET /:id/export` /
  `POST /import-json` for raw row JSON, `DELETE /:id`).
- **Signup does NOT seed a template** (corrected 2026-09-29 — this file
  previously said it did). `business.service.js#createBusiness` gives every
  new business a literal empty graph; importing a category template is an
  explicit owner action from the Versions tab (`import-category-template`).
- `POST /api/flow-graph/snapshots/start-blank` wipes the live graph to empty
  (owner action, unsets every snapshot's `is_active`).

Row counts are not tracked here (the old "table is empty as of
2026-09-02" note was stale — e.g. CareWell Clinic has had a personal
snapshot since 2026-09-29's AI-flow test). Query `flow_snapshots` directly.

### AI flow generation, Phase 1 (`/api/flow-graph/ai`) — built, OFF by default

Questionnaire answers or a FlowSpec → a complete reply/booking graph,
**deterministic, no LLM yet**. Mounted only when `ENABLE_AI_FLOW_GEN=true`
(`src/config/env.js`, checked in `app.js`; the route module isn't even
loaded otherwise) — one switch turns the whole feature off.

- `POST /compile` (any business member) — body is exactly one of
  `{ spec }` / `{ answers }`; returns `{ spec, graph, warnings }`, temp ids,
  no writes.
- `POST /apply` (owner) — same body; the server re-maps answers (business
  name read fresh) and recompiles, then: **409** for `cab`/`travels`
  categories or any graph containing computed nodes; snapshots the current
  graph first as "Before AI flow — <date>" (not marked active; aborts if
  the snapshot fails); full-replaces the graph via
  `flowGraph.service.js#saveFullGraph`; then unsets `is_active` on the
  business's snapshots and enforces the 5-snapshot cap. A rejected save
  removes its snapshot again. Warnings: welcome message set (greeting words
  bypass the generated menu — `welcome_message` is never modified), N
  in-progress booking sessions will end, optional questions switched off
  via `disabled_booking_fields`, oldest snapshot evicted, menu rendered as
  a list. **Every successful apply is a live cutover** for that business.
- Code: `src/utils/flowSpec.js` (`validateFlowSpec`/`compileFlowSpec`,
  FlowSpec v1, Meta limits enforced at compile time — nothing else in the
  codebase checks them at save time), `src/utils/flowSpecQuestionnaire.js`
  (answers → FlowSpec), `src/services/aiFlow.service.js`
  (`compile`/`prepareApply` read-only, `executeApply` writes),
  `src/controllers/aiFlow.controller.js`, `src/routes/aiFlow.routes.js`.
  Tests: `src/utils/flowSpec*.test.js` (`npm test`).
- Emits only: reply `text` (text/buttons/list/location), `booking_trigger`,
  `payment_trigger`, `question` (text/buttons/list/location_request).
  Never: `vehicle_carousel`/`rentalPackage`, `web_form_trigger`, edge
  conditions/presets, images, translations. Menu = reply keyword `hi`
  (exact) + the other greeting words as aliases; booking questions are only
  reachable through the `booking_trigger` node (required by
  `saveFullGraph`'s reachability check for new question nodes).
- Script: `node src/scripts/applyAiFlow.js --business=<id>
  --answers=<file>|--spec=<file> [--confirm]` — same code path as
  `/apply`, dry run by default.
- Deferred: the LLM step (Phase 2 — answers/free text → FlowSpec),
  prefill of hours/address from the business row, translations, merge
  (instead of replace), travel categories, a real human-handoff reply kind
  ("contact" is text-only).

### Bot Builder + Courses (coaching) — built, switched per category from Super Admin

Owners of a **coaching** business describe their institute in settings and
Publish; the server generates a reply-only, tappable WhatsApp flow (no
question nodes) plus web-form links for Free demo / Admission.

- **Feature switch:** `category_features` table (category, feature,
  is_enabled; no row = off). The `bot_builder` switch for `coaching` is
  toggled in **Super Admin → Business Settings → Coaching → Features** and
  applies immediately, no redeploy. `/api/bot-settings` and `/api/courses`
  are always mounted but gated per request by
  `middleware/categoryFeature.middleware.js#requireCategoryFeature` (404 while
  off). Switches are defined in `services/categoryFeature.service.js`
  (FEATURES — must match the table's check constraint). Admin API:
  `GET /api/admin/category-features/:category`,
  `PUT /api/admin/category-features/:category/:feature { isEnabled }`.
  (Replaced the former `ENABLE_BOT_SETTINGS` environment variable.)
- **Courses:** `course_catalog` (Super Admin suggestions per category,
  `/api/admin/course-catalog`, always mounted, seeded with 12 coaching
  courses via `scripts/seedCourseCatalog.js`) → `business_courses` (each
  business's own list, `/api/courses`). A picked course is a **copy**, not
  a link; owners can also add their own. `____` in a course marks a blank
  the owner must fill before publishing.
- **Settings + publish:** `business_bot_settings` (draft `settings`,
  `published_settings` = `{ settings, courses }` at the last publish,
  `published_snapshot_id`). `GET/PUT /api/bot-settings`,
  `POST /api/bot-settings/compile` (no writes),
  `POST /api/bot-settings/preview-message` ("Try your bot" chat on UNSAVED
  settings — compiles the draft and answers each message like the live bot
  would, using the same keyword matcher `chatbot.service.js#matchNodeInList`
  as live traffic; stateless, no writes, no form links, no AI fallback;
  `services/botSettingsPreview.service.js`), `POST /api/bot-settings/publish`
  (snapshot "Before bot settings publish — <date>" first, then the shared
  `flowGraph.service.js#saveFullGraph` path). Code:
  `utils/coachingBotSettings.js` (settings + courses → FlowSpec v2),
  `utils/flowSpecV2.js` (pages, buttons/lists, form links → graph),
  `services/botSettings.service.js`. **Every publish is a live cutover** for
  that business.
- **Service-form "Course list":** a dropdown field with
  `source: 'business_courses'` lists the business's active courses when the
  form opens (`publicServiceForm.controller.js#resolveDynamicOptions`);
  forms without it are unchanged. Tapping Free demo / Admission on a course
  page opens the form with that course pre-selected (see "Web-form booking
  links").
- **Structured course details (`age_group`, `duration`, `fees`, `mode`
  online|offline|both, `more_details` on both course tables):** when any is
  set, the course page is built from them (`*Name*`, description, 👦 Age /
  🕘 Duration / 💰 Fees / 💻 Mode lines, more details —
  `courseValidation.js#coursePageText`, mirrored in web/app/Super Admin
  previews); otherwise the old free-text `details` is used unchanged. The 12
  catalog entries are moved over by `scripts/convertCatalogToStructured.js`
  (dry run / `--confirm`); business courses switch when the owner fills the
  fields in.
- **Admission fee (`settings.admissionForm.fee { enabled, amount }`):** read
  from the PUBLISHED settings at submit (`coachingBotSettings.js
  #formPaymentFor` → `formMeta.advance`); the request is saved payment-
  pending (`payment_details.purpose = 'admission'`) and the parent gets the
  payment QR (text fallback without a QR). Marking it paid sets status
  `completed` ("Admitted") and WhatsApps "Fees received! Admission … is
  confirmed". **Bot Builder forms never use the business-wide advance
  payment** (a free demo never asks for money); every other web form and
  chat booking keeps it unchanged (no `formMeta.advance` key).
- **Broadcast audiences (`broadcasts.audience_filter` + `audience_params`,
  `services/broadcastAudience.service.js`).** Five types, all sending an
  approved template to opted-in, non-blocked, not-opted-out (`opted_out_at`
  null) customers **whose `whatsapp_number` is 8-15 digits** (the number rule
  applies to every type, added 2026-10-07; a malformed number is no longer
  attempted). **Opt-in depends on the template's category (2026-10-12):** a
  MARKETING template needs `opted_in = true` as above; a **UTILITY** template
  (payment reminder, booking update …) does not — it reaches opted-in AND
  not-opted-in customers, but never `opted_out_at` set, blocked or a bad
  number. AUTHENTICATION, an unknown category or none keep the marketing rule:
  `requiresMarketingOptIn(category)` is false ONLY for a case-insensitive
  "utility". The category always comes from the stored `message_templates`
  row (`templateCategory(businessId, templateId)`, scoped to the business),
  never from a request body. The worker does no eligibility check of its own;
  the audience is fixed when `sendBroadcast` snapshots it:
  - `all_customers` (default; nothing stored).
  - `coaching_requests` `{ form: demo|admission|any, course, skipClosed }` —
    parents with a matching Free demo / Admission request (`bookings.form_key`,
    optionally `fields.course`, by default skipping cancelled = "Not
    interested" / "Not joining"); a coaching business (Courses switch on); one
    parent counts once.
  - `groups` `{ groupIds[≤20] }` — members of customer groups
    (`contact_groups`; only this business's groups count).
  - `customers` `{ customerIds[≤2000] }` — picked customers, de-duplicated; the
    ids must be this business's (404 at create otherwise).
  - `segment` `{ tags?, pipelineStages?, activeWithinDays?, neverMessaged? }`
    — every key given must hold; tags match ANY, exactly (case-sensitive,
    `customers.tags` jsonb); `activeWithinDays` is `last_message_at` within N
    days; `neverMessaged` is `last_message_at` null. No VIP. At least one
    filter; unknown keys, and `activeWithinDays` + `neverMessaged` together,
    are a 400.

  `resolveAudience` is the send path and is also used by the preview and
  `POST /api/broadcasts/audience-count`, so the count shown is who gets it.
  `audience-count`, `audience-summary` and `audience-skipped` take an optional
  `templateId` in the body (looked up scoped to the business); missing,
  malformed, not found or another business's template means the strict
  marketing rule, so an old client sees no change. For UTILITY the summary's
  `not_opted_in` is always 0 (the reason set and order are unchanged).
  `recipients-preview` and the send read the draft's own template. The empty-audience
  400 from the send says "opted-in" only for templates that need it.
  `GET /api/customers`' `broadcastEligible` flag and filter (`isBroadcastEligible`)
  have no template and stay marketing-strict.
  **Summary / skipped list (owner + superadmin only):** `POST
  /api/broadcasts/audience-summary` → `{ selected, willReceive, skipped:
  { no_number, blocked, opted_out, not_opted_in }, overCap, cap }` (`cap` =
  `MAX_BROADCAST_RECIPIENTS`, default 2000; `overCap` = willReceive above it,
  which the send would refuse); `POST /api/broadcasts/audience-skipped`
  `{ …audience, reason?, page?, limit?≤100 }` → `{ items: [{ customerId, name,
  number (masked), reason }], pagination }`. Both read the SQL functions
  `broadcast_audience` / `broadcast_audience_summary` (migrations
  `20261007120000_broadcast_audience_builder.sql`, then
  `20261012120000_broadcast_audience_utility_optin.sql`, which adds
  `p_require_opt_in boolean default true` and drops the 3-argument versions;
  service_role only), which
  select by the same rules and give each skipped customer ONE reason (order
  no_number > blocked > opted_out > not_opted_in). The send does not use them:
  `node src/scripts/checkAudienceParity.js --business <id>` (read-only, no
  `--confirm`) compares the SQL's willReceive ids with `resolveAudience` for
  every type on a real business, once as MARKETING and once as UTILITY — run it
  after the migration and whenever either side changes. `GET /api/customers/ids?<list filters>` →
  `{ ids, total, truncated }` (≤2000, for "select all matching") and `GET
  /api/customers/tags` → `{ tags }` back the picker; the customer list gained
  `?tags=` (ANY; `tags=a&tags=b` or `tags=a,b`). `/api/broadcasts` accepts JSON
  bodies up to 1 MB (2000 ids is ~80 KB); every other route keeps 100 KB.
  **Send is claimed atomically:** `sendBroadcast` flips `draft → sending` with
  one conditional UPDATE before the wallet debit; a concurrent send gets 409
  "already being sent". A failure before anything is queued refunds and puts it
  back to draft; if only some batches queue, the rest are refunded,
  `total_recipients` is lowered and the draft is NOT released (a retry would
  double-message). **PostgREST limits that shape this code (measured on the
  hosted project):** a response is capped at 1000 rows (`max_rows`) and an
  `in(...)` filter of ~400 UUIDs fails (350 works), so id lookups go in chunks
  of 200 (`ID_CHUNK`) and unbounded reads are paged.
- **Demo time + reminders (`bookings.scheduled_for / reminder_status /
  reminder_note`, `settings.demoForm.reminder` off|2h|evening):** on a Free
  demo request the owner fixes the time (`PUT /api/bookings/:id/demo-time`)
  → status `confirmed` ("Demo fixed"), the parent is told at once, and a
  BullMQ delayed job (`demo-reminder` queue, one job per booking) reminds
  them 2 hours before / 7 PM India time the evening before. Both messages go
  as free text inside the parent's 24-hour window, else as the business's
  `apnabot_demo_class` UTILITY template (wallet-charged like a broadcast),
  else not at all (`reminder_note` says why). The template is created and
  submitted to Meta on Publish when a reminder is on; Bot Builder shows its
  approval. The worker re-checks the booking (time, status, reminder still
  on) when it fires, so stale jobs do nothing. Times are India time.
- **Hindi / Marathi bot (`settings.translations`, owner-typed, no API):**
  `{ hi|mr: { textId: { text, source } } }` inside the Bot Builder settings
  (saved with the draft, live on Publish). `utils/coachingTranslations.js`:
  every text the bot sends is a slot (`welcome`, `section.fees`,
  `course.<id>.page|name|description`, `faq.N.question|answer`,
  `fixed.*` = the builder's own wording with BUILT_IN hi/mr). Publish puts
  usable translations into the node/edge `*_translations` columns the live
  chat already sends to a customer by `preferred_language`; a translation
  whose `source` no longer matches the English, that is over the WhatsApp
  limit, or that changes `{{…}}` placeholders is skipped (English sent) and
  warned about. `POST /api/bot-settings/translation-slots` lists the slots
  for the Translations card (web + app).
- **Web form page in the parent's language:** GET
  `/api/public/service-form/:token` looks up the customer's
  `preferred_language` and returns `language` plus fields already in it —
  Bot Builder form fields carry `labelTranslations` / `optionTranslations`
  (built-in for the library questions and their fixed choices, owner slots
  for the note and custom questions); a choice is shown translated
  (`optionLabels`) but its English value is what's submitted and saved.
  Course names, batches and exam names stay as typed. The page's own wording
  (`apnabot-web src/app/book/[token]/strings.ts`) follows `language` for
  every business; 410 expired/used responses carry `errors.language`. The
  WhatsApp confirmation uses the translated question labels; the booking's
  `field_labels` stay English.
- **Fixed system messages in hi/mr (all businesses):** booking-received
  confirmation + summary lines (fare/distance/DA/toll/rental notes),
  advance / admission-fee requests, QR caption, "advance/fees received",
  session timeout, demo time/reminder, and the older `SYSTEM_MESSAGES`
  fallbacks — all in `utils/systemMessages.js`, chosen by the customer's
  `preferred_language`; English text unchanged.
- **Course photos (`business_courses.image_media_id` → `business_media`):**
  an optional image, checked to be an image of the same business, sent
  above the WhatsApp course page (FlowSpec v2 page `mediaId` → node
  `mediaId`, resolved to `image_url` by `saveFullGraph`; button/text pages
  only — WhatsApp lists can't carry an image). Courses API returns
  `imageUrl` for previews; the draft chat returns `imageUrl` too.
- **Institute presets ("What kind of institute are you?"):** Skill classes /
  Competitive exams / School tuition (`utils/coachingInstitutePresets.js`,
  returned in `GET /api/bot-settings` → `presets.coaching.institutePresets`).
  Applying one replaces sections, forms and FAQ (welcome message + courses
  kept; asks first if anything exists) and records optional
  `settings.instituteType`; the Courses catalog picker shows that preset's
  `suggestedCourses` first. Preset text carries "____" blanks — publish now
  refuses ____ in the welcome message, switched-on sections, enabled form
  notes and FAQ (drafts may keep them).
- **Course batches (`batches` jsonb list of labels, max 10 × 72 chars, on
  both course tables):** listed as a "🗓 Batches" section after the course
  page details. Bot Builder forms' "Batch" question is a dropdown with
  `source: 'course_batches'`, `dependsOn: 'course'` and options Weekday /
  Weekend as the fallback: the public form GET adds `optionsByCourse`
  (`resolveDynamicOptions`), `/book` shows the picked course's batches and
  clears a stale pick, submit checks the answer (`allowedOptions`).
- **Course groups (`business_courses.group_name`, catalog suggests one):**
  with 2+ distinct groups among shown courses, WhatsApp shows Courses →
  groups ("N courses") → that group's courses (+ All groups / Main menu) →
  course page; ungrouped courses form "Other courses", always last. Limits:
  9 groups × 9 courses. Fewer than 2 groups = the old flat list (max 10).
  Course pages keep global ids course_1..N, so form prefill is unaffected
  (`coachingBotSettings.js#groupCourses`).
- **FAQ (optional `settings.faq`, added 2026-09-30):** up to 9 questions
  (each ≤ 24 characters — a WhatsApp list row) with an answer page each
  (`*question*\n\nanswer`, buttons More questions / Free demo / Main menu).
  Menu item "❓ FAQ" sits before Contact; typed "faqs"/"doubt" (and "faq" by
  close spelling) open it. Settings without a `faq` key are unchanged.
- **Request tracking:** Free demo / Admission submissions are ordinary
  bookings tagged with `form_key`; `GET /api/bookings?form=demo|admission`
  filters them. The four booking statuses are unchanged on the server — web
  and app only show coaching names for tagged bookings (demo: New / Demo
  fixed / Demo done / Not interested; admission: New / Contacted / Admitted
  / Not joining). "Demo fixed" (= confirmed) moves the customer's pipeline to
  converted, like any confirmed booking — agreed 2026-09-30.
- **Booking codes** are the first two letters of the business's display
  name + 4 digits (e.g. `DA1234`, `SE1234` for Search cab AI), `BK` if the
  name has fewer than two English letters; the 🚕 sign-off stays only for
  travel/cab businesses.

### Visual flow canvas (frontend — `apnabot-web`, not this repo)

`FlowGraphCanvas.tsx` is a fully editable node/edge canvas — node creation,
drag-to-connect for unwired options/single-links, click-to-edit, delete via
trash icon or Delete key. The old List-view tab is gone; canvas + a docked
detail panel (opens on node selection) + a Versions tab (built on the
snapshot endpoints above) are the only editing surface now. This used to be
tracked as a deferred "future initiative" — it's built and live.

## Data model reference

- `businesses` — core tenant table. `business_category` filters which
  category templates the Versions tab offers (no template is applied at
  signup). `disabled_booking_fields`, `served_cities`
  are live per-business config, applied as an OVERLAY at read time by the
  graph engine (never baked into stored flow data).
- `businesses` WhatsApp connection columns: `phone_number_id` (unique),
  `waba_id`, `access_token` (encrypted), `is_whatsapp_connected`,
  `whatsapp_onboarding_type` (`cloud_api` | `coexistence`; NULL for
  businesses connected before 2026-10-05, no backfill),
  `whatsapp_register_pin` (encrypted 2-step-verification PIN used by
  `/register` on the Cloud API path; a secret - never returned to a client),
  `whatsapp_connected_at`, `coex_contacts_sync_requested_at`,
  `coex_history_sync_requested_at`. `is_whatsapp_connected=false` makes the
  tenant resolver treat the number as not live (set by an `account_update`
  webhook; IDs and token are kept so a reconnect can restore it).
- `customers.last_activity_at` (migration `20261009120000`): last chat activity -
  an inbound message, a dashboard reply, or an owner reply from the WhatsApp
  Business app (echo). It decides who is in the inbox and its order
  (`GET /api/messages`). `last_message_at` keeps ONE job: the last inbound
  customer message, which opens the 24h window (also follow-ups, audiences);
  echoes and dashboard sends never move it. Backfilled from `last_message_at`.
- `messages` extras: `sender_type` (`bot` | `human` | `phone_app` - sent from
  the WhatsApp Business app), `is_history_import` (coexistence history rows:
  excluded from `report_response_time_stats`, read, original timestamps),
  `raw_payload jsonb` (Meta's raw message, kept ONLY for inbound
  `unsupported` rows), `meta_message_id` with a **partial unique index on
  (business_id, meta_message_id)** (migration `20261005140000`). Outbound rows
  carry their wamid from 2026-10-05 (before that, none of the first 1,368 did).
- `messages` media columns (2026-10-09): `wa_media_id`, `wa_media_mime`,
  `wa_media_filename` (Meta's media id of a phone-app echo's photo / video /
  PDF - always stored, whether or not the file is downloaded) and
  `media_removed_at` (set when storage cleanup removed the file; `media_url`
  is NULL then and the message keeps its label). See "Owner phone-app media &
  storage cleanup".
- `message_templates` — one row per WhatsApp template. `source` (`app` |
  `meta_sync`), `meta_template_id`, `status` (draft, pending, approved,
  rejected, paused, disabled, deleted), raw `meta_status`, `quality_score`,
  `meta_components` (Meta's components as last synced), `send_support`,
  `last_synced_at`, `meta_deleted_at`, `button_actions` (what a tap on each
  QUICK_REPLY button does; the sync never writes it). Unique per business on
  `meta_template_id` (when set) and on name + language (while unregistered).
- `business_type_templates` — still exists; historically the category
  starting point copied at business creation for the old engine and the
  one-time graph migration. Not read by `createBusiness` anymore now that
  `flow_snapshots` category templates cover that role — worth confirming
  with the user whether this table is still the source SuperAdmin edits
  for anything live, or itself dead weight now.
- **Customer payments = the business's own QR image, recorded by hand.**
  `businesses.payment_qr_url` (R2, uploaded via `POST/DELETE
  /api/business/payment-qr`, JPEG/PNG only — WhatsApp image messages
  reject WebP). Sent as a WhatsApp image + caption from chat (`POST
  /api/messages/send-payment-qr`) and by the advance-payment booking flow
  (`booking.service.js` `createBookingAndConfirmation`, which now returns
  `{text, imageUrl}`; tags the booking `payment_details.requestedVia =
  'advance'`). The owner records payment via `PUT /api/bookings/:id/payment`
  (`payment.service.js` `setBookingPaymentStatus`) — marking an advance
  booking paid also confirms it and WhatsApps the customer. No automatic
  detection: payments go straight to the owner's personal UPI, by design
  (no gateway for ApnaBot to support). Razorpay remains ONLY for
  ApnaBot's own subscriptions/wallet; the Razorpay/UPI payment-link
  endpoints and `payment_link.*` webhook handlers were removed.
  `bookings.payment_link`/`upi_link`/`payment_id`/`razorpay_order_id` are
  left in place, unused.

## WhatsApp/Meta specifics
- Tech Provider status (not Solution Partner) — each client business adds
  their own Meta payment method.
- Redis quota (Upstash free tier, 500k req/month) has been hit twice this
  project — once from BullMQ workers double-running (local + Render
  sharing one REDIS_URL, fixed via `QUEUE_NAMESPACE` prefixing, see
  `src/config/env.js`), and generally from continuous BullMQ polling +
  heavy manual testing. Consider upgrading the Upstash tier before real
  ad traffic starts.

## WhatsApp connection, coexistence, message ids (built 2026-10-05)

State: commits 7380098 .. 1818344 are on origin/main; **a38b3ed (outbound wamid)
and 28a6152 (forward-only statuses) are local only** until pushed. Check Render
for what is actually deployed before assuming.

- **Two onboarding paths, one endpoint.** `POST /api/business/connect-whatsapp`
  (`business.controller.js`, logic in `services/whatsappOnboarding.service.js`).
  Body `{ code, wabaId, phoneNumberId?, onboardingType? }`, camelCase or
  snake_case. The path is derived SERVER-SIDE from the phone-number node's
  `is_on_biz_app` (undocumented by Meta but returned live: true = coexistence,
  false = cloud_api); missing -> the client's `onboardingType` hint (from Meta's
  postMessage event) -> default `coexistence`. **Cloud API path:** `/register`
  with the stored (or newly generated, stored BEFORE the call) 6-digit PIN, only
  while `platform_type` is not already `CLOUD_API` (Meta limits `/register` to 10
  per number per 72h); a register failure returns a clear error (133005 = PIN
  mismatch -> turn off two-step verification in WhatsApp Manager) and the
  business is NOT saved. The signup `code` is single-use, so a failed register
  means re-running Embedded Signup. **Coexistence path:** no `/register`;
  `smb_app_data` contacts + history syncs (each one-time, within 24h of
  onboarding) run after the save, non-fatal, ONLY when
  `COEXISTENCE_SYNC_ENABLED=true` (default off - see below). The old and new
  `tenant:{phoneNumberId}` cache keys are both invalidated.
  **Never verified against a real fresh number yet** - the first Path A test
  (spare SIM) must log the phone node before/after `/register` (the code does).
- **Connect page** (`public/whatsapp-connect.html`, used by Flutter; apnabot-web
  has its OWN copy in `use-whatsapp-signup.ts` and still has no guidance screen
  or `onboardingType`): `featureType: 'whatsapp_business_app_onboarding'` is
  always on; the three guidance cards are advice only. Sends once, when both the
  auth code and both IDs are in (30s timeout); strict `facebook.com` origin check;
  auth `code` redacted from debug payloads.
- **Webhook dispatch** (`webhook.controller.js`): every entry, change and message of
  a POST is processed on its own (`splitMessages` fans out batched messages;
  one failure never drops the rest). History / contact-sync bodies are not
  logged whole (one summary line each); everything else is.
- **Inbound dedupe.** Meta can deliver one wamid more than once (retries, and an
  empty `unsupported` placeholder + the real message, either order, minutes
  apart - seen live on Search cab AI). `services/inboundMessage.service.js`
  decides before any side effect: real over unsupported -> replace the row and
  process once (no second count); unsupported after anything, or a repeat -> ignore;
  23505 from the unique index is handled the same way. Unsupported rows (e.g. error
  131051) show "WhatsApp couldn't show this message here — open it in your WhatsApp
  Business app." (since 2026-10-09; older rows keep the old "ask the customer to
  resend" text, no backfill) and keep `raw_payload` with the real type/error code.
- **Coexistence handlers** (`services/coexistence.service.js`, shapes in
  `utils/coexistencePayload.js`): `smb_message_echoes` (owner's phone messages ->
  outbound `phone_app`, dashboard socket event; revoke/edit skipped),
  `history` (old chats, `is_history_import`, ERROR -> `failed`, declined = code
  2593109), `smb_app_state_sync` (contacts -> customers, never overwrites a
  name, `opted_in` stays false), `account_update` (PARTNER_REMOVED /
  ACCOUNT_DELETED / ACCOUNT_OFFBOARDED -> `is_whatsapp_connected=false`;
  ACCOUNT_RECONNECTED -> true while a token is stored; found by WABA id since the
  events carry no phone number). None reaches the bot, usage, or the outbound
  queue, and none touches `customers.last_message_at` / `total_messages` - those
  drive the 24h window, which only a real inbound customer message may open.
  An echo DOES stamp `customers.last_activity_at` (inbox), so an owner-first chat
  shows up in the inbox without opening the 24h window.
  **Echo auto-pause** (built 2026-10-09, env `ECHO_AUTO_PAUSE`, default false):
  after a NEW (non-duplicate) `phone_app` echo row, an in-process timer fires
  15 s later (lost on restart), re-reads, and pauses the bot 24h (same as a
  dashboard reply, `afterManualSend`) + advances the customer to `contacted` -
  unless a message with the same wamid has `sender_type` `bot`/`human` (an echo of
  something ApnaBot sent; the API row takes the wamid and the echo row is deleted).
  Echoes older than 10 min are skipped; an indefinite pause is never shortened
  (the stage still advances); customers who never messaged are paused too;
  a tenant with `whatsapp_onboarding_type = 'cloud_api'` is skipped, NULL (legacy,
  e.g. Search cab AI) counts as coexistence. One log line per echo:
  `echo auto-pause: wamid .. business .. apiRowMatched yes|no paused yes|no (reason)`;
  a duplicate echo logs `apiRowMatched yes ... (wamid already stored)` - that is how to
  tell from the Render logs whether Meta echoes API-sent messages (unverified).
  Flag off = nothing scheduled, nothing logged.
- **Outbound ids + statuses.** Every send that has a `messages` row saves Meta's
  wamid on it: the BullMQ worker (covers bot replies, dashboard sends, payment
  QR / confirmations) and the template path of `windowAwareSend` (follow-ups,
  demo reminders) via `services/outboundMessageId.service.js`, which never throws.
  If the wamid collides with an echo row (`phone_app`) the echo is deleted and
  the API row kept. Meta's status webhooks therefore now match outbound rows;
  statuses only move forward (sent -> delivered -> read, `utils/messageStatus.js`).
  Sends with no `messages` row (broadcast worker, session-timeout notice, public
  service-form messages, platform notifications) have nothing to update.
- **Delivery tracking, chat messages (2026-10-13).** `messages` has `delivered_at`, `read_at`,
  `failed_at` (Meta's own event time) and `error_code` / `error_title` / `error_details` (Meta's raw
  failure; mapped to plain English on read by `utils/whatsappErrors.js`, whose wording was checked
  against Meta's error-code page - 131030 is not on it, so it is left to the unknown-code default).
  The status webhook builds events (`utils/statusPayload.js`) and applies a whole change in ONE call to
  the RPC `apply_message_statuses(jsonb)`: forward only, `COALESCE` timestamps, `read` also fills
  `delivered_at`, `failed` only for a message never delivered. It returns `{ changed, unmatched }`;
  an `unmatched` wamid (no row at all) gets ONE retry after 2s (`STATUS_RETRY_DELAY_MS`, default
  2000), for the race with the queue worker saving the wamid. The socket `message_status` event now
  carries `customerId`, `deliveredAt`, `readAt`, `failedAt` and `failure` (still no client listens, gap
  14). `GET /api/messages/:customerId` adds `failure` (`{ code, title, reason, kind, details }` or null)
  to each message; the queue worker records Meta's reason when it finally gives up on a send. A body
  of only statuses logs one summary line. Broadcast messages are NOT tracked yet (no per-recipient rows
  - next commit); until then their status webhooks match nothing, so each costs one RPC and one
  retry. SQL check: `supabase/verification/verify_apply_message_statuses.sql` (rolls back, see its header).
- **Flags / Meta dashboard.** `COEXISTENCE_SYNC_ENABLED` (env, default off): turn it on
  only when the history / contact-sync handlers are deployed, or Meta's one-time
  sync is spent and lost. The webhook fields `history`, `smb_app_state_sync` and
  `smb_message_echoes` are NOT yet subscribed in the Meta App Dashboard; subscribe
  them together with the flag, then check the first real echo's stored row.
  Search cab AI is already a coexistence number, so its owner's phone replies
  start appearing in the dashboard the moment echoes are subscribed.
  `ECHO_AUTO_PAUSE` (env, default off) is separate from `COEXISTENCE_SYNC_ENABLED`:
  subscribe `smb_message_echoes`, check the first real echoes in the logs, then
  turn it on. Search cab AI (live) is affected by both the moment they are on.

## Owner phone-app media & storage cleanup (built 2026-10-09)

Commits a506c5b (owner media switch) and 1bc9a8f (storage cleanup). Migrations
`20261009130000_owner_phone_media.sql` then `20261009140000_storage_cleanup.sql` -
apply BEFORE deploying the server.

**Owner phone-app media switch.** Feature key `owner_phone_media` (label
"Save owner's phone-app media") in the normal `category_features` /
`business_features` mechanism: every category, default OFF, per-business
override as usual. Photos / videos / PDFs the owner sends from the WhatsApp
Business app (`smb_message_echoes`) are downloaded to R2 (`echo-media/{businessId}/
{messageId}.ext`, `message_media` socket event, caps 10 / 16 / 10 MB) ONLY while
the switch is on for that business (`echoMedia.service.js`; a failed switch lookup
counts as off). The echo row always stores `wa_media_id` / `wa_media_mime` /
`wa_media_filename`, so with the switch off nothing is downloaded and the row keeps
its label ("Photo"). Customer (inbound) media is unchanged - always downloaded
(`inbound-media/`). **Going live changed behaviour:** owner phone-app media stopped
downloading for every coexistence business (incl. Search cab AI) until its switch is
turned on. (The earlier echo-media commit eddc414 was not in this file before; this
section is its first mention.)
Backfill, superadmin only (`ownerMedia.controller.js`, `ownerMediaBackfill.service.js`):
`POST /api/admin/businesses/:id/owner-media/backfill/preview {days}` ->
`{count, estimatedBytes: null, days}` (reads our database only - no Meta call, so no
size estimate); `POST .../backfill {days}` starts a background job (202; needs the switch
on and a connected number; one job per business; 409 otherwise); `GET .../backfill/status`.
`days` 1-7 (default 7). Rows with `media_removed_at` are never fetched back. Job state is
in memory (a restart drops a running job; rerun it). Expired Meta ids (400 / 404) are
counted `expired` and skipped.

**Storage cleanup (Super Admin).** Removes old R2 files, by hand or by rule.
**Touches R2 and ApnaBot's database only - never Meta / WhatsApp** (enforced by a static
test on the modules' `require`s and a runtime trap test; keep it that way).
- **Files known to R2** (folders `utils/storageKinds.js`): `inbound-media/`, `echo-media/`,
  `business-media/` (library), `template-headers/`, `payment-qr/`, `business-profiles/`,
  `vehicle-photos/`, `vehicle-catalog/`. Anything else in the bucket is ignored.
- **Kinds:** chat_inbound, chat_echo, library, template_header, bot_node_image, payment_qr,
  logo, vehicle_photo, course_image, orphan. A library file's kind comes from what uses it
  (bot node / snapshot > template header > course image > plain library).
- **Classification** (`storageInventory.service.js`): *safe* = a chat file whose message still
  points at it, or an unused library file; *in use* = referenced by `flow_nodes`
  (`image_url` / `media_id`), `flow_snapshots`, a template header, a course
  (`image_media_id`), the payment QR, the profile image or a vehicle photo; *orphan* =
  nothing references it. **Protected - never purged, even with include-in-use:** an image-only
  reply (node or snapshot node with an empty base label: with the image gone it would send an
  empty message, which Meta rejects), a payment QR while `require_advance_payment` is on, a
  shared `vehicle_type_catalog` photo, and anything a category template snapshot
  (`flow_snapshots.is_category_template`) uses ("used by category template").
- **Flow:** preview (writes nothing) -> `POST /runs` marks the selection (`storage_cleanup_runs` +
  `storage_cleanup_items`, status `pending`, `pending_delete_at` = now + 24h) -> cancel until
  then -> the sweeper purges. Files already in an open run are not marked twice. Typed
  confirmations, checked server-side: in-use files need the business's exact name (one business,
  never with "all"); "all businesses" needs `DELETE ALL BUSINESSES MEDIA`. Filters: kinds, IST
  from / to (inclusive), business or all, minBytes, includeInUse. Max 50,000 files per run.
  `storage_cleanup_items` is also the audit trail / CSV (`GET /runs/:id/export.csv`).
- **Sweeper** (`storageCleanupSweeper.service.js`; `server.js`, in-process timer every 15 min,
  first run 2 min after start; **env `ENABLE_STORAGE_SWEEPER`, default off** - keep it off
  everywhere but the production server, it deletes files): claims due items atomically
  (`claim_storage_cleanup_items`, `FOR UPDATE SKIP LOCKED` + `claimed_at`); re-checks every item
  against the database as it is NOW (something safe at marking may be in use today -> status
  `skipped_in_use`); clears DB references FIRST, then deletes from R2 (batches <= 1000 keys);
  a failed item keeps its `error` and is retried (<= 5 attempts, >= 15 min apart); the run ends
  `done` or `failed`. Purge effects: `messages.media_url` -> NULL + `media_removed_at` (message,
  label and row kept); library row deleted + `storage_used_bytes` decremented (once); bot node
  `image_url` / `media_id` nulled (the reply goes out as text only) and the business's cached
  reply nodes (`flow:{businessId}`, 1h TTL) invalidated; template `header_media_*` /
  `header_image_*` cleared and `send_support` recomputed locally (template rows are never
  deleted); stored copies in personal flow snapshots stripped of the image (so a restore can't
  bring back a dead URL); course image, payment QR, profile image, vehicle photo fields nulled.
  Never deleted: messages, templates, flow nodes, snapshots.
- **Automatic retention.** `platform_settings` row `chat_media_retention_days` (NULL = off, min 7) +
  `businesses.chat_media_retention` (NULL = follow the platform, `'never'`, or days). Applies ONLY
  to chat_inbound / chat_echo. Once per IST day (unique `automatic_day`) a tick creates a normal run
  (`is_automatic`, same 24h pending window, visible and cancellable in Runs). Age = R2 last-modified.
- **Orphan scan** (background job, in memory): unreferenced objects older than 48h in the known
  folders -> a normal `pending` run of kind `orphan`; needs the all-businesses phrase; items are
  re-verified as still unreferenced at purge time.
- **Endpoints**, all superadmin, `/api/admin/storage-cleanup/*`: `GET /summary`, `POST /preview`,
  `POST /runs`, `GET /runs`, `GET /runs/:id`, `POST /runs/:id/cancel`, `GET /runs/:id/export.csv`,
  `POST /orphan-scan`, `GET /orphan-scan` (status), `GET|PUT /settings`, `PUT /businesses/:id/retention`.
  Manual script: `src/scripts/storageCleanup.js` (dry run by default; `--confirm` needs `--run <id>`).
  **Never `--confirm` against Search cab AI**; an all-businesses run can include its files - check
  the run's CSV before the 24h window ends.
- **Not built yet:** the Super Admin UI (storage page, runs list, retention settings, the owner-media
  backfill panel) - server only so far. The claim SQL and migration were exercised only through an
  in-memory model in tests, not against a real Postgres / R2: dry-run on a test database first.

## Marketing consent: opt-in links and the post-booking question

Customers opt in to marketing in three ways besides the owner's manual toggle and contact import.
(`customers.opted_in` / `opted_in_at` / `opt_in_source`; STOP sets `opted_out_at` and pauses the bot
24h, START clears it; broadcasts and follow-ups skip `opted_out_at`. A UTILITY-template broadcast
does not need `opted_in` at all - see "Broadcast audiences"; follow-ups have their own
`message_category` rule.)

- **Opt-in links** (`opt_in_links`, `opt_in_link_events`, feature `opt_in_links`, migration
  `20261003180000`): a wa.me link / QR whose message carries `JOIN-<code>`; Step 11.7 of the webhook asks
  Yes/No (`optin_yes:<linkId>` / `optin_no:<linkId>`, `optInLink.service.js#handleConsentTap`), and a
  Yes sets `opt_in_source = 'opt_in_link'` (and clears `opted_out_at`). *Added to the PRD late, on
  2026-10-11; it was built 2026-10-03/04.*
- **Post-booking question** (built 2026-10-11, migration `20261011120000`): after a booking
  confirmation is sent, ONE Yes/No question per customer, ever - `bookingConsent.service.js`.
  Gate: `businesses.ask_consent_after_booking` (default off; read uncached with `getBusinessById`;
  settable via `PUT /api/business` as `askConsentAfterBooking`). Three send sites: the graph
  booking's last answer and the immediate-confirm booking (`webhook.controller.js`), and the web
  form submit (`publicServiceForm.controller.js`, which also requires the 24h window to be open).
  Skipped for: already opted in, `opted_out_at` set (we never ask after a STOP), blocked, bot paused,
  already asked, and an advance-payment confirmation (the payment-QR image). **Ordering:** the
  customer is claimed atomically first (`customers.consent_prompted_at`, update ... where it is
  null); only a claimed booking sends its confirmation with `addToWhatsappQueueAndWait`, then the
  question; every other booking runs exactly the old `addToWhatsappQueue` call. A claim error is
  caught and logged - the confirmation always goes out. **Taps:** `optin_yes:booking` /
  `optin_no:booking` (`parseOptInTapId` returns `bookingPrompt: true`), handled at Step 11.7 by
  `handleBookingConsentTap` and always returned from (no greeting menu). The result is stored once
  in `customers.consent_prompt_result` ('yes'/'no'; a repeat tap is ignored). Yes sets
  `opt_in_source = 'booking_prompt'` only `where opted_out_at is null and opted_in = false` - it
  never clears `opted_out_at`; then `optInConfirmed`. No sends `bookingConsentDeclined`. Texts:
  `bookingConsentQuestion`, `bookingConsentDeclined` (en/hi/mr). Stats: `GET /api/customers/summary`
  gains `consentAsked`, `consentYes`, `consentNo` (all time). **Not built:** the web / Flutter
  Settings toggle, the stats cards, and the "Opted in (booking prompt)" label in the web
  `optInLinks.ts` - until then the setting can only be switched via the API.
  **Live-path note:** with the setting off (default) the confirmation path sends exactly what it
  sent before (one extra uncached business read per booking); the behaviour change happens when an
  owner switches it on for a business. Search cab AI uses these paths.

## Known gaps / deferred work

1. **Local Rental / no-rental-packages-configured detour.** The mechanism
   is still implemented (`bookingGraph.service.js`'s `advanceGraphSession`:
   when a live `rentalPackage` lookup comes back empty, the session is
   redirected to the primary `dropLocation` node instead of skipped
   forward — an approximation of the old engine's splice-based behavior,
   not an edge-condition-native solution). **Not currently exercisable
   against live data**, though: SG Travels' flow was rebuilt from scratch
   on 2026-08-30 with only "One Way"/"Round Trip" as `tripType` options —
   confirmed live 2026-09-02, no `rentalPackage` node exists for this
   business at all. `verifyBookingGraph.js`'s Local Rental branch was
   dropped for the same reason (no real conversation path to script it
   against). Re-add/re-verify if Local Rental is rebuilt into a live flow.
2. **`distance_estimate` carousel branch** — verified in the graph engine
   via a seeded Redis cache entry (no `GOOGLE_MAPS_API_KEY` in dev). Real
   Google Distance Matrix calls untested end-to-end against the graph
   engine.
3. **`business_type_templates`'s current role is unclear** — see Data
   model reference above; not investigated this pass.
4. ~~**Per-business feature switches**~~ — built 2026-10-02:
   `business_features` (migration `20261002120000_business_features.sql`)
   holds an optional per-business override that wins over the
   `category_features` switch (no row = follow the category; only for
   features that apply to the business's category). Set from Super Admin →
   Businesses → <business> → Features (`GET/PUT
   /api/admin/businesses/:id/features[/:feature] { override }`); checked by
   `categoryFeature.middleware.js` via `categoryFeature.service.js#isEnabled`.
5. **Bot Builder v1 limits:** at most 10 courses shown (no course groups
   yet), no brochure button, no preview chat for an unpublished draft,
   English-only generated text.
6. **Webhook first-message vs contact-import race (deferred 2026-10-04).**
   `upsertCustomerForInboundMessage` (`webhook.controller.js`) is
   read-then-insert. If a contact import (`import_contacts` RPC) inserts the
   same number in the milliseconds between that read and insert, the
   webhook's insert hits the `(business_id, whatsapp_number)` unique
   violation (23505) and that one inbound message isn't processed. Fix =
   catch 23505 there and re-select; deferred because it touches the live
   webhook path for a millisecond-wide window.

7. **Template edits in WhatsApp Manager aren't picked up until a manual sync
   (backlog, 2026-10-05).** The send-time re-check only sees the stored row.
   Later: subscribe the Meta app to `message_template_components_update` and
   trigger a per-business sync (`templateSync.service.js#runSync`) from that
   webhook.

8. **Meta error 131050 (user stopped marketing messages) doesn't set
   `opted_out_at` (backlog, 2026-10-05).** A broadcast / follow-up send that
   Meta refuses with 131050 is only counted as failed; the customer stays
   eligible and is retried next time. Later: set `customers.opted_out_at` from
   the broadcast worker / follow-up sender on that code. (From memory of Meta's
   docs, unverified - confirm the code against a real refusal first.)

9. **BSUID / usernames (backlog, 2026-10-05).** Meta sends a business-scoped
   `user_id` (contacts[].user_id, `from_user_id`) on messages/status webhooks and
   omits `wa_id` for a username user with no interaction in 30 days. We key
   `customers` on `from`. Plan: `customers.user_id`, look up by either, handle
   `user_id_update`; sending uses `recipient` instead of `to`. Echo / history /
   state_sync payloads do not document `user_id` - confirm on real ones.
10. **Centralise accessToken stripping (backlog).** Each controller deletes
   `accessToken` / `whatsappRegisterPin` from a business before responding
   (`business.controller.js`, `admin.controller.js`); only the PIN is also stripped
   centrally (`attachTravelSettings`). One serializer so a future endpoint can't leak.
11. **verifyBookingGraph.js** crashes on Averix Solutions (PGRST116, a `.single()`
   matching 8 rows - check the same pattern isn't on a live path) and fails on
   Internet Cafe Katta (script ignores a flow that is done at start; no live impact).
12. **Owner-initiated phone chats are not in the inbox.** The inbox lists customers
   with `last_message_at` set, and echoes deliberately don't set it (24h window).
   Planned: a separate inbox-only `last_activity_at`.
13. **Reports.** `report_response_time_stats` counts `phone_app` replies as human
   (filter is `sender_type <> 'bot'`) and excludes `is_history_import` rows.
14. **Clients don't listen for `new_message` / `message_status`.** apnabot-web only
   uses the socket for "who is viewing"; both apps refresh on focus / pull-to-refresh.
15. **Webhook body logging.** `receiveWebhook` still prints the whole body (phone
   numbers, message text) to the logs for everything except history / contact sync.

16. **Storage cleanup UI + real-database check (2026-10-09).** Server side is built; the Super
   Admin screens are not, and the migration / `claim_storage_cleanup_items` have not run against
   a real database. A summary / preview scans R2 in the request (capped at 200k objects).
17. **Owner-media backfill panel + job persistence (2026-10-09).** Backfill job state is in memory;
   the Features screen has no backfill panel yet.
18. **Supabase version of `rotateEncryptionKey` (encryption key rotation).** The old script
   (re-encrypting stored access tokens with a new `ENCRYPTION_KEY`) was Mongo-only and was deleted
   in the MongoDB cleanup; no replacement exists yet.

## Session log (append here as major milestones land)
- 2026-10-13: Delivery tracking, commit A (chat messages only; see "Delivery tracking, chat
  messages"). **Deploy: apply migration `20261013120000` first, then run
  `supabase/verification/verify_apply_message_statuses.sql` in the SQL editor, then deploy the server.**
  One-time cutover with no flag: the status webhook moves from a per-status UPDATE to the RPC for every
  business the moment the server deploys, so if the migration is missing every status update fails
  (logged, nothing thrown; messages stay at 'sent'). Search cab AI takes the same path.
- 2026-10-12: Broadcast audiences: UTILITY templates no longer need marketing opt-in (`opted_out_at`,
  blocked and number checks still apply; MARKETING / AUTHENTICATION / unknown stay strict). Optional
  `templateId` on audience-count / summary / skipped; category-aware empty-audience message.
  **Deploy: apply migration `20261012120000` (either order works - old 3-argument calls resolve to the
  new functions with the marketing rule), then run `checkAudienceParity.js` on a real business.** Live-path
  note: `sendBroadcast` changes for every business the moment the server deploys (no flag), but only a
  UTILITY-template broadcast behaves differently; every MARKETING send is byte-for-byte the same query.
- 2026-10-11: Post-booking marketing-consent question (server only; see "Marketing consent").
  **Deploy: apply migration `20261011120000` first.** Default off per business, so deploying
  changes nothing customer-facing until a business's `ask_consent_after_booking` is switched on.
- 2026-10-09: Owner phone-app media switch (`owner_phone_media`, default off - echo media
  stopped downloading until switched on; `wa_media_id` always stored; 7-day superadmin backfill)
  and storage cleanup (manual / orphan / automatic chat-media retention runs, 24h pending,
  sweeper behind `ENABLE_STORAGE_SWEEPER`, protected image-only / advance-payment QR / category
  template files). Commits a506c5b, 1bc9a8f. Details: "Owner phone-app media & storage cleanup".
- 2026-10-07: Broadcast audience builder, phase 1 (server only; web, test send,
  paste-numbers and scheduling are later phases). In order: atomic claim in
  `sendBroadcast` (fixes a double-send/double-debit race) -> id lookups chunked
  at 200 (the old 500 failed on the hosted project, so groups / coaching
  audiences above ~380 customers threw) -> `customers` + `segment` audiences,
  invalid-number filter, audience summary / skipped endpoints, SQL functions,
  customer `ids` / `tags` / `?tags=` -> contact-group id lookups chunked the
  same way. **Deploy: apply migration `20261007120000` first**, then run
  `checkAudienceParity.js` on a real business, then deploy the server. Live-path
  note: the claim, the number filter and the chunk size apply to EVERY business
  (Search cab AI included) the moment the server deploys — no flag; the new
  audience types and endpoints stay unused until the web ships.
- 2026-10-05: WhatsApp onboarding paths + coexistence + message ids (see the
  section above). In order: migrations (`20261005130000` columns / sender_type /
  history flag, `20261005135000` raw_payload, `20261005140000` unique index) ->
  inbound dedupe (8ad67eb, after `dedupeMessages.js` removed 16 duplicate rows)
  -> connect page (beeb282) -> connect-whatsapp endpoint (7ea5893) -> webhook
  loop over entries/changes/messages (1739541) -> coexistence handlers (1818344)
  -> outbound wamid (a38b3ed) -> forward-only statuses (28a6152). Live-path notes:
  Search cab AI is affected by every webhook change; the tenant resolver now also
  requires `is_whatsapp_connected=true` (all three live numbers were true when
  checked). Still open: first real Path A test (spare SIM), subscribing the three
  Meta webhook fields + `COEXISTENCE_SYNC_ENABLED`, apnabot-web / Flutter changes.
- 2026-10-05: Quick-reply buttons on templates (#6 Phase 4, three commits,
  not yet deployed). **4a (inbound, a105a61):** a customer tapping a template
  quick reply arrives as message `type: 'button'` `{ payload, text }` -
  previously saved as an empty bubble and dropped, now shown as the label and
  routed (`utils/templateButtonTap.js#decideTap`,
  `services/templateButtonTap.service.js#resolveButtonTap`, wired into
  `webhook.controller.js`). Payloads we send are `tpl:<templateId>:<index>`;
  the action comes from `message_templates.button_actions` (`[{ index, text,
  action }]`, an entry applies only while index AND text still match) -
  `{ type: 'keyword', keyword }` (as if typed), `{ type: 'node', nodeId }` (a
  reply node, incl. booking_trigger, or a question node via the
  directBookingEntry path), `{ type: 'menu' }` (= "hi"), `{ type: 'optout' }`.
  An unknown payload (Manager-made template, another business's tpl: id) is
  treated as typed text of the button's label. Opt-out = an optout action OR
  payload/text in {stop, unsubscribe, stop promotions, stop promotion, opt out}
  and reuses the STOP block (opted_out_at + 24 h pause + reply), so it works
  while paused and mid-booking. Any other tap mid-booking re-sends the pending
  question (never a booking answer); a customer with no language gets the
  business's first enabled language (no picker). Migration
  `20261005120000_message_templates_button_actions.sql` (apply BEFORE
  deploying; the inbound routing tolerates the column missing, the API that
  writes it does not). No feature switch: no business had a quick-reply
  template or an inbound button message in the last 90 days (checked
  2026-10-05, incl. Search cab AI). **Over-limit fix (c4c8135):** STOP / START
  and opt-out taps are now processed (and confirmed) even when the business is
  over its usage limit; every other over-limit message is still saved but gets
  no reply and isn't counted. **4b (send + create):** QUICK_REPLY is in
  `SENDABLE_BUTTON_TYPES`; `buildTemplateComponents` adds a `quick_reply`
  component with the payload per quick-reply button, merged with URL buttons in
  index order (`index` = position among ALL buttons); the broadcast controller
  passes `quickReplyComponents` in the job data so the mapped-broadcast worker
  (which rebuilds components per recipient without a template row) keeps them.
  `POST /api/message-templates` accepts `{ type: 'QUICK_REPLY', text, action? }`
  (≤3 buttons in all, text ≤25, quick replies grouped before or after the
  URL / phone buttons; a node action must be a reply / question node of the
  business); `PUT /api/message-templates/:id/button-actions { actions: [{
  index, action }] }` (owner / superadmin) sets or clears actions on any
  template incl. synced ones (replaces the whole list). A button with no action
  acts on its label. `src/scripts/recomputeSendSupport.js` (dry run by
  default, `--confirm` writes, only where the stored value is unchanged)
  rewrites stored `send_support` after a rule change - a dry run on
  2026-10-05 found nothing to change (6 templates). Open: Meta's own "Stop
  promotions" button has not been captured live (detection is by label, see
  above); localized labels are unknown.
- 2026-10-05: Create templates with media header, footer, language and
  buttons (#6 Phase 3, built, not yet deployed; no migration). `POST
  /api/message-templates` takes `language` (en_US | hi | mr), `header
  { type: NONE|TEXT|IMAGE|VIDEO|DOCUMENT, text?, textSample?, mediaId? }`
  (`mediaId` = a `business_media` file, required for media headers),
  `footerText`, `buttons` (≤3: URL `{ text, url, dynamic?, example? }` — dynamic
  = one trailing `{{1}}` + example; PHONE_NUMBER `{ text, phone }` E.164; no
  QUICK_REPLY until Phase 4 - see the Phase 4 entry above). The full components are stored in
  `meta_components` (same shape as synced templates) with `header_media_*` set
  and `send_support` computed, so the template is sendable once approved.
  Validation is shared (`utils/templateValidation.js`, run at create and
  again at submit); `utils/templateBuild.js` builds components / the Meta
  payload; `services/templateSubmit.service.js#submitTemplateToMeta` is the one
  submit (used by `submitMessageTemplate` and `demoReminderTemplate.service.js`,
  demo payload unchanged). Media headers go through Meta's resumable upload
  authorised with the BUSINESS access token (verified live on SG Travels
  2026-10-05 with `src/scripts/testTemplateHeaderUpload.js`: handle OK, create
  PENDING; leftover test template `apnabot_header_test` on that WABA). The
  upload's mime type comes from the file extension. `upload-header-image` and
  `headerType`/`headerImageUrl` are deprecated but still work. Not
  checked here (left to Meta's review): variables separated only by a space,
  variable-to-text ratio, content policy.
- 2026-10-05: Send media headers + URL buttons (#6 Phase 2, built, not yet
  deployed). Every template send builds its Meta `components` through
  `utils/templateComponents.js#buildTemplateComponents` (broadcast controller +
  worker, `windowAwareSend` → follow-ups / demo reminder). Header media
  (IMAGE jpg/png, VIDEO mp4, DOCUMENT pdf + filename) is sent as a public R2
  link from `message_templates.header_media_url` (fallback `header_image_url`
  for IMAGE); attach it with `PUT /api/message-templates/:id/header-media
  { mediaId }` (a `business_media` file; size caps image 5 MB / video 16 MB /
  pdf 10 MB). A TEXT header with one variable and dynamic URL buttons
  (`{{1}}` suffix) are filled from mapping entries with `target: 'header' |
  'button'` (+ `buttonIndex`) — body entries are unchanged
  (`utils/templateMapping.js`). Static / phone buttons need nothing; quick
  reply buttons became sendable in Phase 4 (see above); copy code, flow,
  catalog and OTP stay `unsupported_component`.
  `utils/templateSendSupport.js#computeSendSupport` is the one sendability
  rule (sync, header-media endpoint, and re-run at send time inside
  `isTemplateUsable` / the follow-up sweep, which skips with
  `template_<send_support>`, `template_mapping_mismatch` or
  `template_value_missing`). Follow-ups no longer filter to body-only
  templates. Chat record of a template send: media header → message
  `type` image/video/document + `media_url`; buttons → `[label]` lines under
  the text. Migration `20261005110000_message_templates_header_media.sql`
  (**must be applied before the server code is deployed**). The business-media
  delete endpoint now refuses a file used as a template header.
- 2026-10-05: Template sync from WhatsApp (#6 Phase 1) —
  `POST /api/message-templates/sync` (owner/superadmin, 1 per business per
  60 s, in memory) pulls the WABA's templates into `message_templates`
  (`services/templateSync.service.js`; also auto-runs once after
  `connectWhatsapp`; `src/scripts/syncTemplates.js --business <id>` is the
  dry-run / `--confirm` script). Meta wins on status, category, rejection
  reason, quality and components for any row with a `meta_template_id`; our
  own `header_image_url` is never overwritten. AUTHENTICATION templates are
  skipped. A stored template missing from a COMPLETE listing is soft-deleted
  (`status='deleted'`, `meta_deleted_at`; un-deleted if it returns) — never
  on a partial/failed listing, and never when Meta returns an empty listing
  for a business that has registered templates (`emptyListingSkipped`).
  New `message_templates.send_support` (`ok | needs_header_media |
  unsupported_named_params | unsupported_component`): broadcasts,
  follow-ups and `sendWindowAwareMessage` use only `status='approved'` AND
  `send_support='ok'` (`utils/templateStatus.js#isTemplateUsable`). Webhook:
  `message_template_quality_update` and `template_category_update` handled
  (subscribe both fields in the Meta app dashboard), and the name-fallback
  status update is now scoped by the event's WABA (`entry.id`)
  (`services/templateWebhook.service.js`). Migration
  `20261005100000_message_templates_sync.sql` (**must be applied before the
  server code is deployed**; aborts safely if its unique indexes would
  fail). Phase 0, same push window: one Graph API version via
  `GRAPH_API_VERSION` (default v25.0, `config/graphApiVersion.js`).
  Live-path note: the webhook change affects every business including
  Search cab AI. Phases 2-4 (send media headers / URL buttons, create with
  media / buttons, inbound button routing) are not built.
- 2026-10-04: Help Center support endpoints (public, no auth) —
  `GET /api/public/app-config` (`{ helpBaseUrl, helpLanguages }`, from
  optional `HELP_BASE_URL`, default `${FRONTEND_URL}/help`, cached 5 min)
  and `POST /api/public/help-feedback` (`{ slug, locale, helpful }` → 204,
  10/min/IP `helpFeedbackLimiter` on top of `globalLimiter`) into the new
  `help_feedback` table (migration `20261004150000_help_feedback.sql`,
  **must be applied before the server code is deployed**).
- 2026-09-30: Coaching request tracking — `bookings.form_key/form_title/
  field_labels` (migration `20260930120000_bookings_form_meta.sql`, **must
  be applied before the server code that writes it is deployed**), coaching
  status names + request filter on web and app, answers shown with their
  question labels. Also: "Try your bot" draft chat for Bot Builder
  (`/api/bot-settings/preview-message`, shared `matchNodeInList`).
- 2026-09-29: Course pre-selected in coaching forms — new
  `booking_form_tokens.source_node_id` (migration
  `20260929150000_booking_form_tokens_source_node.sql`, **must be applied
  before the server code that writes it is deployed**) + `prefill` in the
  public form GET. Web-form booking links documented (new section above).
- 2026-09-29: Coaching Bot Builder + Courses — settings-driven bot
  (`business_bot_settings`, FlowSpec v2), Super Admin course catalog
  (`course_catalog`, 12 seeded) → per-business `business_courses`,
  service-form "Course list" dropdown source, booking-code prefix from the
  business name (🚕 only for travel), web-form replies shown in the flow
  preview chat, and a per-category Super Admin feature switch
  (`category_features`, replacing `ENABLE_BOT_SETTINGS`). Per-business
  switches deferred (Known gaps #4).
- 2026-09-29: AI flow generation Phase 1 (no LLM), behind
  `ENABLE_AI_FLOW_GEN` (default off) — see its section above. The core of
  `saveFullGraph` plus the shared validators/`assertGraphStillValid` moved
  verbatim to `src/services/flowGraph.service.js`; the canvas `PUT /full`
  handler is now a thin wrapper. Verified identical by an old-vs-new
  harness (2,613 payloads over all live businesses' real graphs, same
  status/body/RPC args/cache deletes). Applied to CareWell Clinic
  (`medical`) end to end: its previous 12-node flow is saved as snapshot
  "Before AI flow — Sep 29, 2026"; `verifyBookingGraph.js` now passes
  against CareWell (it previously crashed — no `booking_trigger`).
  CareWell has no `phone_number_id` yet, so it isn't reachable on WhatsApp.
- 2026-09-28: Inbound message storage fixes (webhook.controller.js).
  `messages.content` now holds the tapped button/list TITLE (matching still
  uses the id) or a media placeholder ("📷 Photo: caption", "📄 file.pdf",
  "🎤 Voice message", "📍 Location"). Migration
  `20260928120000_messages_type_all_whatsapp_types` widens
  `messages_type_check` — `location`/`sticker`/`video`/`contacts`/`reaction`
  inbound messages previously failed the insert (23514) and were dropped
  entirely, so a `location_request` booking field could never be answered;
  unknown future types are saved as `unsupported`. Customer photos are
  copied Meta → R2 (`inbound-media/<businessId>/<messageId>`) in the
  background and set `media_url` (not counted against storage_used_bytes).
- 2026-09-28: Customer payments switched from Razorpay/UPI payment links
  to the business's own QR image + owner-recorded payment (see Data model
  reference). Migration `20260927130000_businesses_payment_qr_url`. Payment
  links collected into ApnaBot's own Razorpay account (not the
  business's), and UPI intent links to personal VPAs are declined by
  PhonePe/GPay — hence the switch.
- 2026-09-02: Averix Solutions deleted and recreated as a second QA test
  business, `business_category='travels'` (business_id
  `014a3f2a-6a32-4c44-82df-ec6a298a2caa`, replacing the old
  `6e918384-2a7e-4342-8ab4-2b9cecbe791d` / `software_it` row) — deliberate,
  for the canvas/booking-flow test plan, not a bug. This broke
  `verifyBookingGraph.js`'s `.eq('business_category', 'travels')
  .maybeSingle()` business lookup (PGRST116, 2 rows returned) since
  category is no longer unique per business; fixed by making business
  selection explicit (`--business=<id>` / `BUSINESS_ID` env var,
  defaulting to SG Travels) instead of category-derived.
- 2026-09-02: PRD.md rewritten to reflect single-engine reality — every
  claim in this rewrite (table drops, business ids, entry-node wiring,
  flow_snapshots schema/row counts, Averix's `booking_engine`) verified
  directly against the live database and current `src/`, not assumed from
  the previous version of this doc.
- 2026-09-01/09-02: Legacy feature removal completed in three passes, all
  applied to the live DB (confirmed via `supabase migration list`):
  `660d5b9` removed the old engine's dashboard CRUD surface (graph-only
  from here on); `0e747b9` dropped `flow_packs`/`business_saved_flows`/
  `business_flows` (superseded by `flow_snapshots`); `cf12cab` dropped the
  numbered-menu feature and the `rules` table itself.
- 2026-09-01: `f6be085` — `flow_snapshots` Phase 1 built: personal
  versioning + category starter templates, nullable `business_id` +
  `category`/`is_category_template` columns, `/api/flow-graph/snapshots`
  and `/api/admin/category-templates` routes.
- 2026-09-01: SG Travels' "book" entry-node bug found and fixed same day
  (`132c41a`) — the `booking_trigger` reply node's outgoing edge targeted
  `pickupLocation` directly, skipping `tripType`, so every live booking was
  silently priced as One Way. Fixed via
  `src/scripts/fixSgTravelsTripTypeRouting.js` (dry-run/--confirm gated,
  executed with --confirm) retargeting the edge to `tripType`. Found while
  reworking `verifyBookingGraph.js` (`00fb2ee`) to assert against expected
  values instead of diffing the now-deleted old engine — the old
  diff-based version could never have caught this since it compared graph
  output against the same broken assumption on both sides.
- 2026-08-31: Averix Solutions flipped to `booking_engine='graph'`
  (`ed1463e`, one-time cutover script, dry-run verified flow_nodes/
  flow_edges were empty before writing) — confirmed live 2026-09-02, along
  with `9ed8242` guarding `bookings.customer_id` against a null insert
  (`createBookingAndConfirmation` now throws before inserting if no
  matching `customers` row exists, and `webhook.controller.js` sends a
  fallback WhatsApp message + logs on that failure instead of leaving the
  customer without a reply).
- 2026-08-30: SG Travels' full travels booking flow (welcome menu →
  tripType branching → full question chain → real `vehicle_carousel` with
  live fares → booking complete) rebuilt from scratch through the graph
  engine editor and **CONFIRMED WORKING END TO END ON REAL WHATSAPP
  TRAFFIC**. Three real bugs found and fixed during the rebuild:
  - **Reply-node → question-node send failure** (`ba80518`) — a button/
    list wired straight from a reply node to a question node resolved its
    WhatsApp interaction id via the target node's `keyword`, which only
    exists on reply nodes; sent as `null`, Meta's schema validator
    rejected it. Fixed by always using `edge.id` as the interaction id
    outbound, and resolving inbound taps structurally (`resolveTappedEdge`)
    instead of re-running keyword matching.
  - **Missing `{{customerName}}` substitution** (`65cb2e5`) —
    `applyMessageTemplate` only ever substituted `{{businessName}}`;
    `{{customerName}}` passed through literally. Fixed by threading
    `customer` into every call site and adding the substitution (falls
    back to "there"). Also fixed `booking_trigger` labels skipping
    `applyMessageTemplate` entirely.
  - **travelDate display-value overwriting the raw match value**
    (`f9e55ba`, `bb7a69b`) — `session.collected`'s stored value for a
    field was being overwritten with its display-formatted string *before*
    edge-condition matching ran against it, so a travelDate edge condition
    silently failed to match and fell through, completing bookings early
    with the wrong branch taken. Fixed the ordering bug and added
    diagnostic logging on wired-edge condition-match failures generally
    (to surface this class of silent bug going forward).
- 2026-08-29: Both test businesses (SG Travels, Averix) wiped and
  recreated fresh via the real signup flow, directly on
  `booking_engine='graph'` — see business ids at the top of this doc.
- 2026-08-29: `flow_nodes`/`flow_edges`/`flow_snapshots` graph engine
  built, wired into `webhook.controller.js`, confirmed working on real
  WhatsApp traffic for SG Travels. `businesses.booking_engine` column
  added; graph-engine CRUD (`/api/flow-graph`) built end to end with full
  structural safety (`flowGraphValidation.js`), live-tested against SG
  Travels' real graph including deliberate break-it-on-purpose cases
  (cycles, orphaning retargets/deletes, reserved fields, computed nodes).
- 2026-08-29: Redis queue namespace fix (`QUEUE_NAMESPACE` prefixing) —
  prevents local/prod BullMQ worker collision.
