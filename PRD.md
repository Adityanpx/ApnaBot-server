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
- Booking tap guard (`utils/bookingTapGuard.js`, webhook Step 12 + `flowGraphPreview.controller.js`): a tap on a
  free-text question, a stale / option-less tap on a choice question, and a catalogue or template-button tap
  mid-booking are re-asked with a hint ("type your answer" / "tap one of the options", both with "send *menu* to
  leave"; `bookingTapHintText` / `bookingTapHintChoice`) and never stored; the engine also rejects internal ids
  (uuid, `{node}:{n}`, `cat:`, `lang_`, `optin_`) as typed answers.
- System messages for gu kn ta te ml bn pa or (`utils/systemMessages.js`): lookup is native-reviewed
  (`src/i18n/systemMessages.<lang>.js`) -> **machine** (`src/i18n/systemMessages.<lang>.machine.js`, Azure
  Translator, header "MACHINE-TRANSLATED", NOT native-reviewed, generated 2026-10-28 via
  `exportSystemMessagesForReview.js --confirm` + `importReviewedSystemMessages.js --source=machine --confirm`)
  -> English. `PROTECTED_TERMS` (ApnaBot, WhatsApp, UPI, OTP, Razorpay, menu, STOP, START) stay as typed; a
  translation that loses a placeholder, bold span or protected term is dropped (2 left: `qrHowTo` in ta and bn,
  still English). `isFaithful` counts bold that wraps only a placeholder (`*{{code}}*`) as a span. The consent
  texts (opt-in question / confirmation, STOP and START replies, booking consent, Yes/No buttons) were
  hand-corrected in the CSVs and are still marked machine for native review; the START reply is now the system
  message `startOptInDefault` (it was a hardcoded English string). Machine files must have no placeholder glued
  to a word and no Latin/Indic mixed word (tested). `exportSystemMessagesForReview.js --keys=a,b --confirm`
  re-translates only those keys where a language has no text, keeping the rest of the CSV. A later native review
  imports its CSV normally; reviewed keys override machine ones. The followup default texts pick up these
  machine translations too.
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
  present when set; `formTitle` = the page header: a published Bot Builder
  form's title ("Book a free demo class" / "Admission form", with
  `formSubtitle`), else the node's own form name `flow_nodes.form_title` in
  the customer's language (`form_title_translations`, no subtitle) —
  `resolveFormTitle`, `utils/formTitle.js`); `POST /service-form/:token/submit { values }`;
  travel helpers `GET .../vehicle-options`, `POST .../places-autocomplete`,
  `POST .../place-details`, `POST .../vehicle-quote`. Expired → 410, used →
  410, unknown → 404.
