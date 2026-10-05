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
- **Broadcasts to parents (`broadcasts.audience_filter = 'coaching_requests'`
  + `audience_params { form: demo|admission|any, course, skipClosed }`):**
  besides all opted-in customers, a coaching business (Courses switch on)
  can broadcast to parents with a matching Free demo / Admission request
  (`bookings.form_key`, optionally `fields.course`, by default skipping
  cancelled = "Not interested" / "Not joining"). Still opted-in, non-blocked
  customers only and still an approved template; one parent counts once.
  `services/broadcastAudience.service.js#resolveAudience` is used by the
  preview, the send and `POST /api/broadcasts/audience-count` (live count
  in the composer), so the count shown is who gets it.
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
- `message_templates` — one row per WhatsApp template. `source` (`app` |
  `meta_sync`), `meta_template_id`, `status` (draft, pending, approved,
  rejected, paused, disabled, deleted), raw `meta_status`, `quality_score`,
  `meta_components` (Meta's components as last synced), `send_support`,
  `last_synced_at`, `meta_deleted_at`. Unique per business on
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

## Session log (append here as major milestones land)
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
  reply, copy code, flow, catalog and OTP buttons stay `unsupported_component`.
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
