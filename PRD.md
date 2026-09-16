# ApnaBot-server — Project State

Multi-tenant WhatsApp chatbot backend for Indian SMBs (travels/cab,
software/IT, tax consulting, medical, e-seva/internet-cafe, and
multi-brand verticals so far). Node/Express + Supabase (Postgres) +
Upstash Redis + BullMQ. Owner: Suresh Gavali (Averix Solutions Pvt Ltd —
the owner's own company; **not** a business tenant on the platform, see
below).

**No production customers yet.** All 5 businesses currently in the live
`businesses` table are test/demo accounts under the owner's control —
freely resettable, no real customer data to protect. Confirmed directly
against the live database on 2026-09-16 (not carried over from prior doc
revisions or scripts):

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
  in-chat — **this mechanism is not documented anywhere else in this
  file.** Not investigated or written up further this pass since it's
  outside this correction's scope (business inventory + this specific
  stale claim); flagged to the user as a real documentation gap, not
  silently left implied to be covered by the graph-engine description
  above.

### CRUD for the graph engine — full node + edge CRUD, mounted at `/api/flow-graph`
`src/middleware/flowGraph.middleware.js` (`requireGraphEngine`),
`src/controllers/flowGraph.controller.js`, `src/routes/flowGraph.routes.js`.
Structural safety lives in `src/utils/flowGraphValidation.js` (`findCycles`,
`findUnreachableNodes`, `findFallbackSiblingNodeIds`,
`resolveBookingTriggerEntryNodeIds`) — pure functions over `{nodes, edges}`,
called by every mutating handler via the controller's private
`assertGraphStillValid` before it writes.

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
  `business_id` null, `category` set) — SuperAdmin-owned, one per category
  (not DB-enforced), managed at `/api/admin/category-templates`
  (`GET` list, `POST /clone-from-business` to seed one from an existing
  business's live graph, `DELETE /:id`).
- `business.service.js#createBusiness` looks up the active template for the
  new business's category and, if one exists, copies its nodes/edges into
  the new business's `flow_nodes`/`flow_edges` via
  `flowSnapshot.service.js#writeBusinessGraphRows` at signup. If none
  exists, the business still starts with a literal empty graph, same as
  before — the owner builds it from scratch via `/api/flow-graph`.

As of 2026-09-02 the live `flow_snapshots` table is empty (0 rows) — the
feature is fully built and wired in, just not yet exercised: no business
has taken a personal snapshot yet and no category template has been cloned
yet.

### Visual flow canvas (frontend — `apnabot-web`, not this repo)

`FlowGraphCanvas.tsx` is a fully editable node/edge canvas — node creation,
drag-to-connect for unwired options/single-links, click-to-edit, delete via
trash icon or Delete key. The old List-view tab is gone; canvas + a docked
detail panel (opens on node selection) + a Versions tab (built on the
snapshot endpoints above) are the only editing surface now. This used to be
tracked as a deferred "future initiative" — it's built and live.

## Data model reference

- `businesses` — core tenant table. `business_category` gates category-
  template selection at signup. `disabled_booking_fields`, `served_cities`
  are live per-business config, applied as an OVERLAY at read time by the
  graph engine (never baked into stored flow data).
- `business_type_templates` — still exists; historically the category
  starting point copied at business creation for the old engine and the
  one-time graph migration. Not read by `createBusiness` anymore now that
  `flow_snapshots` category templates cover that role — worth confirming
  with the user whether this table is still the source SuperAdmin edits
  for anything live, or itself dead weight now.

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

## Session log (append here as major milestones land)
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