- **Submit:** checks required fields and option values (a course-list
  value must be a current course), creates the booking via
  `bookingService.createBookingAndConfirmation` (saving `bookings.form_key` /
  `form_title` — "demo"/"Free demo", "admission"/"Admission" for a published
  Bot Builder form; else `form_key` null and `form_title` = the node's
  English `form_title` (null if unset) — and `field_labels` `{fieldName: label}`, all
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
  Template clone/import strips source-business media_id, our-R2 image_url,
  image_removed_at and per-node location pins; importing businesses set their
  own images/pins.
- **Signup does NOT seed a template** (corrected 2026-09-29 — this file
  previously said it did). `business.service.js#createBusiness` gives every
  new business a literal empty graph; importing a category template is an
  explicit owner action from the Versions tab (`import-category-template`).
- `POST /api/flow-graph/snapshots/start-blank` wipes the live graph to empty
  (owner action, unsets every snapshot's `is_active`).

Row counts are not tracked here (the old "table is empty as of
2026-09-02" note was stale — e.g. CareWell Clinic has had a personal
snapshot since 2026-09-29's AI-flow test). Query `flow_snapshots` directly.

### Copy setup (SuperAdmin, built 2026-10-11)

`POST /api/admin/businesses/:id/copy-setup` `{ source: { type: 'business'|'template', id }, include: { flow, serviceForm }, dryRun }`
copies a same-category business's (or an active category template's) auto-reply
flow and/or service form (`businesses.flow_fields`) into business `:id`. Cross-category,
same source/target and inactive templates are rejected. **`dryRun` defaults to true** —
only an explicit `dryRun:false` writes; the dry run returns `{ source, target, willCopy,
warnings }` and the apply adds `applied: true`.

- **Copies:** all nodes/edges (fresh ids, `trigger_count` 0, per-node `form_fields` kept)
  and, for a business source, `flow_fields`. A template has no service form: that part is
  skipped with a warning.
- **Clears:** per-node location override (`latitude/longitude/location_name/address`),
  `media_id`, `image_url` when it is one of our R2 files, `image_removed_at`. Those images
  must be re-uploaded in the target.
- **Warns, never auto-fixes:** source business name hard-coded in node labels, and source
  vehicles/fares/rental packages/courses/Bot Builder/travel settings that are not copied.
- **Restore point:** if the target has a flow, a "Before copy from <source> — <date>"
  snapshot is saved first; after the swap a "Copied from <source> — <date>" snapshot
  becomes active. A failure after the delete returns 500 pointing at the restore point (no
  JS-side rollback). The service form has no restore point. Only the `flow:<businessId>`
  rules cache is flushed (`flow_fields` is read from the DB, not the tenant cache).
- Code: `utils/copySetup.js` (pure, tested), `services/copySetup.service.js`,
  `controllers/copySetup.controller.js`. The snapshot cap/active helpers moved into
  `flowSnapshot.service.js`. Not yet exercised against a real database.

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
  have no template and stay marketing-strict (so they also leave out a customer with
  `marketing_blocked_at` - see "Account health & stopped marketing").
  **Summary / skipped list (owner + superadmin only):** `POST
  /api/broadcasts/audience-summary` → `{ selected, willReceive, skipped:
  { no_number, blocked, opted_out, marketing_stopped, not_opted_in }, overCap, cap }` (`cap` =
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
  no_number > blocked > opted_out > marketing_stopped > not_opted_in). The send does not use them:
  `node src/scripts/checkAudienceParity.js --business <id>` (read-only, no
  `--confirm`) compares the SQL's willReceive ids with `resolveAudience` for
  every type on a real business, once as MARKETING and once as UTILITY — run it
  after the migration and whenever either side changes. `GET /api/customers/ids?<list filters>` →
  `{ ids, total, truncated }` (≤2000, for "select all matching") and `GET
  /api/customers/tags` → `{ tags }` back the picker; the customer list gained
  `?tags=` (ANY; `tags=a&tags=b` or `tags=a,b`). `/api/broadcasts` accepts JSON
  bodies up to 1 MB (2000 ids is ~80 KB); every other route keeps 100 KB.
  **Send is claimed atomically:** `sendBroadcast` flips `draft → sending` with
  one conditional UPDATE before the wallet debit (the debit and rate-card lookup
  happen only when `WALLET_BILLING_ENABLED=true`; it is off by default, so
  broadcasts are currently unbilled); a concurrent send gets 409
  "already being sent". A failure before anything is queued refunds and puts it
  back to draft; if only some batches queue, the rest are refunded,
  `total_recipients` is lowered and the draft is NOT released (a retry would
  double-message). **PostgREST limits that shape this code (measured on the
  hosted project):** a response is capped at 1000 rows (`max_rows`) and an
  `in(...)` filter of ~400 UUIDs fails (350 works), so id lookups go in chunks
  of 200 (`ID_CHUNK`) and unbounded reads are paged.
- **Wallet is dormant by default (`WALLET_BILLING_ENABLED`, off unless `=true`):**
  all four `/api/wallet/*` routes return 404 `{ message: "Wallet is not enabled" }`
  (`requireWalletEnabled`, `wallet.middleware.js`) — no wallet row is created and
  no Razorpay order is made. `GET /api/business` exposes `walletEnabled`
  (boolean) so the apps can hide wallet UI. Send paths (broadcast, demo
  reminder, follow-up sweep) already skip the debit when the flag is off; rate-card
  routes are unchanged.
- **Demo time + reminders (`bookings.scheduled_for / reminder_status /
  reminder_note`, `settings.demoForm.reminder` off|2h|evening):** on a Free
  demo request the owner fixes the time (`PUT /api/bookings/:id/demo-time`)
  → status `confirmed` ("Demo fixed"), the parent is told at once, and a
  BullMQ delayed job (`demo-reminder` queue, one job per booking) reminds
  them 2 hours before / 7 PM India time the evening before. Both messages go
  as free text inside the parent's 24-hour window, else as the business's
  `apnabot_demo_class` UTILITY template (wallet-charged like a broadcast, when
  `WALLET_BILLING_ENABLED=true`; otherwise free),
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
- `messages` chat columns (2026-10-14, migration `20261014140000`): `sent_by_user_id` (uuid, FK
  `users`, ON DELETE SET NULL), `sent_by_name` (text) and `interactive_payload` (jsonb, CHECK: NULL or an
  object). All nullable, no default, no index, no backfill: older rows are NULL and read as plain text.
  See "Chat redesign support".
- `messages` chat time (migration `20261030120000`, working tree, NOT applied/pushed): `wa_timestamp timestamptz` (nullable) =
  when WhatsApp says the message was sent. Inbound: the webhook payload `timestamp` (unix seconds); phone-app echoes: the echo
  payload timestamp (same as their `created_at`); ApnaBot outbound and history imports: NULL (`created_at` is already the time).
  `message_time` = `GENERATED ALWAYS AS (coalesce(wa_timestamp, created_at)) STORED` - PostgREST cannot order/filter on an
  expression, so chat reads use this column; the app never writes it. Index `idx_messages_chat_time (business_id, customer_id,
  message_time desc)`. Why: a webhook Meta delivers late has a later `created_at`, so created_at order showed it out of place.
  **Deploy: apply the migration BEFORE the server code** (inserts write `wa_timestamp`, reads order by `message_time`; the column add
  rewrites `messages` under an ACCESS EXCLUSIVE lock - quiet time). One-time cutover, no flag; Search cab AI (live) is affected.
  **Backfill:** `node src/scripts/backfillInboundWaTimestamp.js` (dry run) / `--confirm` sets `wa_timestamp` from
  `raw_payload.timestamp` on inbound rows. `raw_payload` is kept only for inbound `unsupported` rows, so only those are fillable
  (dry run 2026-10-30: 227 of 227); ordinary inbound rows keep NULL and sort by `created_at` - the fix applies to new messages.
  API (all additive): `GET /api/messages/:customerId` rows gain `waTimestamp` and `messageTime` (= message_time); order is
  `message_time desc, id desc`. Paging: `?page=&limit=` unchanged, or the cursor `?before=<messageTime>|<id>&limit=` (the `limit`
  messages older than that message; exact for same-second messages: `message_time < t OR (message_time = t AND id < id)`; plain
  `before=<ISO>` still works, strict `<`; not a date -> 400; `before` wins over `page`). Always oldest-first in the response.
  `pagination.nextCursor` = cursor of the oldest message returned, null when nothing older (set in page mode too);
  `pagination.hasMore` in cursor mode. `GET /api/messages` items gain `lastMessageTime`, `lastMessageType` (the last message's
  `type`) and `lastMessageOriginalType` (`raw_payload.type` when the type is `unsupported`, e.g. `revoke`, `edit`; else null);
  the last message is picked by `message_time`. `lastMessageAt` stays `created_at`; the inbox order still follows
  `customers.last_activity_at`. Socket `new_message` payloads: `socket.service.emitToBusiness` adds `message.waTimestamp` and
  `message.messageTime` for every emit site (`utils/messageTime.js`). In the 30 days to 2026-10-30, 308 inbound rows were stored as
  `unsupported`: raw type `unsupported` 206, `revoke` 18, `edit` 2, `errors` 1, no payload 81.
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
  ApnaBot's own subscriptions (and wallet top-ups when billing is on); the Razorpay/UPI payment-link
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
  Sends with no `messages` row (session-timeout notice, public service-form messages,
  platform notifications) have nothing to update; the broadcast worker's are tracked in
  `broadcast_recipients` (see "Delivery tracking, broadcasts").
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
  of only statuses logs one summary line. SQL check:
  `supabase/verification/verify_apply_message_statuses.sql` (rolls back, see its header).
- **Delivery tracking, broadcasts (2026-10-13).** `broadcast_recipients` (migration
  `20261013130000`; RLS on, no policies): one row per recipient with `status`
  (queued | sent | delivered | read | failed), `meta_message_id`, `sent_at` / `delivered_at` /
  `read_at` / `failed_at` and `error_code` / `error_title` / `error_details`; unique on
  `(broadcast_id, whatsapp_number)` and on the wamid. `sendBroadcast` makes the `queued` rows (chunks
  of 500, before any job is queued; a failure there is logged and the send carries on) and removes them
  again when the claim is released or a job could not be queued. The worker writes each result at once
  (wamid + `sent_at`, or Meta's rejection; our own failures such as "no name on file" have no code),
  only onto a still-`queued` row, so a broadcast sent BEFORE this has no rows and works as before.
  `apply_message_statuses` was replaced: a wamid not found in `messages` is looked up in
  `broadcast_recipients` (same forward-only rules); result keys `changed`, `changed_recipients`,
  `unmatched` (unmatched = in neither table, so only that gets the one 2s retry).
  **`broadcasts.sent_count` / `failed_count` are untouched** (sent = Meta accepted the request).
  `GET /api/broadcasts/:id` adds `stats` `{ tracked, total, queued, sent, delivered, read, failed }`
  from `broadcast_recipient_stats()`: counts overlap on purpose (sent = accepted, even if it failed
  later; delivered includes read; failed = send-time OR later); `tracked:false` (old broadcasts) gives
  the old counters and `null` for what is unknown. `GET /api/broadcasts/:id/recipients?status=&page=&limit=`
  (**owner / superadmin only**; limit max 100) lists name, full number, times and `failure`
  (`{ code, title, reason, kind, details }`; no code -> "Not sent: ...", kind `local`); its `status`
  filter uses the same meanings as the stats. Staff still see the counts on `GET /:id`.
  Socket `broadcast_progress` `{ broadcastId, status, totalRecipients, sentCount, failedCount, stats }`
  (`services/broadcastProgress.service.js`): at most one per broadcast per 2s, sent after a worker
  batch and after recipient status changes. SQL check: `supabase/verification/verify_broadcast_recipients.sql`.
  Not done: wallet refund for a message Meta accepts and fails later (separate task).
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

## Account health & stopped marketing (built 2026-10-14)

Two things Meta tells us only when a send fails (or, for the second, ahead of time), turned into
flags the owner can see. Both are **reactive**: Meta documents no field that reports a WhatsApp
payment-method status (checked 2026-10-10: the health-status doc mentions neither billing nor
funding), so nothing here calls the Graph API.

- **Payment-method problem (Meta 131042)** - migration `20261014120000_business_payment_issue.sql`
  (`businesses.payment_issue_at`, `payment_issue_code`). `services/accountHealth.service.js`;
  `services/deliverySignals.service.js` is the one entry point the failing places call
  (`noteSendFailure`, `noteStatusChanges`). Sources: the status webhook (`applyStatusEvents` in
  `webhook.controller.js`: failed chat messages and broadcast recipients), the broadcast worker's
  immediate rejection (noted once per batch), and `windowAwareSend`'s rejection (follow-ups, demo
  reminders; it still returns `{ sent: false, code: 'rejected' }`). **Set:** the first failure wins
  (`where payment_issue_at is null`), so `since` stays put. **Cleared only** (a) atomically when a
  broadcast recipient sent AFTER `payment_issue_at` is delivered / read (a chat message delivering
  never clears it - template messages are stored as `type 'text'`, so free in-window text can't be
  told apart), or (b) by the owner: `POST /api/business/payment-issue/dismiss` (`protect`,
  `requireBusiness`, `requireRole('owner')`). No auto-expiry. **API:** `GET/POST/PUT /api/business`
  and the connect-WhatsApp response carry `paymentIssue: { since, code } | null`; the raw columns are
  deleted from the response (`withPaymentIssue`). The login response has no business, so it has no
  `paymentIssue`. Superadmin's admin business responses (`admin.controller.js`) were NOT changed and
  still return the raw camelCase columns. There is no server-side setup-checklist / setup-status
  endpoint: web and Flutter read `paymentIssue` from `GET /api/business` and own the "Add a payment
  method to your WhatsApp account" step (it can't be auto-completed; the owner dismisses it).
- **Stopped marketing messages (Meta 131050 / `user_preferences`)** - migration
  `20261014130000_customers_marketing_blocked.sql` (`customers.marketing_blocked_at`, plus
  `create or replace` of `broadcast_audience` / `broadcast_audience_summary`, same signatures and
  grants). It is separate from `opted_out_at` (the customer's STOP: nothing at all) because 131050 is
  marketing-only. **It blocks exactly where `requiresMarketingOptIn(category)` is true** (MARKETING,
  AUTHENTICATION, unknown, none) - a UTILITY broadcast still reaches them. New skip reason
  **`marketing_stopped`**, order no_number > blocked > opted_out > marketing_stopped > not_opted_in
  (before `not_opted_in`: marking them opted in can't fix it); the summary gains
  `skipped.marketing_stopped`. `isBroadcastEligible`, the list filter and the summary count also leave
  them out; `GET /api/customers[/:id]` carries `marketingBlockedAt`. **Follow-ups:** a marketing
  automation skips them (`followupSweep.service.js`: the `inactive_for` query, and `freshGuard` when
  the window is closed, reason `marketing_stopped`); free in-window text still goes. **Set** by
  `services/marketingBlock.service.js#blockMarketing` (first stamp wins, scoped to one business, never
  inserts, so an unknown customer is a no-op): a 131050 on a failed status webhook row, a broadcast
  worker rejection, a `windowAwareSend` rejection, or a `user_preferences` `stop`. 131049 / 130472
  never set it. **Cleared ONLY by** a `user_preferences` `resume` (only if the stamp is OLDER than the
  event, so an out-of-order resume can't undo a newer stop), the customer's own START message
  (`webhook.controller.js`, both START branches) or the owner (`POST /api/customers/:id/resume-marketing`,
  owner / superadmin). A "Yes" tap (opt-in link, post-booking question) and contact import never clear
  it. Known limit: a *stop* event that arrives after a newer *resume* has no memory of that resume and
  stamps the older time.
- **`user_preferences` webhook** (`services/userPreferences.service.js`, dispatched from
  `processWebhookChange`): category `marketing_messages`, value `stop` | `resume`. **Needs a manual
  step in the Meta app dashboard** - subscribe the `user_preferences` field (like the coexistence
  fields); until then it never fires and nothing changes. Safe with any payload shape; an unknown
  `wa_id` is logged (last 4 digits) and ignored. Meta says `wa_id` "may differ from the phone number"
  (see gap 9, BSUID): we match `customers.whatsapp_number = wa_id` only.
- **Verification:** `supabase/verification/verify_marketing_blocked.sql` (rollback-safe; re-creates the
  two functions in `pg_temp` from their deployed text over a temp `customers` table; **written without
  access to a database, so its first run is also a test of the script**) and `checkAudienceParity.js`
  (passes vacuously for the marketing rule until some customer of the business has the column set).
- **Live-path note:** the webhook, the broadcast worker and `windowAwareSend` changed for every
  business the moment the server deploys (no flag); both flags start empty, so behaviour is identical
  until Meta returns a first 131042 / 131050 (or the field is subscribed). The SQL replacement gives
  identical results while the column is all NULL. **Deploy order: apply both migrations first** -
  the START handler writes `marketing_blocked_at` and the audience/follow-up queries filter on it, so
  code without the migration fails those queries. Search cab AI takes all of these paths.
- **Not built:** the web / Flutter banner, checklist step, "Stopped marketing messages" skip-reason
  label and customer-page badge / "resume marketing" button; `docs/FOLLOWUP_AUTOMATIONS.md`'s send-log
  reason table (section 7) still lacks `marketing_stopped`; a backfill of old 131050 failures
  (deliberately not written).

## Chat redesign support (built 2026-10-14, commits 108ff65..684a7cb, local - not pushed)

Server side of the Flutter chat redesign. Everything is additive: `GET /api/messages/:customerId` still
does `select('*')` + camelCase, so the new columns appear as `sentByUserId`, `sentByName` and
`interactivePayload` (null on older rows) and in the socket `new_message` row. Customer-facing WhatsApp
messages are byte-for-byte unchanged; only what is written to `messages` changed.

- **Who sent a human message.** `sendMessage` and `sendPaymentQr` (`message.controller.js`, the only two
  human-send inserts) stamp `sent_by_user_id` = `req.user.userId` and `sent_by_name` = `req.user.name`,
  or the fixed label **'ApnaBot Support'** for a superadmin (the id is kept). The name is a snapshot
  taken at send time, so a rename or a deleted user changes nothing old. Bot and phone-app rows stay
  NULL. It is shown to people who can view that business's chats and is never sent to Meta. Staff
  still cannot send (route roles unchanged: owner / superadmin).
- **What the customer saw: `interactive_payload`.** A jsonb object
  `{ kind, body, buttonText?, options?: [{ id, title, description? }], label?, imageUrl? }` with
  `kind` = `list` | `buttons` | `cta_url` | `location_request`. Text is cut to the same limits as the
  senders (`LIMITS` + the grapheme-safe `truncate`), buttons capped at 3, list label defaults to
  'Choose'. `null` when there is nothing interactive (plain text, image, location pin, template).
  `cta_url` stores **kind, body and label only - NOT the link**: the booking-form link carries a
  single-use token. `imageUrl` is set only on `buttons` (the list senders never send a header image).
  The migration header comment still lists `url?` in the shape: that comment is stale, no payload
  has a url, and no data is affected.
- **The helper.** `utils/interactivePayload.js#buildInteractivePayload(jobData)` takes the same job data
  the queue gets and follows the worker's dispatch order (`location` > `locationRequest` > `ctaButton` >
  `interactiveList` > `interactiveButtons` > `buttons` > `listOptions`). The Meta senders and the worker do
  NOT use it. `utils/interactivePayload.test.js` runs the REAL worker and senders (axios stubbed) over 17
  job shapes and fails if the stored payload and what Meta was given ever differ - run it after any
  change to `whatsapp.service.js` or the worker.
- **Save sites** (each sets `interactive_payload` in its existing insert): `webhook.controller.js` Step 15
  (flow buttons / list / web-form link / a tapped question node), `sendFieldPrompt` (booking question as
  list, buttons or location request), the vehicle carousel ("Book this" and "Other options"), both language
  pickers, the opt-in consent question, and `bookingConsent.service.js#sendQuestion`.
  `webhook.interactiveSites.test.js` + `webhook.interactiveSites.golden.json` hold the exact queue job and
  Meta body per site, captured BEFORE the change; they must stay equal. Step 15 and `sendFieldPrompt`
  work out the interactive job fields before the insert and add them to the job afterwards in the same
  key order.
- **Batch mark-read.** `PUT /api/messages/customer/:customerId/read` (owner / staff / superadmin): ONE
  UPDATE setting `is_read = true` where business, customer, `direction = 'inbound'` and `is_read = false`;
  answers `{ customerId, updated }`. A customer id from another business updates 0 rows (200, not 404).
  Dashboard-only: no queue, no Meta call, no socket event. The single-message
  `PUT /api/messages/:id/read` is unchanged. The conversations list still computes `unreadCount` per
  customer (count of inbound `is_read = false`).
- **Outbound location pins.** A location reply node's row used to be saved with empty text. It now holds
  "📍 name · address" (`utils/locationLabel.js`; just the name or address if only one exists; "📍 Location"
  if neither). No coordinates are stored. The queue job is unchanged. The pin's coordinates are worked
  out before the row is saved; if the business lookup there throws, it is treated as "no coordinates":
  the row is saved with the fallback text and the customer gets it (previously nothing was sent). The
  same fallback text is now also what the row holds when no coordinates are configured at all.
- **Deploy order:** apply `20261014140000`, run `supabase/verification/verify_messages_chat_columns.sql`
  (rolls back; expect `RESULT: ALL 18 CHECKS PASSED`), confirm the three columns, THEN deploy the server.
  One-time cutover, no flag: every bot reply insert now writes `interactive_payload` for ALL businesses
  (Search cab AI included), so code before the migration fails those inserts. Rolling the code back is
  always safe with the columns present.

## Auth sessions & refresh tokens (built 2026-10-10, commits 49ff028, 5d472fe, c4d2765, local - not pushed)

- **One session per login.** `startSession` (`services/auth.service.js`) is used by login, register and
  `createBusiness`. Redis `refresh:{userId}:{sid}` holds `{ jti, prevJti, prevUntil }`; the set
  `sessions:{userId}` lists a user's sids. The refresh token is a JWT `{ userId, sid, jti }`; the access
  token also carries `sid`. Two devices no longer kick each other out (the old single `refresh:{userId}`
  slot is gone, with no fallback).
- **`POST /api/auth/refresh` rotates.** It returns `accessToken` AND a new `refreshToken` (clients must store
  it every time). The old token stays valid for a **30-second grace window**; a call inside the window gets
  the session's current token back, so parallel or retried refreshes all work. A reuse after the window
  returns 401 "Refresh token expired or revoked" and deletes only that session. Rotation is one Lua `eval`
  (compare-and-rotate), smoke-tested against a throwaway local Redis 7 (parallel rotations: exactly one
  rotates, none orphaned). Missing token = 400 "Refresh token required"; bad JWT = 401 "Invalid refresh token".
- **Sliding expiry.** Each rotation resets the session to `JWT_REFRESH_EXPIRY` and the Redis TTL (same value;
  falls back to 30d if unset). **Set `JWT_REFRESH_EXPIRY=30d` on Render** (local `.env` has 7d).
  `JWT_EXPIRY` (access token) is unchanged.
- **Logout** ends only the caller's session and needs no body: it uses the body's `refreshToken`, else the
  Bearer access token (an expired one is accepted). Neither = harmless 200 (it used to be 400).
- **Revoke all sessions** (`revokeAllSessions`): password reset, and `removeStaff` / `toggleStaff`
  (deactivate) in `staff.controller.js` (a Redis failure there is logged, not fatal). There is no
  password-change endpoint yet; call it from one when added.
- **`GET /api/subscription/plans` is public** (no token), above `router.use(protect)`; everything else under
  `/api/subscription` still needs login. It returns active plans only, camelCased, minus `razorpay_plan_id` /
  `razorpay_plan_ids` (see "Plans managed from Super Admin").
- **One-time cutover at deploy, no flag.** Existing refresh tokens have no `sid`, so every logged-in user
  (web, Super Admin, Flutter; Search cab AI's owner included) must log in once, within `JWT_EXPIRY` of the
  deploy as their access token lapses. WhatsApp traffic does not use these tokens. **Do not push until web,
  Super Admin and Flutter store the rotated `refreshToken`** (web already does; the others were not
  checked).
- **Known leftovers.** `createBusiness` leaves the caller's previous session alive until its TTL (no sid on
  `req.user`). Tests: `auth.sessions.test.js`, `staff.revokeSessions.test.js`,
  `subscription.plans.routes.test.js` (the Lua itself is exercised only by the manual smoke test).

## Staff & Broadcasts switches (built 2026-10-11, commits 1e5c472, f9a35f6, 7e18ec9, 7aef138, a3e30b6, local - not pushed)

- **Two new keys in `FEATURES`** (`services/categoryFeature.service.js`): `staff` ("Staff members and
  permissions") and `broadcasts` ("Broadcasts to customers"), both for every category, both **OFF by default**
  like the other five keys (no row = off). A first version had a `defaultEnabled` flag; it was removed in
  `7aef138` before anything shipped. Super Admin switches them per business from the existing Businesses ->
  Features card (it builds its list from the server, so no Super Admin change). The category-level Features tab
  still exists only for coaching, so these are per-business in practice.
- **Migrations (order matters).** `20261015120000_staff_broadcasts_features.sql` widens both check constraints
  to seven keys (seeds nothing); that is the only migration, there is no second SQL file. **Staff and
  broadcasts are Off for every business until Super Admin switches them On** (Search cab AI, the one live
  business, uses neither; SG Travels and Averix are demos switched On by hand in Super Admin).
- **Broadcast guard.** `routes/broadcast.routes.js` has one `router.use(protect, requireBusiness,
  requireCategoryFeature('broadcasts'))` over all nine routes (the duplicate per-route `protect` /
  `requireBusiness` are gone); 404 "Not found" while off, for every role. The worker, the status webhook,
  follow-ups and message templates are **not** gated: a broadcast already queued or sending keeps sending
  and its delivery receipts keep being recorded; switching off only stops new ones. (There is no retry or
  scheduled-send route, so nothing else needed gating.)
- **Staff guard.** `routes/staff.routes.js`: `protect, requireBusiness, requireCategoryFeature('staff'),
  requireRole('owner', 'superadmin')`; all five management routes 404 while off. **Off hides management only:**
  existing staff accounts keep logging in, refreshing and working (login, refresh and `protect` do not check
  the switch; `auth.staffSwitchOff.test.js`). `inviteStaff` still has its own plan check (`staff_enabled`,
  `max_staff`) on top.
- **Guard cost.** `requireCategoryFeature` reads `businesses`, then `isEnabled` reads the override and the
  category switch in parallel (`Promise.all`, no cache). A DB error is fail-closed (500 via `next(err)`).
- **`GET /api/features`** (`routes/features.routes.js`; `protect`, `requireBusiness`, any role): the caller's
  own business, `{ success, message, data: { features: { <key>: boolean } } }` from
  `categoryFeature.service.js#effectiveForBusiness`. Only keys that apply to the business's category appear
  (`bot_builder` only for coaching); `owner_phone_media` is included though it has no screen. A new business
  with no override gets every key `false`.
- **Tests:** `categoryFeature.service.test.js`, `categoryFeature.migrationParity.test.js` (every `FEATURES` key
  must be in the newest constraint migration), `categoryFeature.middleware.test.js`,
  `broadcast.routes.feature.test.js`, `staff.routes.feature.test.js`, `auth.staffSwitchOff.test.js`,
  `features.routes.test.js`. `broadcastTemplate.roles.test.js` gained a pass-through stub for the guard.
- **FEATURE_DISABLED code.** A switched-off feature's 404 from `requireCategoryFeature` carries `errors: { code: 'FEATURE_DISABLED' }` (status and "Not found" unchanged), so clients can tell it from a missing route; a missing business is a plain 404 without the code.
- **Open items for the clients (not done).** The web sidebar (`apnabot-web` `src/app/(app)/layout.tsx`) and
  the Flutter drawer (`drawer_items.dart`) still show Broadcasts and Staff to everyone (`return true` /
  `_ => true`), so a business with a switch off sees the item and gets a 404. Both should read
  `GET /api/features` (one call replaces the per-feature probes; staff users can call it, unlike `GET /business`)
  and hide Staff / Broadcasts, and handle a 404 on those screens (stale tab, deep link). Reachable from
  elsewhere in the apps: audience pickers and contact groups that lead into broadcasts, and the "broadcast to
  a group" wording in the contact-import UI.
- **Known edges.** The `contact_import` description now says a group can be a broadcast audience "while
  Broadcasts is on". A superadmin with no business id gets 404 on `/api/staff` (the guard has no business to
  read). This section's business ids were taken from the owner, not looked up; the top of this file still says
  Averix has no business row, which is stale (recreated 2026-10-03).

## Reply photo gallery + video (built 2026-10-16, migration `20261016120000_reply_media_gallery.sql`)

- **Limits per plan.** `plans.images_per_reply` (integer 1-10, total photos per reply, photo #1 included) and
  `plans.video_per_reply` (boolean). Basic 1/no video, Pro 3/no video, Business 10/video. `planSeed.js` matches
  (first-run defaults only, see below); the migration backfills by plan name. Admin create/update plan accept `imagesPerReply` / `videoPerReply`
  (integer 1..10, boolean). Plans endpoints return them camelCased.
- **Columns.** `flow_nodes.gallery_media_ids` (jsonb array, default `[]`, ordered `business_media` ids of photos
  #2..N; jsonb because it must round-trip through `flow_snapshots` rows and is short) and
  `flow_nodes.video_media_id` (uuid FK, `on delete set null`). Photo #1 stays `media_id` / `image_url`, unchanged.
  `save_flow_graph_full` deliberately does not list the new columns: the canvas batch save (`PUT /full`)
  cannot set or null them; only `POST` / `PUT /api/flow-graph/reply-nodes` can.
- **Cleanup trigger.** `trg_business_media_remove_from_galleries` (after delete on `business_media`) strips the
  id from that business's galleries, so the library DELETE and the storage sweeper both clean up. The API also
  refuses to delete a file used by a gallery or video (`businessMedia.service.js`); `storageInventory` and the
  sweeper's snapshot cleaning treat both columns as references (never "protected").
- **Write path** (`services/replyMedia.service.js`). Every id must be a `business_media` row of this business;
  gallery = images, video = video <= 16 MB; no duplicates (photo #1's asset included); a list reply cannot carry
  extra media. A gallery with no photo #1 is **rejected** (the web promotes client-side). Plan limits are checked
  **only when the write increases** the photo count or adds a video where there was none, so a downgraded owner
  can still edit text, reorder, swap or remove. Plan = `getActiveSubscription` (status `active` only): no
  subscription, expired or trial = Basic limits (accepted for now).
- **Send order** (`sendReplyExtraMedia`, `webhook.controller.js`, before the reply row is saved). Gallery photos
  #2..N (no caption), then the video, each awaited (`addToWhatsappQueueAndWait`), then the normal reply with
  photo #1. Each extra is an outbound `bot` row (`type` image/video, `media_url`), one outbound usage count, one
  socket event. The worker has a `type: 'video'` + `videoUrl` branch (`sendVideoMessage`).
- **Downgrade behaviour.** Limits are read from `tenant.plan` at send time; stored media over them, and ids that
  no longer resolve in the business's library, are skipped with one info log, never an error to the customer. A
  plan edit by admin reaches the send path after the tenant cache (1h) / subscription cache (5 min) expires.
- **Error contract** (`errorResponse`: `message` top level, details in `errors`):

  | Status | `message` | `errors` |
  |---|---|---|
  | 403 | `Your <Plan> plan allows up to N photo(s) per reply.` (`1 photo`, `3 photos`) | `{ code: 'PLAN_LIMIT_PHOTOS', limit, plan }` |
  | 403 | `Video in replies is available on the Business plan.` | `{ code: 'PLAN_LIMIT_VIDEO', limit: 0, plan }` |
  | 400 | `Videos in replies must be 16 MB or smaller.` | none |
  | 400 | `Add a main photo to this reply before adding more photos.` | none |
  | 400 | `A list reply cannot carry extra photos or a video.` | none |
  | 400 | `galleryMediaIds contains the same photo more than once.` | none |
  | 400 | wrong business / wrong type / malformed ids | none |

- **Open items.** Copy setup / template clone / import clear both columns (`transformNodesForCopy`); the Test-tab
  preview shows no images at all; `nodeLibraryPublic` inserts admin `node_data` raw (foreign ids are skipped at
  send). Inventory filters with `gallery_media_ids.neq.[]` - confirm against live PostgREST after the migration.
  Tests: `replyMediaLimits.test.js`, `flowGraph.replyMedia.test.js`, `webhook.replyMedia.test.js`,
  `businessMedia.replyMedia.test.js`, plus additions to the worker, copySetup, inventory and sweeper tests.

## Reply carousel node + media usage (built 2026-10-22, migration `20261022120000_reply_carousel.sql`, uncommitted)

A reply node with `content_type = 'carousel'` sends WhatsApp's native interactive media carousel (session message,
free inside the 24h window): 2..N cards, each = image (or video) + optional card text (<= 160 chars, <= 2 line
breaks) + 1-2 quick-reply buttons (<= 20 chars), under a required main message (<= 1024). v1 = quick-reply cards only.

- **Columns.** `flow_nodes.carousel_cards` (jsonb array, null by default: `{ media_id, media_type: 'image'|'video', body,
  body_translations }`; kept snake_case inside the JSON, `toCamelCase` is shallow), `flow_edges.card_index` (smallint 0..9,
  which card a button edge belongs to; the edge id is the quick-reply id, so taps route through the existing
  `resolveTappedEdge` unchanged), `plans.carousel_max_cards` (2..10, default 3; basic 3, pro 10, business 10). The
  `content_type` check constraint now allows `'carousel'`. Plan reads are `select('*')`, so `carouselMaxCards` appears
  wherever `imagesPerReply` does; admin create/update accept `carouselMaxCards` (integer 2..10).
- **ROLLBACK WARNING - `save_flow_graph_full`.** The migration re-creates the RPC with `carousel_cards` and `card_index`
  in both its INSERT list and UPDATE SET. `flowGraph.service.js#saveFullGraph` therefore sends both keys on EVERY node /
  edge row (reply nodes and edges: preserve-on-omit; question / computed nodes: the stored value). A server build that
  predates this change, or re-applying the previous RPC definition, would NULL `carousel_cards` / `card_index` on the
  next canvas save. Deploy order: migration first, then the server; do not roll the server back without also
  restoring the RPC from `20261017120000` AND accepting that cards are lost on the next canvas save.
- **Write path** (`services/carouselNode.service.js`, used by `POST/PUT /api/flow-graph/reply-nodes`, `POST/PUT /edges`
  and the canvas batch save). Request cards use `carouselCards: [{ mediaId, mediaType, body, bodyTranslations }]` (snake_case
  also accepted), stored snake_case. Rules: reply node with `replyKind 'text'`, no gallery/video; 2..10 cards; each `mediaId` a
  `business_media` row of this business with the declared type; video only if the plan allows it; card text 160 chars / 2
  line breaks (translations too); message (`label`) required <= 1024. The plan card cap and the video permission are checked
  **only when the write increases** the count / adds a video (a downgraded owner can still edit). Cards left exactly as stored
  are not re-validated (a client may echo back cards cloned without media). Switching away from carousel clears the cards.
  Edges: a carousel button needs `cardIndex` within the cards, max 2 per card, label <= 20; any other parent must not carry
  `cardIndex`. Whole-carousel parity (every card the same 1 or 2 buttons, every button on a real card) is enforced in the
  canvas batch save only (edges arrive one at a time on the single-edge routes), and skipped for a carousel that is exactly
  as stored. Question nodes can never be carousels.
  **Content-type switches.** carousel -> anything else clears `carousel_cards` AND sets `card_index = null` on the node's
  outgoing edges (single-node PUT, and the canvas save, which also nulls a cardIndex the client echoes back). Anything ->
  carousel leaves existing buttons untouched: with `card_index` null they are *unassigned* - kept, ignored by the send path
  (info log `ignoredButtonsWithoutCard`), and excluded from the canvas parity check (which still requires every card to
  have its own 1-2 assigned buttons). The single-node PUT is not atomic across the node and its edges.
- **Send path** (`buildCarouselSend` in webhook.controller.js, `utils/carouselPayload.js#planCarouselSend`). Cards beyond the
  CURRENT plan's `carousel_max_cards` are skipped. **Native** (one Meta carousel) only when 2+ cards have resolvable media (a
  card whose media was deleted / foreign / wrong type / video-not-allowed counts as having none and is dropped) and all of
  those have the same 1-2 buttons. Otherwise the **text fallback**: the body, then one message per card (image header where
  the card has one, card text, its quick-reply buttons), all cards kept so every button still routes. This is what a clone
  from a Super Admin category template gets (copy/import drops the SOURCE business's media ids, `transformNodesForCopy`, but
  keeps card text and the card buttons). It is ONE queue job and ONE outbound `messages` row (`type 'text'`,
  `interactive_payload.kind = 'carousel'`), usage counted once. The worker (`whatsapp.worker.js`, `type: 'carousel'`) sends the
  native carousel; on a Meta **4xx (not 429)** it sends the same fallback instead and does not retry; 5xx / network errors throw
  so the queue retries as before - but only for the FIRST send (the native carousel, or the fallback's body). Once the
  fallback's body has gone out, a card message failing with 5xx / network is logged at warn and skipped, the remaining
  cards still go, and the job does not throw (a retry would resend the body).
- **Tap routing.** Meta does not document how a card button tap reaches the webhook. `interactive.button_reply.id` (= edge id)
  needs no change. If it arrives as `type: 'button'` (like a template quick-reply), `chatbot.service.js#resolveCarouselTap`
  claims it only when the payload is a UUID that is an edge of THIS business whose from-node is a carousel; every other
  `button` message goes to the template-button handling exactly as before. The first carousel tap a process sees logs its raw
  shape once (`First carousel button tap seen, raw shape`, info, no customer data). **Unverified against a live send: confirm
  with a real carousel on a test number and read that log line.**
- **Media usage / replace cleanup (all reply media, not only carousels).** `services/mediaUsage.service.js` is the single
  source of truth for "where is this file used": reply photo #1, gallery, video, carousel cards, template headers, courses
  (`business_courses.image_media_id`) and vehicles (`vehicles.custom_photo_url` = the file's url). `GET
  /api/business/media/:id/usage` (owner) returns it and `DELETE /api/business/media/:id` refuses on the same check (before
  this, DELETE did not check courses or vehicles: the course FK silently nulled, a vehicle kept a dead url). The storage
  inventory counts card media as a reference (never protected), and the sweeper clears a purged file from live carousel cards
  (media_id -> null, no DB trigger for these jsonb objects) and from snapshots' cards.
- **Not done / follow-ups.** `src/scripts/verifyBookingGraph.js` crashes on a business with no `booking_trigger` node (SG Travels:
  "No booking_trigger reply node found") and assumes exactly one (Hotel Demo has 3: PGRST116 from `.single()`); run it
  against CareWell Clinic, or fix the script to pick/loop over entry nodes. No Test-tab preview of a carousel; URL (CTA) cards; the Flutter / web editors. The gallery
  trigger does not strip card references (by design: the API refuses to delete used media; send skips what no longer
  resolves). Tests: `utils/carouselPayload.test.js`, `controllers/flowGraph.carousel.test.js`, `services/flowGraph.carousel.test.js`,
  `controllers/webhook.carousel.test.js`, `services/mediaUsage.test.js`, `services/flowSnapshot.carousel.test.js`, plus additions to
  the worker, inventory, sweeper, admin-plans and replyMediaLimits tests.

## Carousel builder bundle + clothing categories (built 2026-10-23, migrations `20261023120000`, `20261023130000`, uncommitted)

- **`POST /api/flow-graph/carousel-bundle` (owner only, like every flow write).** Creates a carousel reply, the
  reply nodes its card buttons open and the edges, all-or-nothing, so the web "Carousel builder" makes a catalogue
  in one call. Body `{ keyword, matchType?, hindiAliases?, text, textTranslations?, buttonsPerCard: 1|2, position?: {x,y},
  cards: [{ mediaId, mediaType?, body, bodyTranslations?, buttons: [{ label, labelTranslations?, action }] }] }`; `action`
  is `{ type: 'gallery', photoMediaIds, text, textTranslations? }` (new text reply, photo #1 = node media, rest =
  `gallery_media_ids`), `{ type: 'text', text, textTranslations? }` (new text reply) or `{ type: 'existing', nodeId }` (any
  reply node of this business, e.g. a `booking_trigger` "Start order"). Responds **201** `{ carouselNodeId, nodes, edges }`:
  the CREATED rows only (carousel first), camelCase, each identical to its `GET /full` entry.
- **Validation is the existing rules, not new ones:** `carouselNode.service.js#prepareCarouselWrite` (2..plan
  `carousel_max_cards` cards, body <=160 chars / <=2 line breaks, media of this business, video only if the plan allows),
  `replyMedia.service.js#prepareReplyMediaWrite` (1..plan `images_per_reply` photos), `validateEdgeCopy` (button labels
  <=20), the same button count on every card. Errors: 400 validation, 403 `PLAN_LIMIT_CAROUSEL_CARDS` /
  `PLAN_LIMIT_PHOTOS` / `PLAN_LIMIT_VIDEO`, 409 `KEYWORD_EXISTS`.
- **Atomic via RPC `create_carousel_bundle`** (plpgsql = one transaction; per-business advisory lock because
  `flow_nodes` has no unique index on keyword). Own RPC rather than `save_flow_graph_full`, which does not write
  `gallery_media_ids`. Verify on a real DB with `supabase/verification/verify_carousel_bundle.sql` (test business only,
  always rolls back). Generated target keywords: `<keyword>-<slug of the card text, first 3 words>-<n>` (fallback
  `card<cardNo>`; `n` = running counter over generated nodes, bumped past any taken keyword), `exact` match, e.g.
  `catalogue-red-kurta-1-1`. Canvas: carousel at `position` else max `position_x` of the graph + 450 (y 0); targets in one
  column 450 right of it, 260 apart (`H_SPACING` / `V_SPACING` in `carouselBundle.service.js`). `invalidateRulesCache` once.
  No cycle/reachability check: the new carousel has no incoming edges and no question nodes are added.
- **Categories `menswear` ("Men's Wear", icon `shirt`, order 133) and `clothing_wholesaler` ("Clothing Wholesaler", icon
  `warehouse`, order 136),** enabled, in the four category CHECK constraints (businesses, flow_snapshots,
  category_whatsapp_flows, node_library_entries) and `categoryFeatures.js` (no features). Boutique is unchanged (women's
  wear). No booking-form seed (default flows come via Super Admin import). **Apply order: 20261023120000, then
  20261023130000, both BEFORE deploying the server code.** Neither touches Search cab AI (travels).
- Tests: `services/carouselBundle.service.test.js` (the RPC is modelled in memory),
  `config/categoryFeatures.newCategories.test.js`.

## Data-driven business categories + `mobile_electronics` (built 2026-10-24, migration `20261024140000_data_driven_categories.sql`)

- **A category is one `business_categories` row**, created from Super Admin: no migration, deploy or client release. The
  table gained `emoji text` (default `''`) and `label_translations jsonb` (default `{}`, shape `{"hi","mr"}`); clients
  fall back to their own maps / `label` when these are empty. The four category CHECK constraints
  (`businesses`, `flow_snapshots` (nullable), `category_whatsapp_flows`, `node_library_entries`) became foreign keys to
  `business_categories(value)`, `on update cascade on delete restrict`. `business_type_templates` / `flow_packs` (dead)
  keep their CHECKs. `category_features` / `course_catalog` already referenced the table.
- **Endpoints (superadmin only, `/api/admin/business-categories`):** `POST /` `{ value, label, labelTranslations?, emoji?,
  icon?, displayOrder?, isEnabled? }` - `value` matches `^[a-z][a-z0-9_]{2,39}$`, 409 if it exists, `isEnabled` defaults
  to **false** (a half-made category never shows at signup), `displayOrder` defaults to max + 10; `PUT /:value` - same
  fields except `value` (immutable, 400 if it differs), 404 if missing. No delete. Limits: label <= 40, emoji <= 8
  characters, translations only `hi`/`mr` strings (empty ones dropped), `icon` length-only (older rows hold a raw emoji).
  `GET` (admin list) and the public `GET /api/business-categories` return `emoji` and `labelTranslations` camelCased.
  The older `PUT /:value/toggle` remains.
- **Server code needs no per-category list:** validation goes through `businessCategoryService.isKnownCategory` /
  `isEnabledCategory`. `categoryFeatures.js` treats an unlisted category as "no features" (own-property lookup, so a
  category named `constructor` is safe).
- **`mobile_electronics`** ("Mobile & Electronics", icon `smartphone`, emoji 📱, order 158, enabled): mobile / TV /
  appliance sales shops incl. CSD / CPC canteen dealers. `electronics_repair` is a separate, unchanged category.
- **`templates/category/`** holds starter-flow files in the exact body `POST /api/admin/category-templates/import-json`
  accepts (`{ category, name, description, nodes, edges }`, raw snake_case rows, fixed UUIDs). Files only: importing is a
  manual Super Admin step. `mobile_electronics.default.json` is the first (menu, product enquiry, CSD/CPC + documents, EMI,
  store details, handoff, 4-question enquiry via `booking_trigger`). Its Catalogue reply (`content_type 'catalog'`) is
  dropped when a template is copied into a business (`writeBusinessGraphRows`), so businesses get a 6-row menu until they
  enable the Catalogue page. The booking confirmation text is the fixed system message; a template cannot set a closing text.
- **Apply order:** run the preflight in the migration header (must return 0 rows), apply the migration, THEN deploy the
  server. Not a cutover for existing businesses; Search cab AI is unaffected.
- Tests: `controllers/businessCategoryAdmin.controller.test.js`, `routes/businessCategoryAdmin.routes.test.js`,
  `config/categoryFeatures.dataDriven.test.js`, `controllers/categoryTemplate.mobileElectronics.test.js`,
  `services/bookingGraph.mobileElectronics.test.js`.

## Bot languages, language picker, auto-translate (built 2026-10-24, migrations `20261024120000`, `20261024130000`, uncommitted)

Each business offers English + up to 2 Indian languages (3 total; the cap was 4 until 2026-10-20). **Cutover note:** a business created from now on gets a
state-based default (`en,hi` for most states) instead of `{en}`, so its customers see a language picker; existing
businesses keep exactly what they have (Search cab AI is untouched: `["en","hi","mr"]`, picker output byte-identical,
pinned by `webhook.interactiveSites.golden.json`).

- **Catalog (`utils/languageCatalog.js`, single source of truth):** `en hi mr gu kn ta te ml bn pa or` with native name
  (`name`), `englishName`, `azure` code and `metaTemplate` locale (Odia has none: it is not on Meta's supported-languages
  list, so message templates cannot be created in Odia). `validateEnabledLanguages`: 1..3 codes (`MAX_ENABLED_LANGUAGES`; error "You can choose up to 3 languages (English + 2 more)."), 'en' required (moved first),
  catalog codes, no duplicates. `STATE_LANGUAGES` / `suggestedLanguagesForState` hold the per-state defaults (Maharashtra
  en,hi,mr · Gujarat en,hi,gu · Karnataka en,hi,kn · Tamil Nadu en,ta · Telangana/Andhra en,hi,te · Kerala en,ml · West Bengal
  en,hi,bn · Punjab en,hi,pa · Odisha en,hi,or · every other state / UT / unknown en,hi). Every translation validator already
  accepted "any catalog code", so the new codes work in node / edge / option / carousel-card / form-field / follow-up translations.
  `utils/followup.js` now uses the catalog too. `utils/templateValidation.js` takes Meta template locales from the catalog
  (`en_US hi mr gu kn ta te ml bn pa`).
- **Public API:** `GET /api/public/languages` -> `{ languages: [{ code, name, englishName }], maxEnabled: 3,
  defaultSuggested, states: [{ name, suggested }] }`; `GET /api/public/languages/suggested?state=` -> `{ state, suggested }`.
  Static data only - nothing from `app_config`.
- **Columns:** `businesses.state` (validated against the 36 states / UTs), `businesses.language_picker` (jsonb, NULL =
  defaults), `businesses.translation_status`, `businesses.auto_translations`, `flow_nodes.auto_translations`,
  `flow_edges.auto_translations`. `enabled_languages` unchanged. `POST /api/business` takes optional `state` and
  `enabledLanguages` (default from the state); `PUT /api/business` validates both.
- **Picker (`services/languagePicker.service.js` + `sendLanguagePicker` in `webhook.controller.js`, replacing two duplicated
  blocks):** 2-3 languages = reply buttons, 4 = a WhatsApp list (**unreachable since the cap is 3; code and tests kept in case it is raised**) (rows `lang_<code>`; a `lang_` list tap is mapped to the same
  system-tap handler, it never reaches the edge resolver). Titles use the grapheme-safe `truncate` (fixes gap 19 for the picker).
  Built-in prompt: the old "Choose your language / अपनी भाषा चुनें" for en/hi/mr businesses (unchanged), a composed line when
  another language is on (the non-Hindi/Marathi wordings are unreviewed - have a native speaker check them). Settings
  (`language_picker`): `mode` `first_message` (default, today's behaviour) or `off` (customer silently gets the first enabled
  language; there is no 'always'), `prompt`, `promptTranslations`, `changeKeyword`. Change keywords: `language`, `भाषा`,
  `bhasha` + the owner's word, typed text only, work in every mode (reserved words - greetings, menu, stop, start, cancel... - are
  refused). The webhook reads `enabledLanguages` / `languagePicker` from the cached tenant (a tenant cached before this existed
  simply lacks them; `PUT` invalidates the cache).
- **Language node:** a settings-backed *virtual* node, not a `flow_nodes` row (the engine, snapshots, the canvas-save RPC
  whitelist and the validators never see it). `GET /api/flow-graph/full` returns `languageNode`; edit through `PUT /api/business`
  (languages) and `PUT /api/business/language-settings` (picker); `GET /api/business/language-settings` returns the same node.
- **Disabled language:** saving `enabledLanguages` without a language sets `customers.preferred_language = NULL` for those
  customers (they are asked again on their next message; every other sender - follow-ups, broadcasts, payment texts - falls back to
  English on NULL). The webhook also treats a stale language as unset when the cached tenant says it is off. Stored translations are
  never deleted, so re-enabling restores them.
- **Auto-translate (Azure Translator F0; `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION`, optional `AZURE_TRANSLATOR_ENDPOINT`;
  missing = 503 "not configured", the app keeps working):** `services/azureTranslate.service.js` (HTTP), `translation.service.js`
  (cache + caps), `flowTranslate.service.js` (whole-flow), `utils/translateProtect.js` (protection), `utils/translationSlots.js`
  (what can be translated). Text is sent as HTML: `{{x}}` in `<span class="notranslate">`, `*bold*`/`_italic_` as `<b>`/`<i>`, line
  breaks as `<br>`, then restored and **verified** (same placeholders, bold/italic count, line breaks, emojis) - an unfaithful
  translation is dropped with a warning and never cached or stored (English fallback at send time). Global cache
  `translation_cache`; per-business monthly cap `app_config.translate_monthly_char_cap` (default 20000; cache hits are free; the
  characters are reserved atomically by `reserve_translate_chars` before the call and refunded if it fails; month = India month) and a
  global safeguard `translate_global_monthly_cap` (default 1,800,000 of the free tier's 2M). Both are editable in Super Admin
  (`PUT /api/admin/app-config`: `translateMonthlyCharCap`, `translateGlobalMonthlyCap`) and are **not** in the public
  `/api/app/version` payload (tested). Endpoints (owner): `POST /api/translate`, `POST /api/translate/flow`,
  `GET /api/translate/usage` (20 calls/min per business). Super Admin: `POST /api/admin/category-templates/:id/translate`.
  The flow run fills only slots with **no** text in that language (a human translation is never overwritten), writes straight to
  the translation columns (not through the canvas save RPC), skips a translation longer than WhatsApp's limit (button 20, row 24,
  description 72, card 160...) and refuses the whole run up front if it would exceed the cap. Plain-string question options become
  the `{value,label,labelTranslations}` object `normalizeOption` already reads.
- **"Auto-translated" badge:** `auto_translations` on flow_nodes / flow_edges / businesses holds
  `{ "<slot>": { "<lang>": "<hash of the stored text>" } }`. A slot is reported (`autoTranslated: { label: ['hi'] }` on every node
  and edge of `GET /flow-graph/full` and the carousel-bundle response, and on `GET|PUT|POST /api/business` for the welcome / stop /
  start / cancel messages and booking-form labels) only while the stored text still hashes to the recorded value, so a hand edit
  clears the badge by itself and no writer (canvas save RPC, AI apply...) has to know about the column. Template copies carry it
  because rows are copied verbatim.
- **Signup:** after `applyDefaultSetup` the default flow is translated into the owner's languages in the background
  (`startNewBusinessTranslation`; global counter only, the new owner's allowance is untouched; skipped if Azure is not configured).
  `businesses.translation_status` is written `pending` before the signup response, `GET /flow-graph/full` returns
  `translationStatus { <lang>: 'pending'|'done'|'failed' }` + `translating`, and `PUT /flow-graph/full` answers **409**
  `TRANSLATION_IN_PROGRESS` while any language is pending (a pending older than 10 minutes reads as failed).

## Mobile app version gate (built 2026-10-18, migration `20261018120000_app_config.sql`)

Tells the Flutter app which versions to accept. **Server only - no client reads it yet**, so
`force_update` / `maintenance_mode` change nothing for users until a Flutter build consumes the endpoint.
- **Table `app_config`** (`key` pk, `value` text, `updated_at`, `updated_by` -> `users`, RLS on, no
  policies; separate from `platform_settings`). Keys: `android_min_version`, `android_latest_version`
  (x.y.z), `force_update`, `maintenance_mode` (`'true'`/`'false'`), `play_store_url`.
- **Public `GET /api/app/version`** (no auth): `data: { minimumVersion, latestVersion, forceUpdate,
  maintenanceMode, storeUrl, supportWhatsappNumber, supportMessage }` (the last two: see "Unlisted business at signup + support
  number"), `Cache-Control: public, max-age=60` plus a 60s in-process cache. Fails
  open: a missing/malformed key or a DB error serves 1.0.0 / false / the Play Store URL (a fallback is
  `no-store` and never cached). It is not behind any maintenance gate (none exists); a future one must
  exempt this route (comment in `routes/appVersion.routes.js`).
- **Superadmin `GET` / `PUT /api/admin/app-config`**: partial body of `androidMinVersion`,
  `androidLatestVersion`, `forceUpdate`, `maintenanceMode`, `playStoreUrl` (https only); min must be <=
  latest. Returns the five values, top-level `updatedAt` / `updatedBy` (display name, else email, of the
  latest change by a user; both null if never changed) and per-key `keys.<field>.{updatedAt, updatedBy}`.
  A PUT clears the cache and logs `App config changed by superadmin` with old -> new. Unchanged values
  are not rewritten. Caveat: if the changing user is later deleted, `updated_by` goes NULL and that
  change reads as "never changed".
- **Deploy: apply the migration first, then the server.** Additive, not a cutover; no webhook/booking
  path touched (Search cab AI unaffected). Tests: `src/routes/appConfig.routes.test.js`. Code:
  `appConfig.service.js` / `appConfig.controller.js`. Not built: a Super Admin UI for the endpoint.

## Razorpay autopay subscriptions (plan ids mode-keyed 2026-10-14)

- `POST /api/subscription/autopay/create` get-or-creates a Razorpay Plan for (plan, monthly price), then
  creates the Razorpay Subscription. Code: `razorpaySubscriptions.service.js`.
- **`plans.razorpay_plan_ids` is keyed by Razorpay key mode: `live:<paise>` / `test:<paise>`**, e.g.
  `live:19900`. The mode comes from the `RAZORPAY_KEY_ID` prefix (`rzp_live_` / `rzp_test_`); any other
  prefix makes plan lookup/creation throw. Test and live plan ids are separate worlds in Razorpay, so a
  stored id from the other mode would 400 ("The ID provided is invalid or could not be found").
- **Self-heal:** a stored id is verified with a Razorpay fetch before use. Only a 400 creates a
  replacement; any other failure (network, 401, 5xx) is rethrown and creates nothing. Creating a
  Razorpay Plan is permanent (no edit/delete), so every creation is logged (mode, price, new and
  replaced plan id).
- **Plan check:** `GET /api/admin/razorpay/plans-check` (superadmin, read-only) fetches each mapped id for
  the current mode and reports `ok` / `missing` / `error` / `other_mode` plus active plans with no
  current-mode mapping (`unmappedPlans`; created on first use). The same check runs once at startup,
  non-blocking, and logs a warning if anything is missing or unverifiable.
- **Client errors:** `errorHandler.middleware.js` turns Razorpay SDK errors into a generic 400 (Razorpay
  4xx) or 502 (401/5xx) message; the raw description is logged only. This covers every route that
  surfaces a Razorpay SDK error (the one-time order endpoints too).
- **Cutover:** the first autopay create after deploy creates a new permanent `live:` plan in the account
  the Render key belongs to. No feature flag.
- Cleanup: `src/scripts/cleanupBarePriceRazorpayPlanKeys.js` (dry run; `--confirm` to write) removes the
  old bare-price keys (`19900`, `29900`) once Razorpay confirms them dead. Tests:
  `src/services/razorpaySubscriptions.service.test.js`.
- `subscriptions.is_autopay=false` rows are the one-time Orders flow (`/create`, `/verify`), still live.

## Plans managed from Super Admin (built 2026-10-19, migration `20261019120000_plans_popular_features_sort.sql`, uncommitted)

Goal: a plan created or edited in Super Admin shows up in the web app and Flutter with no code change.

- **New columns** (additive, defaulted): `plans.is_popular boolean` (false), `plans.features jsonb` (`[]`, array
  of strings; check constraint), `plans.sort_order int` (0). Admin create/update accept `isPopular`,
  `features` (max 30 strings, 200 chars each), `sortOrder`, `storageLimitMb` (non-negative integer; before this
  a new plan always got the DB default 200 and storage was not editable), and create honours `isActive`.
- **`plans.price` is the monthly price and the single source of truth.** `src/utils/planFields.js`
  `buildDurationOptions(price, existing)` derives `duration_options`: Monthly = price (discount 0); 3/6/12
  months = `Math.round(price x months x (1 - discount/100))`, discount from the tier's stored value, else
  10/20/30 (Quarterly / Half-Yearly / Yearly). Custom extra tiers are kept and recomputed. Create and update
  write `price` and `duration_options` in ONE statement (update re-derives whenever `price` or
  `durationOptions` is sent). A supplied `durationOptions` with no Monthly tier, or whose Monthly price differs
  from the plan price, is a 400; its non-Monthly amounts are ignored (only months/label/discount are used).
- **Public `GET /api/subscription/plans`:** active plans, sorted `sort_order` then price (sorted in JS; the
  table is tiny), all columns camelCased except the two Razorpay id columns, which are stripped. Admin
  `GET /api/admin/plans` uses the same order and includes inactive plans (the authenticated
  `GET /api/subscription` plan object still carries the Razorpay ids). **An inactive plan is hidden from new
  purchases but still honoured for existing subscribers**: subscription reads join `plan:plans(*)` without an
  `is_active` filter; only create/autopay/admin-assign reject an inactive plan.
- **Seed is insert-only.** `npm run seed` creates missing basic/pro/business (tiers via `buildDurationOptions`)
  and never touches an existing plan. Before this it overwrote price, limits, tiers and `is_active` of those
  three on every run.
- **Downgrade guard now on one-time `POST /api/subscription/create` too** (409, same message as autopay;
  price-ordered via `getHigherActiveSubscription`). `/verify` is not guarded (payment already taken at order
  time). Admin `changeBusinessPlan` / grant still bypass it by design.
- **Video-limit error** (`PLAN_LIMIT_VIDEO`) names the cheapest active plan with `video_per_reply = true`, else
  "Video in replies is not available on your plan."
- **Script:** `src/scripts/recomputePlanDurationOptions.js` (dry run; `--confirm` writes) recomputes
  `duration_options` for every plan from price + stored discounts and prints a before/after diff per tier. It
  never writes `price`, and its update is guarded on the price it read.
- **Plan limits clean-up (2026-10-28, migration `20261031120000_plans_broadcast_recipient_limit.sql`,
  uncommitted until the commit below).**
  - **Public `GET /api/subscription/plans` is now a whitelist** (`toPublicPlan` in `utils/planFields.js`):
    `id, _id (same value, the toCamelCase alias checkout sends), name, displayName, price, durationOptions, isPopular, features, sortOrder, msgLimit, imagesPerReply,
    videoPerReply, carouselMaxCards, storageLimitMb, staffEnabled, maxStaff, bookingEnabled,
    broadcastRecipientLimit`. `ruleLimit`, `customerLimit` and `paymentLinkEnabled` are no longer advertised
    (columns kept, nothing lost; the authenticated `GET /api/subscription` still returns the whole plan).
  - **Payments are not gated.** The Razorpay/UPI payment-link create endpoints no longer exist; `payment_trigger`
    only sends text; the QR / UPI ID features are the owner's own. `payment_link_enabled` stays in the DB and
    `requireFeature('paymentLink')` still has no caller.
  - **`plans.broadcast_recipient_limit`** (int, `-1` = unlimited; basic 100, pro 500, business -1, column
    default 100, check `-1` or `>= 1`). `services/broadcastCap.service.js`: effective cap = min(plan limit,
    `MAX_BROADCAST_RECIPIENTS`); `-1`, no active/trial subscription, or a failed subscription read = env cap
    only. Used by `sendBroadcast`, `getAudienceSummary` (`cap` / `overCap`), catalogue broadcast preview
    (`audience.cap`, error `PLAN_BROADCAST_LIMIT`) and send. A plan-set cap refuses with **403
    `PLAN_BROADCAST_LIMIT`** (`errors {code, limit, plan}`, "This plan sends a broadcast to up to N customers.
    Upgrade for more."); the env cap keeps the old 400 `TOO_MANY_RECIPIENTS`. Admin create/update accept
    `broadcastRecipientLimit` (integer >= 1 or -1; create default 100).
  - **Deploy: apply the migration first, then the server.** Not a webhook/booking change. Basic accounts are
    held to 100 recipients per broadcast from deploy (SG Travels has 47 customers); Search cab AI has no
    subscription today, so it keeps the env cap until it is given one.
- **Still needs code for a new plan:** a brand-new kind of feature flag (`requireFeature` only knows
  `paymentLink` / `staff` / `booking`). `rule_limit` and `customer_limit` are stored but never
  enforced. Revenue reports sum `plans.price` (monthly) whatever duration was bought, and no amount paid is
  stored on `subscriptions`. `deletePlan` counts only `active` subscriptions (not trial / past_due).
- **Deploy: apply the migration first, then the server** (the new code selects/writes the new columns). Not a
  cutover and no webhook/booking path touched; Search cab AI is unaffected. Plan edits reach live tenants only
  after the subscription (5 min) / tenant (1 h) caches expire. After deploy, run the recompute script as a dry
  run, review the diff (rounding will change a few seeded amounts, e.g. Basic 6-month 954 -> 955), then
  `--confirm`.
- Tests: `utils/planFields.test.js`, `controllers/admin.plans.test.js`, `seeds/planSeed.test.js`,
  `scripts/recomputePlanDurationOptions.test.js`, plus additions to
  `subscription.controller.duplicates.test.js` and `flowGraph.replyMedia.test.js`.
- **Pre-existing, unrelated:** `controllers/admin.chatMediaRetention.test.js` fails at load (Razorpay SDK
  throws without a key id; the shared test harness config has none). Confirmed failing on the unmodified tree.

## Catalogue - collections + photos managed from one page, rendered live by the bot (built 2026-10-20, migrations `20261026120000_catalog.sql`, `20261026130000_catalogue_feature_switch.sql`, uncommitted)

The owner manages **collections** (a card each: cover, title, card text, price label) and **photos** (design no, price, caption) on one Catalogue page; the bot shows them live. Nothing is cached: an edit applies to the next customer message. Session (free) messages only, no templates.

- **Tables.** `catalogs` (one row per business, `settings` jsonb), `catalog_collections`, `catalog_items` (`media_id` FK to `business_media`, ON DELETE CASCADE; a collection's `cover_media_id` ON DELETE SET NULL), `catalog_events` (Insights counters). RLS on, service role only. `booking_form_tokens.prefill jsonb`. RPCs `upsert_catalog_node` (create/update the bot node + optionally replace clashing nodes, one transaction, per-business advisory lock) and `catalog_insights`.
- **The bot node.** ONE `flow_nodes` reply row per business with `content_type = 'catalog'` (partial unique index). It is a *projection* of the settings (`keyword` = `keywords[0]`, `hindi_aliases` = other keywords + aliases, `label` = text, `match_type` contains), written only by the catalogue endpoints (`catalog.service.js`), so keyword matching (Unicode rules, shadow log), the rules cache and menu edges work unchanged. `is_computed` stays false (the DB constraint forbids it on a reply node). **No new `flow_nodes` column, `save_flow_graph_full` is unchanged.** Guards: the canvas batch save keeps the node as stored (position only) and refuses to delete it by omission; `PUT/DELETE/toggle reply-nodes/:id` answer 400 `CATALOG_NODE_MANAGED`; no edge may leave it; `contentType 'catalog'` cannot be created through the generic API. `GET /api/catalog` re-creates / re-projects a node that a snapshot restore, template import or copy-setup removed (`healCatalogue`); `writeBusinessGraphRows(reuseIds:false)` drops the node and its buttons when copying into another business / a template.
- **Customer flow** (`catalogReply.service.js`, hooked in `webhook.controller.js` Step 12.7 / Step 14 / Step 11): keyword (or a menu button) -> ONE native carousel of the ACTIVE collections (sort order, at most the plan's `carousel_max_cards`; cards `*title*\nbody\nprice label`, body trimmed to fit 160; buttons View designs + Order, or View designs only when there is no order action); fewer than 2 cover photos -> the worker's existing one-message-per-card fallback. View designs -> `photosPerPage` photos (caption "design no · price · caption"), then a buttons message (Show more designs / Order / Catalogue). `photoStyle 'order_button'` -> each photo is an image-header button message "Order this". Ids (system taps, `utils/catalogIds.js`): `cat:menu`, `cat:<collectionId>:p:<page>`, `cat:<collectionId>:order`, `cat:item:<itemId>:order`. A stale tap (deleted / switched-off collection or photo) says so and re-sends the carousel. Mid-booking a `cat:` tap only re-shows the pending question. A card button that arrives as a message of type `button` is claimed only for a `cat:` id whose collection / photo belongs to the business. Disabled catalogue, no active collection, or the `catalogue` feature switched off -> `emptyText` (built-in default if unset).
- **Usage metering.** One outbound usage unit per reply: the carousel, a whole photos page (photos + buttons message), an order message. Reply galleries keep per-photo counting. Counting is done by `whatsapp.worker.js` (see "Message counter per subscription period"): the photos of a page are queued with `countAs: 0` and the closing buttons message counts the page's one unit, so a 10-photo page records exactly 1 (`webhook.catalog.test.js`, `whatsapp.worker.test.js`). If that closing message fails to send, the page records 0.
- **Order.** `orderAction`: `{type:'message',text?,textTranslations?}`, `{type:'booking_trigger',nodeId}` or `{type:'web_form_trigger',nodeId}` (node must be a reply node of that kind). The booking / form node runs through the normal Step 14 branch with a prefill `[{key,value}]` of `catalogCollection` (collection title), `catalogDesignNo`, `catalogPrice` (item price, else the collection's price label); base-language values. Chat booking: `startGraphSession(.., {prefill})` writes them into `collected` + `answeredFields` (label English for the owner, the customer's language in the confirmation; they come first in the confirmation) and sets `session.prefilledKeys`; `pickNextNodeId` skips any question whose `field_key` is a prefilled key. A session started without prefill is exactly as before. Web form: the token stores `prefill`; `GET /api/public/service-form/:token` adds `orderChips [{key,label,value}]` (label in the customer's language), `lockedFields` (form fields whose name equals a key) and merges the values into `prefill`; the submit forces locked fields to the token's value and saves chip-only values on the booking (`bookings.fields`, `field_labels`, confirmation lines). A `message` order creates no booking / lead (an `order_*` event only).
- **Settings** (`catalogs.settings`, validated in `utils/catalogSettings.js`): `enabled`, `keywords[]`/`aliases[]` (3-40 chars, max 10 each, reserved greeting/stop words refused, native script warns while Unicode matching is off), `text`, `viewButtonLabel`, `orderButtonLabel`, `showMoreLabel`, `menuLabel` (<=20) each with `...Translations`, `emptyText(+Translations)`, `photosPerPage` 1-10, `photoStyle`, `orderAction`, `addToMainMenu`. `menuLabel` is an addition to the brief (the menu row and the post-page Catalogue button share it).
- **Keyword clash.** `PUT /api/catalog` -> 409 `KEYWORD_EXISTS` (`errors.keywords`, `errors.nodes [{id,keyword,label,contentType,replyKind,matchedWords}]`) when an ACTIVE reply node uses one of the words. With `replaceKeywordNodes: true` the RPC deactivates (never deletes) those nodes and retargets every edge that pointed to them to the catalogue node, in one transaction; the response lists `replaced [{id,keyword,label,retargetedEdges}]`. SG Travels and Shambhu Men's Wear (demo) have such a "catalogue" carousel. Search cab AI has none.
- **Main menu row.** `addToMainMenu` + enabled adds a row/button for the catalogue to the active `hi` buttons/list node: `menu.status` `ADDED | IN_MENU | REMOVED | NOT_REQUESTED | MENU_FULL (3 buttons / 10 rows, nothing is converted) | NO_MENU_NODE | ERROR`. Removed again when switched off or disabled, but a button the owner wired themselves (or one retargeted by a replace) is only removed if `addToMainMenu` had been on. As of 2026-10-20 every live `hi` buttons node is full (3), so the row fits only list menus with room.
- **Limits.** Active collections <= plan `carousel_max_cards` (403 `PLAN_LIMIT_CATALOG_COLLECTIONS` on create / activate; inactive ones are free; a downgrade only hides the extras, `shownInCarousel`); 100 photos per collection (400 `CATALOG_ITEM_LIMIT`, server constant); 50 photos per create request; media must be an image of the same business.
- **Media.** `POST /api/catalog/media` (multipart `files`, up to 10, 5 MB each; the normal library cap is 2 MB) runs each file through `uploadBusinessMedia` (type check, storage quota, resized to 1280px q80) with `forceJpeg` (WebP -> JPEG); per-file results; once the quota is hit the rest are not attempted. `mediaUsage.service.js` has kinds `catalog_cover` / `catalog_item` (DELETE of a used file is refused), `storageInventory.service.js` counts them as in use (kind `catalog_image`), the sweeper needs no code (FKs). Deleting a collection / photo / swapping a photo returns `orphanedMedia` (files now unused) and accepts `?deleteUnusedMedia=true`.
- **Translations.** `catalog_collections` / `catalog_items` / `catalogs.settings` use the same slots and `auto_translations` badges (`utils/translationSlots.js`); `POST /api/translate/flow` now also translates the Catalogue, `POST /api/catalog/translate {to}` only the Catalogue. Design numbers and prices are never translated. The catalogue node's own label is not a flow slot. New built-in strings (`catalog*` in `systemMessages.js`, en/hi/mr) need a native-speaker review.
- **Feature switch `catalogue`** (`categoryFeature.service.js`): the first switch with `defaultEnabled: true` (no row = ON); Super Admin can switch it off per business / category. Off: `/api/catalog/*` answer 404 `FEATURE_DISABLED` (apps hide the page via `GET /api/features`) and the bot replies `emptyText`.
- **Insights / share.** `catalog_events`: `catalogue_open`, `collection_view` (a card was shown), `designs_view` (page 0), `designs_more`, `order_collection`, `order_item`; `GET /api/catalog/insights?days=7|30`. `GET /api/catalog/share` -> wa.me link with the first keyword prefilled (the QR is drawn by the apps from `waLink`).
- **Roles.** Writes owner only; reads any member of the business (like the flow graph).
- **Not done / follow-ups.** Web (`apnabot-web`) and Flutter screens; the canvas clients should show the `catalog` node read-only. Existing WebP media used in replies / carousels may be rejected by WhatsApp (image headers are JPEG / PNG): verify on a real send; only catalogue uploads are converted. The carousel card-button tap shape (interactive vs `button`) is still unverified on a live send. No retention job for `catalog_events`. Native-script keywords only match once Unicode matching is on for the business. Tests: `catalogIds/Settings/Validation/Order/Payload.test.js`, `catalog.service.test.js`, `catalogCollection.service.test.js`, `catalogMedia.service.test.js`, `catalog.controller.test.js`, `webhook.catalog.test.js`, `bookingGraph.prefill.test.js`, `flowGraph.catalogNode.test.js`, `publicServiceForm.catalogPrefill.test.js`, additions to the translation, media usage, inventory, system message and feature switch tests.

## Send catalogue - carousel broadcast (built 2026-10-27, migration `20261027120000_catalog_broadcast.sql`, uncommitted)

The owner picks 2..10 Catalogue collections + an audience; each recipient gets ONE Meta media-card CAROUSEL **marketing template**
message: card = the collection's cover + `title · price` + quick-reply buttons "View designs" (+ "Order" when the catalogue has an order
action). A tap opens the 24h window and routes into the existing catalogue handlers. Needs the `catalogue` AND `broadcasts` switches
(`broadcasts` is OFF by default per business). **Cutover:** nothing changes for any customer until an owner sends one; the migration
is the only deploy step (apply it BEFORE the server: `GET /api/message-templates` filters on `message_templates.kind`).

- **Meta facts used** (checked against Meta's "media card carousel templates" doc): carousel templates are MARKETING only; the
  card count is fixed at creation (2..10) and a send must match it; every card has the same components; card header IMAGE/VIDEO needs an
  `example.header_handle` from the resumable upload; card body optional but all-or-none, <= 160 characters, variables included; <= 2 buttons
  per card; at send the card header is documented as `{ image: { id } }` only, a quick-reply payload per card is allowed, the tap arrives in
  `messages.button.payload`.
- **Templates** (`utils/catalogCarouselTemplate.js`, pure): one reusable system template per (card count, language, button count) per
  business, named `apnabot_catalog_v<TEMPLATE_VERSION>_<cards>_<lang>_<buttons>` (now `apnabot_catalog_v2_3_hi_2`; buttons = 1 without an order
  action, 2 with; only the current version is looked up, so rows from older wording never clash - bump `TEMPLATE_VERSION` when the wording changes).
  Body `Hi {{1}}, our new collection has just arrived. Swipe through the cards below and tap the button to see every design with its price 👇`
  ({{1}} = customer name; fallback "there" / "जी" when none), card body per language, e.g. en `New arrivals in {{1}}. Tap the button below to see all
  designs and prices.` ({{1}} = `title · price`, one plain line; only that value is truncated, to `cardTextMax(lang)` = 160 - the fixed text, ~91 for en;
  Meta forbids a body that starts or ends with a variable and one with too many variables for its length, so `validateSpec` also checks fixed words per
  variable >= `MIN_FIXED_WORDS_PER_VARIABLE` (5) - our approximation, Meta's real threshold is unpublished), buttons = the built-in `catalogViewButton` / `catalogOrderButton` labels (NOT the owner's custom labels). Stored in
  `message_templates` with `kind = 'catalog_carousel'`, `send_support = 'unsupported_component'` (so no normal broadcast / follow-up can
  ever pick one; template sync would write the same value), `meta_components` = BODY + CAROUSEL without the sample handles.
  `GET /api/message-templates` hides them unless `?includeSystem=true`. Status flows through the existing template webhook / sync.
  Languages with wording: `en` (en_US), `hi`, `mr` only; every other customer language is sent English.
- **Creation on demand** (`services/catalogBroadcast.service.js#ensureTemplates`): for each language the audience needs (+ English) that is
  missing / draft / rejected, insert the row, upload one sample per card (this send's covers, resumable upload) and POST
  `/{waba}/message_templates`. Pending / approved / paused / disabled are left alone (a rejected one is resubmitted; a draft left by a failed
  submit is reused). English paused/disabled -> 400 `TEMPLATE_BLOCKED` before anything is submitted.
- **Send** (`sendCatalogBroadcast`): selection -> audience (`resolveAudience`, MARKETING rule) -> templates (202 until English is approved;
  another language that is not approved yet is sent English and reported in `languageFallbacks`) -> each cover uploaded once to Meta media
  (`whatsapp.service.js#uploadImageFromUrl`, JPEG/PNG) -> `broadcasts` row (`kind 'catalog'`, `template_id` = the English variant,
  `catalog_config { collectionIds, cardCount, buttons, templates }`; the id is generated in code because it goes into every payload) ->
  wallet debit (same rules as `sendBroadcast`; billing is off today, rate 0) -> `broadcast_recipients` rows -> jobs of 50. A send that never
  reached the queue marks the broadcast `failed` (there is no draft to go back to) and refunds. Worker: `broadcast.worker.js` has one branch
  for jobs carrying `catalog` (per recipient: the template of its `templateLang`, card texts in that language, payloads); other jobs are untouched.
- **Cards**: active collections with a cover (the collection's cover, else its first photo), in the order asked for, at most the plan's
  `carousel_max_cards` (and 10). Left-out collections are reported (`skipped`: `not_found | inactive | no_cover | over_plan_cap`). A cover
  that is not JPG/PNG (WebP...) is a blocking error `WEBP_COVER`, not a skip. Catalogue switched off -> `CATALOGUE_DISABLED`.
- **Tap attribution**: button payloads are `cat:<collectionId>:p:0:b:<broadcastId>` / `cat:<collectionId>:order:b:<broadcastId>`.
  `catalogIds.js#parseCatalogTapId` accepts the optional `:b:<uuid>` suffix (ids without it parse exactly as before);
  `catalogReply.service.js#handleTap` sets `ctx.broadcastId` only when that broadcast is a `kind 'catalog'` broadcast of THIS business, and
  that tap's `catalog_events` rows get `source 'broadcast'` + `broadcast_id` (every other event is written exactly as before). Replies the
  bot sends next carry no suffix.
- **Broadcasts switch**: the catalogue-broadcast routes answer 404 `errors { code: 'BROADCASTS_DISABLED', feature: 'broadcasts' }`, message
  "Broadcasts are not enabled for your account. Contact support." (`requireCategoryFeature(feature, off)` got an optional second argument; the
  default 404 `FEATURE_DISABLED` is unchanged). Catalogue off -> the catalogue's own `FEATURE_DISABLED`.
- **Refactor of a live path**: `chunk`, `createRecipientRows`, `removeRecipientRows`, `BATCH_SIZE` moved from `broadcast.controller.js` to
  `services/broadcastDispatch.service.js` (mechanical; all broadcast tests unchanged and green). `resolveAudience` also selects
  `preferred_language`.
- **API (owner only)**: `POST /api/catalog/broadcast/preview` and `POST /api/catalog/broadcast`; shapes live in
  `services/catalogBroadcast.service.js` (`previewCatalogBroadcast`, `sendCatalogBroadcast`).
- **Script**: `node src/scripts/testCatalogCarouselTemplate.js --business <id|name> [--collections id,id] [--lang en,hi] [--confirm]` - the dry
  run prints the creation JSON + send components; `--confirm` submits the templates only (never sends to a customer); refuses Search cab AI.
- Tests: `utils/catalogCarouselTemplate.test.js`, `services/catalogBroadcast.service.test.js`, `queues/broadcast.worker.catalog.test.js`,
  `routes/catalogBroadcast.routes.test.js`, `controllers/messageTemplate.listSystem.test.js`, additions to `utils/catalogIds.test.js` and
  `controllers/webhook.catalog.test.js`.

## Human-needed alert ("handoff") (built 2026-10-28, migration `20261028120000_handoff.sql`, uncommitted)

When a customer needs a person, the owner gets ONE `human_needed` push per open escalation, the customer gets an honest reply, and a
"still waiting" reminder follows if nobody answers. Reuses the existing `human_needed` push type / channels / sounds (no new Flutter
sound or channel). **Cutover:** the webhook change is live code on deploy, but customer-visible behaviour changes only for a business
with a `business_handoff_settings` row where `enabled = true`. Existing businesses have NO row (= off, the old "push on every
unmatched message / on `asksForHuman`" behaviour stays exactly as it was - Search cab AI included, it must stay without a row until the
owner decides). New signups (`business.service.js#createBusiness`) get a row with `enabled = true`. Apply the migration BEFORE the
server (the webhook selects the new `customers` columns and the settings table; a missing table fails open to "off" but logs an error).

- **State** on `customers`: `needs_human_at` (NULL = none open), `needs_human_reason` (`tap|keyword|unmatched`), `handoff_cleared_at`,
  `handoff_pause_set_to` (the `bot_paused_until` value the handoff wrote - clearing lifts only a pause that still equals it).
  One guarded UPDATE (`handoff.service.js#raise`) opens it; only the winner pushes / pauses / plans the reminder. Phase A listed 3
  columns; `handoff_pause_set_to` is the 4th (needed so "auto-resume" never undoes an owner's own pause).
- **Triggers** (`webhook.controller.js`, after the `isBotPaused` return, only when handoff is enabled; never in a booking session, while
  paused, or over the limit):
  - *keyword* - a typed message of **<= 6 words** (`utils/handoffMatch.js#HANDOFF_MAX_WORDS`) holding a keyword phrase as whole words
    (`normalizeUnicode`, independent of the per-business Unicode-matching flag, so Devanagari works on the legacy matcher too). Goes
    AHEAD of rule matching, language keyword and opt-in handling; replies and returns. Longer messages fall through.
  - *tap* - a reply node with `reply_kind = 'handoff'` (typed keyword or button tap). Node text wins; the settings/built-in text only
    when the node's text is empty. With handoff off the node is a plain text reply (never an empty message).
  - *unmatched* - the Nth (`unmatched_threshold`, default 3, 0 = off) unmatched message in a row (Redis `handoff:unmatched:<biz>:<cust>`,
    24h; acknowledgements, taps and smart-fallback-answered messages don't count; a matched rule / tap / booking start resets). The Nth
    is answered with the handoff reply. 30-minute cooldown after a clear (tap / keyword bypass it). Redis failure fails open (no escalation).
  - A repeat trigger while one is open still answers the customer but sends no push, no reminder, no event.
- **Default keywords** (`utils/handoffSettings.js`): talk to, speak to, call me, agent, human, owner, customer care, बात करनी है,
  बात करना, बोलायचं आहे, बोलायचे आहे, मालक, baat karni, baat karna, bolaycha, malak (NOT `person`, NOT bare `बात`).
- **Reply text**: built-in `handoffReply` / `handoffClosed` (en/hi/mr, `systemMessages.js`) or the business's own
  `reply_text` / `closed_text` (+ translations). Closed variant only when `hours` is set and it is closed now (India time);
  `{{nextOpening}}` = "today at 10:00 am" / "tomorrow at 9:00 am" / "Monday at 10:00 am" (`utils/handoffHours.js`, hi/mr wording is
  new and wants a native-speaker review). `hours` null = the closed text is never sent. A node with its own text never gets the closed
  variant (flagged: a business wanting it should leave the node text empty).
- **Bot pause**: `pause_bot_minutes` (0 = leave the bot on) - never shortens a pause already in force (an owner's "forever" included).
- **Reminder**: BullMQ queue `handoff-reminder` (`queues/handoffReminder.{queue,worker}.js`, started in `server.js`), job id
  `handoff-reminder-<customerId>-<needsHumanAt epoch>`, `reminder_minutes` (default 15, 0 = none); the worker re-checks
  `needs_human_at` before pushing, so a lost cancel is harmless. Reminder = `human_needed` with a "still waiting" body (en/hi/mr).
  While an escalation is open the `customer_waiting` job is NOT scheduled (`notifyNewMessage(..., { skipWaitingCheck })`); `new_message`
  pushes stay. Reminder jobs live in Redis: a flushed Redis loses them (the DB row is the truth; no sweep).
- **Clear paths** (`handoff.service.js#clear`): dashboard / app send (`message.controller.js#afterManualSend`, covers `send` and
  `send-payment-qr`), a phone-app reply (`coexistence.service.js#decideEchoPause`, genuine echoes only), and `POST /api/customers/:id/handoff/clear`
  ("Mark done"). Each stamps `handoff_cleared_at`, cancels the reminder, emits the socket event; `auto_resume_bot` lifts the handoff's
  OWN pause only. A staff/owner reply also pauses the bot 24h (existing behaviour), so auto-resume only matters for Mark done.
- **API**: `GET/PUT /api/business/handoff-settings` (owner only, shape in `utils/handoffSettings.js`); `GET /api/messages` items gain
  `needsHuman: { since, reason } | null` and accept `?needsHuman=true`; `getDashboardStats` gains `needsHumanCount`; socket event
  `needs_human` `{ customerId, needsHuman: { since, reason } | null }`.
- **Script**: `node src/scripts/convertTalkToHandoff.js [--templates] [--business=<id>] [--keyword=talk] [--expect-nodes=N] [--confirm]` -
  dry run by default; converts plain-text reply nodes whose keyword is `talk` to `reply_kind='handoff'` in category templates and/or
  one named business (then flushes its `rules:`/`tenant:` caches); REFUSES Search cab AI by name; aborts `--confirm` if the migration
  is not applied. The 2026-10-21 dry run found 5 template nodes (software_it, gym, clothing_wholesaler, photographer, menswear);
  the `maha_eseva_kendra` template's text-only `contact` node and the medical/hotel/coaching `contact` nodes are NOT converted
  (different keyword; some carry buttons) - decide separately.
- **Not built**: Flutter UI (inbox badge / filter, Mark done, settings screen, handoff kind in the reply-node editor, dashboard count),
  web UI, a hours editor. **Staff cannot send messages from the app** (`POST /api/messages/send` is owner/superadmin only), so staff can
  only Mark done.
- Tests: `utils/handoffMatch.test.js`, `utils/handoffHours.test.js`, `utils/handoffSettings.test.js`, `services/handoff.service.test.js`,
  `controllers/webhook.handoff.test.js`, additions to `services/notification.service.test.js`.

## Message counter per subscription period (built 2026-10-29, migration `20261029120000_usage_periods.sql`, uncommitted)

The plan's `msg_limit` is now counted per **subscription period**, not per calendar month, and counts **outbound messages sent through ApnaBot only**.

- **Schema.** `subscriptions.current_period_start` (timestamptz, NULL = not set: readers fall back to `start_date`; an autopay row with NULL is still on its 48-hour placeholder `end_date`). `usage_periods (business_id, period_start, period_end, outbound_count)`, PK (business_id, period_start), RLS on. RPC `increment_usage_period(p_business_id, p_period_start, p_period_end, p_delta)`: atomic upsert-and-add, returns the new total (no read-then-write, no batching). The old `usage` table is no longer written.
- **Period.** `utils/usagePeriod.js#resolvePeriod(subscription, now)`. Autopay with a real cycle: `current_period_start` .. `end_date` (Razorpay's cycle); with no `current_period_start` yet: `periodEnd` is null (never the placeholder end). Everything else (one-time purchase, trial, admin grant): one-month windows stepping forward from `current_period_start` (so a 3-month purchase or a stacked renewal still resets monthly), a window never past `end_date`. No subscription: India-time calendar month.
- **Where `current_period_start` is set.** `subscription.service#createSubscription` (new, renewal after expiry, reactivation, trial -> paid: now; a **stacked early renewal** - same plan bought before the running one ends - carries the running row's period, so it does not reset), Razorpay `subscription.activated` and `subscription.charged` (`rzpSub.current_start`; unchanged when the payload has none), admin extend when it revives an expired row (status expired, or end_date already past), and `grantSubscription`. `createAutopaySubscriptionRow` leaves it NULL on purpose.
- **What is counted.** Bot replies, owner/staff replies from the app or web, broadcasts, payment links, reminders, handoff messages, the web-form confirmation. Not counted: inbound messages, booking events, echoes of messages sent from the WhatsApp phone app (`sender_type phone_app`), platform notices to owners. `usageService.recordOutbound(businessId, { count })` is called after Meta accepts the send: `whatsapp.worker.js` (every queued send, one unit per job, `job.countAs` default 1, 0 = none), and the four direct sends that bypass the queue: `broadcast.worker.js` (once per batch, count = sent), the `windowAwareSend` template path, `sessionTimeout.worker.js`, the `publicServiceForm` confirmation. All old per-call-site `incrementUsage` calls (webhook.controller, booking, bookingConsent, catalogReply, payment, windowAwareSend) are gone - **do not add one**; it would double count.
- **Redis.** Key `usage:<businessId>:<periodStartISO>` (hash field `used`), TTL to period end + 7 days (31 days + 7 when the end is unknown). The RPC total is the truth; Redis is raised to it with a Lua max-set. Fails open on any Redis error; a database error falls back to counting in Redis.
- **API.** `GET /api/subscription` and the dashboard stats (`usage`; `currentMonthUsage` is the same object) return `usage: { used, limit, periodStart, periodEnd, resetsOn, msgCount }`, ISO strings; `limit` is the plan's `msg_limit` (-1 unlimited, null no plan); `msgCount` equals `used` for older clients; `periodEnd` / `resetsOn` are null for an autopay row still on its placeholder. The socket `usage_update` event is now emitted from `recordOutbound` (`{ msgCount, used, limit }`). `inboundCount` / `bookingCount` / `paymentLinkCount` are no longer returned.
- **Alerts.** `usage_90` / `usage_100` push once per **period** (dedupe key `<businessId>:<periodStartISO>`), not once per calendar month.
- **Backfill.** `src/scripts/backfillUsagePeriods.js` (dry run default, `--confirm`; migration first). Sets `current_period_start` (autopay: `end_date` minus one month, else `start_date`) and seeds this period's `outbound_count` from `messages` (outbound, bot/human). Search cab AI is skipped on `--confirm` unless `--include-live`, and is always seeded 0. Never overwrites an existing `usage_periods` row. Broadcast sends have no `messages` row, so they are not in the seeded number.
- **Web-form submit duplicate protection.** `POST /api/public/service-form/:token/submit` accepts an optional `Idempotency-Key` header (8-128 chars of A-Z a-z 0-9 . _ : -; else 400). Redis `formsubmit:<token>:<key>` is `pending` (120 s) while the first request runs, then the booking id for 24 h. A repeat returns the original 200 success and creates no booking (checked before the used-token 410); a repeat while the first is running waits up to 10 s, then 409. A request that fails without creating a booking releases the key (so a corrected resubmit with the same key works). Redis error: fails open (unprotected). `createBookingAndConfirmation` now also returns `bookingId`.
- **Form field roles.** `GET /api/public/service-form/:token` adds `role` to each field that has none stored (response only, never saved; a stored role is never overwritten): the travel roles as before, else `answerValidation.js#fieldRole`: `checkIn` | `checkOut` | `dob` | `name` (text field with a person-name key) | `date` (date field, or text field with a date key). Same tests the bot and submit validation use.
- **Submit 422 codes.** `errors: [{ field, code, message }]` (message localized to the customer's language, top-level `message` = the first): `invalid_name`, `invalid_date`, `date_in_past`, `date_too_far`, `checkout_not_after_checkin`, `closed_day`. Other submit responses: 400 (bad key, missing / invalid values), 409 (still processing), 410 (link expired or used).
- **Tests.** `usagePeriod.test.js`, `usage.service.test.js`, `subscription.service.usagePeriod.test.js`, `payment.service.activated/charged.test.js`, `admin.extendSubscription.test.js`, `whatsapp.worker.test.js`, `broadcast.worker.test.js`, `windowAwareSend.service.test.js`, `publicServiceForm.idempotency.test.js`, `webhook.catalog.test.js`; the webhook suites assert the webhook counts nothing itself. Any test that loads `whatsapp.worker` must stub `usage.service` (the real one opens Redis).
- **Deploy.** One-time cutover: apply the migration, run the backfill (dry run, then `--confirm`), then deploy; metering changes for every live business at once (broadcasts and owner replies now count; inbound and bookings no longer do). Known data issue: two businesses (`3e8dea25...`, Shambhu Men's Wear) have both an active and a trial row.

## Unlisted business at signup + support number (built 2026-10-31, migration `20261026140000_business_requests.sql`)

**Unlisted business.** An owner whose kind of business is not in the category list signs up as `general` and says what they are.
- **Signup body** (`POST /api/business`): optional `requestedCategoryText` (trimmed, inner spaces collapsed, <= 100 chars; blank = not
  sent) and `requestContactPhone` (REQUIRED when the text is present: 10 digits -> `91` + digits, or 11-15 digits with the country
  code; separators and a leading `+` dropped; stored digits only - `utils/contactPhone.js`). The category must be `general`, else 400.
- **Schema.** `businesses.requested_category_text` (written in the same insert as the business) and `business_requests` (`business_id`
  fk cascade, `requested_text`, `contact_phone`, `owner_name` / `owner_email` snapshot, `status` new|contacted|set_up, `notes`,
  timestamps; RLS on, no policies).
- **Recording + notification** (`businessRequest.service.js#recordRequest`): runs right after the business insert, NOT awaited, never
  rejects - a failed insert, recipient lookup or mail is only logged and signup always succeeds. Notification is **email**
  (`email.service#sendBusinessRequestEmail`, owner text HTML-escaped) to every active `superadmin` user, or to the comma-separated
  `BUSINESS_REQUEST_NOTIFY_EMAIL` when set (replaces the list). Push is not used: `notification.service` is scoped to a business's
  own users/devices and `device_tokens.business_id` is NOT NULL, so a superadmin (no business) has no device row.
- **Super Admin** (superadmin only, above the `/api/admin` catch-all): `GET /api/admin/business-requests?status=&page=&limit=` (newest
  first, joined `businessName` / `businessCategory`, `{ requests, pagination }`) and `PUT /api/admin/business-requests/:id`
  `{ status?, notes? }`. **Changing the business's category:** `PUT /api/admin/businesses/:id/category { businessCategory }` - any known
  category except `multi_brand`; changes the category AND recomputes `business_travel_settings` enable_fleet / enable_distance_fares /
  round_trip_driver_da_enabled with `computeFeatureFlags` (overwrites those three), drops the rules cache and the tenant cache (a Redis
  failure there only sets `cacheInvalidated:false`). It does NOT re-seed the flow or form - use `copy-setup`. If the flags write fails
  after the category write, repeat the request (idempotent).
- **Not built:** no Super Admin UI yet; no email to the owner; nothing links a `set_up` request to the copy-setup run.

**Support WhatsApp number.** `GET /api/app/version` (public, no auth - reachable from the login / register screens) now also returns
`supportWhatsappNumber` (digits with country code, `''` = no support button, default `''`) and `supportMessage` (<= 500 chars; default
"Hi, I need help with ApnaBot. Business: {{businessName}}, email: {{email}}"). The server returns the marks as written; **clients fill
`{{businessName}}` and `{{email}}`** (no user exists before login). Editable through `PUT /api/admin/app-config` (keys
`support_whatsapp_number`, `support_message` in `app_config`; no migration - a missing key serves the default; a number is normalised like
the signup phone).

- **Deploy.** Apply the migration BEFORE the server. One-time cutover for signup only in the sense that the new fields are accepted from
  the moment this is deployed; a normal signup (no `requestedCategoryText`) behaves exactly as before. No webhook / booking path touched
  (Search cab AI unaffected). Tests: `business.requestedCategory.test.js`, `businessRequest.routes.test.js`,
  `admin.changeCategory.test.js`, `contactPhone.test.js`, `appConfig.routes.test.js`.

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

8. ~~**Meta error 131050 (user stopped marketing messages) doesn't set
   `opted_out_at`**~~ - built 2026-10-14 as a separate `customers.marketing_blocked_at`
   (marketing rule only; see "Account health & stopped marketing"). 131050 is now
   verified against Meta's error-code page: the recipient chose to stop marketing
   messages from the business; do not retry. Still open: the web / Flutter labels and
   badge, and subscribing the `user_preferences` webhook field in the Meta dashboard.

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
19. ~~Language-picker titles use `.slice(0, 20)`~~ - fixed 2026-10-24: the picker is built once in
   `languagePicker.service.js` with the grapheme-safe `truncate`.
20. **Chat redesign leftovers (2026-10-14).** The tapped button / list id is not stored (an inbound tap is
   `type 'interactive'` with the tapped title as `content`); inbound location lat/lng are not stored (only
   the "📍 Location · name · address" text); outbound pin coordinates are not stored; the web inbox does not
   show `sentByName` yet; list messages have no header image because `sendListMessage` /
   `sendRuleListMessage` ignore `imageUrl`.
21. **`plans.rule_limit` is seeded (10 / 50 / -1) and editable in Super Admin but never enforced** anywhere in
   `src/`; there is no plan limit on the number of reply nodes (the carousel-bundle endpoint therefore has none either).

22. **System texts for gu/kn/ta/te/ml/bn/pa/or (HIGH priority) - tooling built 2026-10-20, no reviewed text shipped yet.** `utils/systemMessages.js` (about 100 customer-facing strings:
   booking confirmation, payment, fallbacks...) only has `en`/`hi`/`mr`; the new languages get English for these. Plan: a
   reviewed static file (generated offline with a dry-run script, checked by a native speaker), not runtime machine translation.
   Same for the picker's "Choose your language" wording and the web booking-form strings in `apnabot-web`.
   Built: `scripts/exportSystemMessagesForReview.js` (dry-run default; `--confirm` machine-translates via `translateTexts` scope
   `system`, global Azure cap only, and writes `docs/translations-review/system-messages-<lang>.csv`: key, english,
   machine_translation, reviewed_translation, notes; 46 messages = 45 system + the built-in `chooseLanguageLine`, ~3.5k chars x 8
   languages) -> native reviewer fills `reviewed_translation` -> `scripts/importReviewedSystemMessages.js <csv>` (dry-run default;
   only reviewed text, empty rows skipped, placeholder mismatch rejects the row) writes `src/i18n/systemMessages.<lang>.js`, which
   `getSystemMessage` loads after `SYSTEM_MESSAGES` (hi/mr unchanged); missing keys/files = English. The picker's built-in line prefers
   a reviewed `chooseLanguageLine`. Pure logic in `utils/systemMessagesReview.js`. Still open: the reviews themselves, the web strings.
   Also `scripts/capBusinessLanguages.js` (dry-run default) trims any business left with >3 languages to en + first 2 and resets
   customers on the removed ones; it never writes Search cab AI. Dry run 2026-10-20: no business is over 3.
23. **Template `flow_fields` translation.** `POST /api/translate/flow` covers `businesses.flow_fields`;
   `business_category_templates.flow_fields` (what a new business is seeded with) is not covered by the Super Admin template
   translate, so a new business's booking-form labels are translated by the signup run, not pre-translated.
24. **`services/translate.service.js` is dead code** (Anthropic-based rule-reply translator, no caller; the Azure path is
   `azureTranslate.service.js` / `translation.service.js`). Delete it when convenient.
25. **Owner-app language vs bot language.** `notification.service.js` (`LANGUAGES`, owner push voice) and
   `help.controller.js` (`FEEDBACK_LOCALES`) stay `en/hi/mr` on purpose: they are the OWNER's app language, not the bot's.
26. **Native-script keyword matching (Phase 2) - BUILT, behind a switch, OFF everywhere.** The legacy
   `chatbot.service.js#normalizeText` strips `[^ws]` and JS `w` is ASCII-only, so a Devanagari / Gujarati / Tamil...
   message normalized to '' and matched nothing. New: `utils/textNormalize.js` (`normalizeLegacy` kept byte-for-byte,
   `normalizeUnicode`: NFC, lowercase, invisibles (ZWJ/ZWNJ...) removed, Indic digits -> 0-9, keep letters + marks + digits + '_',
   collapse whitespace THEN trim). `matchNodeInListDetailed(nodes, text, { unicode })` in chatbot.service.js: with `unicode` it adds
   (a) a matra boundary guard (a native keyword hit may not stop before a combining mark, so "क" never matches inside "की"),
   (b) code-point fuzzy with native thresholds (OFF below 6 code points, 1 edit up to 9, 2 from 10; ASCII keywords keep 1/2/3),
   (c) a mixed-script fallback: if the full text matches nothing, run again on its ASCII projection ("hi भाई" -> "hi").
   Known, intended differences from legacy for ASCII text: "hi !" no longer leaves a trailing space; accented Latin (café) keeps its accent.
   **Flag:** `businesses.unicode_matching` (boolean, NULL = follow the global) + `app_config.unicode_matching_default` (absent = false;
   Super Admin PUT /api/admin/app-config `unicodeMatchingDefault`). `services/unicodeMatching.service.js` resolves it with a ~60s
   in-process cache and fails OPEN to legacy. **Shadow log:** every inbound text runs both matchers; the live answer is the enabled one.
   Flag OFF logs every difference, flag ON logs only `old_only`; line prefix `[unicode-match-shadow]`, JSON
   `{businessId, oldNodeId, newNodeId, messageSample, reason}`, reasons old_only / mixed_fallback / native_only / different_node.
   **Replay:** `node src/scripts/replayUnicodeMatching.js --business <id> [--limit 1000]` (read-only, refuses Search cab AI).
   FlowSpec v1/v2 duplicate / min-length / overlap checks take `{ unicode }` and follow the business flag (aiFlow, botSettings).
   The draft preview (botSettingsPreview) follows the flag. Migration `20261025120000_unicode_matching.sql` - apply BEFORE deploying.
   Open: client/app keyword inputs need no change (no ASCII validation exists); owners cannot yet author native keywords through the
   FlowSpec wizards until the flag is on for their business (legacy min-length check rejects them). The 4-character keyword minimum
   counts code points, so a 3-code-point native word is refused.
27. **Follow-up automation texts** (`followup_automations.message_text_translations`) are not covered by `/api/translate/flow`.
28. **Server duplicate-keyword checks compare the raw lowercased string** (`flowGraph.controller.js` create/update, and
   `flowGraph.service.js`), not the normalized one, so a ZWJ / danda / punctuation variant of an existing keyword slips through as a
   "different" keyword. Follow-up to gap #26; not fixed.
29. **`carouselBundle.service.js` builds an ASCII slug from card text**, so a card with only native-script text gets an empty slug.
   Follow-up to gap #26; not fixed.
30. **Broadcast scheduling is not implemented** (any broadcast): `broadcasts.scheduled_at` and the `'scheduled'` status exist in the schema
   but nothing sets or reads them, and there is no scheduled-send route or delayed job. The catalogue broadcast therefore has no `scheduleAt`.
31. **Catalogue broadcast v1 limits**: the body is the fixed greeting (no owner free-text message - a second variable would raise the chance
   Meta rejects the template); the button labels are the fixed built-ins (custom labels would need a hash in the template name and a new
   approval per edit); only `en` / `hi` / `mr` have template wording (hi / mr need a native-speaker review), every other language gets English.
32. **Catalogue broadcast is unverified against a live Meta account**. First live submit (2026-10-21): Meta REJECTED `apnabot_catalog_2_en_1` with
   `error_subcode 2388293` "Params Words Ratio Exceeds Limit - too many variables for its length" - the card body `✨ {{1}} ✨` was nearly all
   variable. Fixed by new wording + versioned names (`apnabot_catalog_v2_*`, see Templates above); the old unversioned row stays in
   `message_templates` unused. **The v2 wording has not been submitted yet**: re-run `testCatalogCarouselTemplate.js --confirm` on a test business. A
   submit Meta refuses with 400 / code 100 now marks the row `rejected` with Meta's `error_user_msg`; other failures leave the draft. Still open:
   `image.id`
   in the card header at send (the doc documents only `id`), and whether a carousel-template quick-reply tap arrives as `type 'button'`
   (handled) or `interactive` (also handled). Run `testCatalogCarouselTemplate.js --confirm` and one small send on a test business (not
   Search cab AI) before offering it to owners. Meta's payload length limit was not checked (ours are ~83 characters).
33. **Catalogue broadcast has no web / Flutter screen**, and the broadcast detail does not show taps per broadcast yet
   (`catalog_events.broadcast_id` is recorded for it).
34. **Handoff v1 limits** (see "Human-needed alert"): staff cannot send from the app (`/api/messages/send` is owner-only), only Mark done;
    hours are India time only, single-day ranges (no overnight range); keyword matching is whole-word, so an inflected form
    ("मालकाशी") needs its own phrase; the unmatched counter resets on a rule / tap / booking START, not on each booking step;
    `botSettingsPreview.service.js` (Bot Builder draft preview) does not render a handoff node (presets never produce one);
    `GET /api/customers` / chat payloads now carry the raw `needsHumanAt` / `needsHumanReason` / `handoffClearedAt` /
    `handoffPauseSetTo` fields because they select `*`.

## Session log (append here as major milestones land)
- 2026-10-28: Human-needed alert ("handoff"): migration `20261028120000_handoff.sql` (apply BEFORE the server), `business_handoff_settings`,
  `reply_kind = 'handoff'`, reminder queue, `convertTalkToHandoff.js`. Off for every existing business (no row); on for new signups.
- 2026-10-27: Send catalogue carousel broadcast (see "Send catalogue - carousel broadcast"): migration `20261027120000_catalog_broadcast.sql`
  must be applied before deploying. Working tree only, not committed. No customer-facing change until an owner sends one; needs the
  `broadcasts` switch (off by default). Search cab AI untouched (it has broadcasts off).
- 2026-10-25: Native-script keyword matching (gap #26): shadow mode + per-business / global switch, all OFF. Working tree only,
  not committed. **Deploy: apply `20261025120000_unicode_matching.sql` first, then the server.** No behaviour change until a
  business (or the global default) is switched on; Search cab AI stays on legacy matching and is only read by the shadow log.
- 2026-10-24: Bot languages (en + up to 3 of 11), language picker (buttons / list, change keyword, mode off), Language virtual node,
  Azure auto-translate with cache + caps, "auto-translated" markers, signup default-flow translation - see "Bot languages, language
  picker, auto-translate". Migrations `20261024120000`, `20261024130000` must be applied before deploying.
- 2026-10-18: Mobile app version gate (see "Mobile app version gate"): `app_config` table, public
  `GET /api/app/version`, superadmin `GET|PUT /api/admin/app-config`. Working tree only, not committed.
  **Deploy: apply `20261018120000_app_config.sql` first, then the server.** Additive; no client reads it yet.
- 2026-10-11: Staff & Broadcasts per-business switches (see "Staff & Broadcasts switches"): keys `staff` and
  `broadcasts`, off by default, route guards on `/api/staff` (management only; existing staff keep working)
  and `/api/broadcasts` (queued broadcasts finish sending), and `GET /api/features`. Commits 1e5c472,
  f9a35f6, 7e18ec9, 7aef138, a3e30b6 (local, not pushed). **Deploy: the constraint-widening migration
  `20261015120000_staff_broadcasts_features.sql` is already applied; deploy the server. No second SQL file.**
  One-time cutover, no flag: at deploy every business loses both screens' API access (404) until Super Admin
  switches them On - **Search cab AI included**, which uses neither. SG Travels and Averix (demos) are switched
  On by hand in Super Admin. Clients still show the two nav items until they read `GET /api/features`.
- 2026-10-10: Auth sessions (see "Auth sessions & refresh tokens"): per-login sessions, rotating refresh
  tokens with a 30s grace window, public `GET /api/subscription/plans`, and sessions ended for removed or
  deactivated staff. Commits 49ff028, 5d472fe, c4d2765 (local, not pushed). **Deploy: set
  `JWT_REFRESH_EXPIRY=30d` on Render; one-time cutover, no flag - every logged-in user must log in once.
  Do not push until web, Super Admin and Flutter store the rotated `refreshToken`.**
- 2026-10-14: Chat redesign server support (see "Chat redesign support"): `messages.sent_by_user_id` /
  `sent_by_name` / `interactive_payload` (migration `20261014140000`), the payload helper and its save
  sites, `PUT /api/messages/customer/:customerId/read`, and the outbound location pin text. Commits
  108ff65, c91529c, 2e13942, aabcba6, 684a7cb (local, not pushed). **Deploy: apply `20261014140000`
  first, run `supabase/verification/verify_messages_chat_columns.sql`, then deploy the server.**
  One-time cutover, no flag: every bot reply insert changes at deploy for all businesses (Search cab AI
  included); customer-facing WhatsApp messages do not.
- 2026-10-10: Variable values are cleaned before they go into outgoing text (built, not yet deployed; a
  one-time cutover, no flag). `utils/templateValue.js` (`cleanValue`, `fillPlaceholders`) is the one
  place: names collapse whitespace and trim (so `*{{businessName}}*` bolds even if the name has a
  trailing space), address / business hours trim the ends only. Used by `applyMessageTemplate`,
  follow-up text and template params, system messages, coaching translations, opt-in prefill and the demo
  reminder. `templateComponents.js#textParams` also collapses every Meta template parameter (no newlines,
  tabs or 4+ spaces; broadcasts included; button URL suffix trims the ends only). Business name / display
  name / city / address and customer names (WhatsApp profile name, coexistence contacts) are trimmed on
  save; an empty business name is a 400 on create and update. Existing rows are not rewritten.
- 2026-10-14: Account health & stopped marketing (see that section): `businesses.payment_issue_at` /
  `payment_issue_code` (Meta 131042 -> `paymentIssue` on `GET /api/business`, owner dismiss) and
  `customers.marketing_blocked_at` (Meta 131050 / `user_preferences` -> `marketing_stopped` skip reason).
  **Deploy: apply `20261014120000` and `20261014130000` first (either order), run
  `supabase/verification/verify_marketing_blocked.sql` in the SQL editor, then deploy the server; then
  subscribe the `user_preferences` field in the Meta app.** One-time cutover, no flag: the status webhook,
  broadcast worker, `windowAwareSend`, the START keyword handler and every marketing audience / follow-up
  query change for all businesses (Search cab AI included) at deploy; both flags start empty, so nothing
  differs until Meta reports a first 131042 / 131050.
- 2026-10-13: Delivery tracking, commit B (broadcasts; see "Delivery tracking, broadcasts").
  **Deploy: apply `20261013120000` (commit A) first if not yet applied, then `20261013130000`, run
  `supabase/verification/verify_broadcast_recipients.sql`, then deploy the server.** One-time cutover,
  no flag: from the deploy on, every broadcast (Search cab AI's included) gets recipient rows and its
  status webhooks are applied to them. If the migration is missing, `sendBroadcast` still sends (row
  creation only logs an error) and statuses are logged as failing. A broadcast already mid-send at the
  deploy has no rows and finishes with the old counters. Also: `fromSendError` now stores Meta's
  `message` as the title (it stored the exception type, e.g. "OAuthException").
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
- 2026-10-17: Web-form name — optional `flow_nodes.form_title` (≤60) /
  `form_title_translations` on `web_form_trigger` replies, set via
  `formTitle`/`formTitleTranslations` on `POST|PUT /api/flow-graph/reply-nodes`
  and `PUT /api/flow-graph/full`, and `forms[].title`/`titleTranslations` in
  FlowSpec v2. Shown as the public form's title, snapshotted on
  `bookings.form_title`. `GET /api/bookings?formTitle=` (exact) and
  `GET /api/bookings/form-titles` (distinct names) for the filter.
  Migration `20261017120000_flow_nodes_form_title.sql` (also re-creates
  `save_flow_graph_full` and adds `distinct_booking_form_titles`; **apply
  after 20261016 and before the server deploy**).
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
- 2026-10-29: per-period message counter (outbound only, `usage_periods`, `increment_usage_period`, `subscriptions.current_period_start`), web-form `Idempotency-Key`, form field roles - see "Message counter per subscription period". Catalogue photo page = 1 unit via `countAs`.
- 2026-10-30: messages chat time (`wa_timestamp` / generated `message_time`, `before=<messageTime>|<id>` cursor, `messageTime` / `lastMessageTime` / `lastMessageType` / `lastMessageOriginalType`, socket `new_message` times, backfill script) - see "`messages` chat time" under the schema notes. Working tree only; migration not applied.

- 2026-10-31: unlisted business at signup (`requestedCategoryText` + `requestContactPhone`, `business_requests`, team email, Super Admin list/update, `PUT /api/admin/businesses/:id/category`) and `supportWhatsappNumber` / `supportMessage` on `GET /api/app/version` - see "Unlisted business at signup + support number". Migration `20261026140000_business_requests.sql` must be applied BEFORE the server.
