# Follow-up Automations — Feature Status & Test Plan

_Last updated: 2026-10-03_

Automatic WhatsApp messages a business owner sets up once ("automations"), which the server then sends to matching customers at the right time — e.g. nudge someone who enquired but didn't book, ask for a review after a completed booking, remind about a pending payment, or win back customers who went quiet.

---

## 1. Status at a glance

| Area | Status |
|---|---|
| Phase 1 — schema, shared sender, India-time helpers, STOP = lasting opt-out | ✅ Done, committed (`1e1fb94`) |
| Phase 2 — sweeper, owner API, **Enquiry follow-up** + **Win back** | ✅ Done, committed (`5253065`) |
| Phase 3 — **Review request** + **Payment reminder** | ✅ Done, committed (`065f4fd`), migration applied live |
| Phase 4 — web UI (list, wizard, send log, opted-out badge) | ✅ Done, committed (web `915ba05`, `2cc9ed3`) |
| Flutter — "Opted out (sent STOP)" badge | ✅ Done, committed (app `53186f7`) |
| Redis connection fix (deploy "max clients" errors) | ✅ Done, committed (`7062bbd`) |
| **Go-live** (switch on for a business + enable the sweeper) | ⏳ Not yet — see §6 |

Live state (checked 2026-10-03): all migrations applied; `followups` switched on for **0** businesses; **0** automations; sweeper not enabled.

---

## 2. How it works (short)

- **Owner** creates an automation in the web dashboard (**Follow-ups** menu) from a preset or custom. It's saved **off**; the owner switches it on.
- **Sweeper** (server, every 15 min when `ENABLE_FOLLOWUP_SWEEPER=true`) finds customers / bookings that are due, and for each one:
  1. **Claims** it in `followup_sends` (a unique key makes each occurrence send at most once),
  2. **Re-checks** the customer/booking as they are *now*,
  3. **Sends**: free text if the customer's 24-hour WhatsApp window is open, otherwise the approved template (wallet-charged when billing is on),
  4. **Records** the outcome (sent / skipped / failed + reason) — visible in the send log.
- **Availability** is controlled by Super Admin → Features → "Follow-up automations" (per category or per business). Off everywhere by default.

### Presets

| Preset | When it sends | Message type | Template | Defaults |
|---|---|---|---|---|
| 💬 Enquiry follow-up | 30 min – 23 h after the customer's **last message** (default 3 h), only while the free chat window is still open | Marketing (free text, no opt-in needed) | None — free text only | 9 AM–9 PM, 3 per customer, 100/day |
| 🔁 Win back | 7 – 180 days with **no messages** (default 30 days) | Marketing (opt-in required) | Approved **Marketing** template required | 10 AM–8 PM, 2 per customer, 50/day |
| ⭐ Review request | 30 min – 14 days after a booking is **completed** (default 1 day) | Utility (no opt-in) | Approved **Utility** template required | 10 AM–8 PM, 3 per customer, 100/day |
| 💳 Payment reminder | 30 min – 7 days after a payment is **requested**, while still unpaid (default 6 h) | Utility (no opt-in) | Approved **Utility** template required | 10 AM–8 PM, 3 per customer, 100/day |
| ✏️ Custom | "After the customer's last message" (30 min – 23 h, free text) **or** "After no messages for a while" (1 – 180 days, template) | Owner picks Marketing / Utility | Required for the "no messages" trigger | 9 AM–9 PM, 1 per customer, 50/day |

### Rules every send follows

- **Always skipped:** blocked customers; customers who sent **STOP** (until they send START); customers whose bot is paused (owner pause, staff reply, handoff, STOP); business inactive / WhatsApp not connected / no active subscription / feature switched off.
- **Window rule:** chat window open → free text (localized en/hi/mr). Window closed → approved template; **marketing** templates only to customers who are **opted in**.
- **One follow-up per customer per India-time day** across all of a business's automations.
- **Caps:** daily limit per automation; lifetime limit per customer per automation (1–5).
- **Send hours** in India time (overnight ranges allowed); due messages outside hours wait for the next window.
- **Order** when several automations are due for the same customer: Enquiry → Payment reminder → Review request → Win back (then oldest first).
- **Booking follow-ups** (review / payment) missed by more than **2 days** (e.g. server asleep) are skipped, never sent late.
- **Safety:** max 300 sends per sweep; a claim left by a crash is marked "interrupted" after 30 min and never re-sent.

### Message placeholders

| Placeholder | Fills with | Where |
|---|---|---|
| `{{customerName}}` | Customer's name; if empty: "there" / "जी" (hi, mr) | All |
| `{{businessName}}` | Business display name | All |
| `{{bookingCode}}` | e.g. `SG1234` | Review request, Payment reminder only |
| `{{amount}}` | e.g. `₹1,500`; if no amount: "your payment" / "आपका भुगतान" / "तुमचे पेमेंट" | Review request, Payment reminder only |

Template variables (`{{1}}`, `{{2}}`, …) are mapped to: Customer name · Business name · Fixed text · (booking follow-ups only) Booking code · Amount due — each with an optional fallback.

---

## 3. Completed features (detail)

### 3.1 Server (ApnaBot-server)

**Database** (`supabase/migrations/`)
- `20261003120000_followup_automations.sql`
  - `followup_automations` — the automation (preset, trigger, delay, text + hi/mr translations, template + variable mapping, send hours, caps, on/off).
  - `followup_sends` — one row per send attempt; unique `(automation_id, customer_id, trigger_key)` prevents double sends; drives caps and the log.
  - `customers.opted_out_at` — set by STOP, cleared by START.
  - Index `customers(business_id, last_message_at)`; `followups` allowed in `category_features` / `business_features`.
- `20261003160000_bookings_followup_times.sql`
  - `bookings.completed_at`, `bookings.payment_requested_at`, filled automatically by trigger `trg_stamp_followup_times` (covers every way a booking gets completed / a payment requested). Existing bookings left empty.

**Code**
- `services/windowAwareSend.service.js` — one shared "text if window open, else template + wallet debit/refund" sender (also used by coaching demo reminders, behaviour unchanged).
- `services/followupSweep.service.js` — the sweeper (candidates, claim, re-check, send, record, caps, daily rule, stale claims).
- `services/followup.service.js` + `controllers/followup.controller.js` + `routes/followup.routes.js` — owner API under `/api/followups` (gated by the `followups` feature switch; writes owner-only).
- `utils/followup.js` — presets, validation, trigger keys, rendering; `utils/ist.js` — India-time helpers.
- `server.js` — sweeper timer (60 s after boot, then every 15 min) behind `ENABLE_FOLLOWUP_SWEEPER`; skips a tick if the previous sweep is still running.
- `scripts/runFollowupSweep.js` — run one sweep by hand (dry run by default; `--confirm` sends and requires `--business`).
- `scripts/backfillOptedOut.js` — one-time opt-out backfill (already run: 0 customers needed it).

**STOP / START (live behaviour change)**
- STOP / UNSUBSCRIBE → bot paused 24 h (as before) **and** `opted_out_at` set; new default reply: "Done — you won't receive offers or reminders from us. Reply START anytime to turn them back on." (en/hi/mr).
- START → clears the opt-out (even after the 24 h pause has ended or during an owner's indefinite pause — the pause itself is untouched).
- Broadcasts, the Customers page "broadcast eligible" count/filter, and follow-ups all exclude opted-out customers.

**API**

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/followups` | any member | List + stats (sent today, sent 7 days, skipped 7 days) |
| GET | `/api/followups/presets` | any member | Preset limits, defaults, default texts, template filters |
| GET | `/api/followups/templates` | any member | Approved, body-only templates with variable count |
| POST | `/api/followups/preview-audience` | any member | How many are due right now |
| GET | `/api/followups/:id` | any member | One automation |
| GET | `/api/followups/:id/sends?page=` | any member | Send log (numbers masked) |
| POST | `/api/followups` | owner | Create (saved off) |
| PUT | `/api/followups/:id` | owner | Edit (re-validated; preset can't change) |
| PATCH | `/api/followups/:id/active` | owner | Switch on/off (switching on re-checks the template) |
| DELETE | `/api/followups/:id` | owner | Delete (and its send log) |

All return 404 while the feature is off for the business.

**Redis fix**
- All queues/workers share connections (`config/queueConnection.js`): ~13 → 6 Redis connections per server instance (Redis Cloud free plan allows 30).
- Reconnects back off (1 s … 30 s) and never give up, instead of killing the process after 10 quick retries.

### 3.2 Web dashboard (apnabot-web)
- **Sidebar:** "⏰ Follow-ups" (after Broadcasts), shown only when the server allows it — staff included.
- **List page** `/followups`: cards with name, use case, timing in plain English, on/off switch (owner), stats, Edit · View log · Delete. Empty state shows preset cards. Errors from the server (e.g. template no longer approved) shown on the card.
- **Wizard** `/followups/new`, `/followups/[id]/edit` — 5 steps:
  1. Use case (preset cards; Custom's trigger choice),
  2. Message (name, text with placeholder chips, live WhatsApp preview, Hindi/Marathi versions, template picker + variable mapping + filled-in template preview, cost note),
  3. When to send (delay + unit, send hours India time with "Any time", daily limit, per-customer limit, more options),
  4. Audience (live count + "always skipped" list),
  5. Review (summary + "Turn on now").
  Server errors jump to the step they belong to. Staff are redirected (owner-only).
- **Send log** `/followups/[id]`: date/time (India), customer + masked number, status, reason in plain words, Load more.
- **Customers** list + detail: "Opted out (sent STOP)" badge with explanation.

### 3.3 Flutter app (apnabot)
- "Opted out (sent STOP)" badge (en/hi/mr) on customer list and detail, tap for explanation.

### 3.4 Super Admin
- No code change needed: "Follow-up automations" appears automatically under Business Settings → category → Features and Businesses → business → Features.

---

## 4. Manual test cases

**Test business:** SG Travels (`a94aec66-23fb-43e1-afcc-f4e8d518134b`, test account, WhatsApp connected). Daring Bee (coaching) is the other connected test account.
**Do not test on Search cab AI** (live customers).
**Averix Solutions** (`e7fe86ca-…`) has WhatsApp disconnected — dry-run checks only.

Sweep script (run from the server repo):
```
node src/scripts/runFollowupSweep.js --business <businessId>            # dry run: who would get what
node src/scripts/runFollowupSweep.js --business <businessId> --confirm  # really sends
```

### A. Setup & access

| ID | Test | Steps | Expected |
|---|---|---|---|
| A1 | Feature off by default | Log in as SG Travels owner | No "Follow-ups" in the sidebar; `GET /api/followups` → 404 |
| A2 | Switch on for one business | Super Admin → Businesses → SG Travels → Features → Follow-up automations: **On** | Owner refreshes dashboard → "⏰ Follow-ups" appears after Broadcasts |
| A3 | Category switch appears for all categories | Super Admin → Business Settings → any category → Features | "Follow-up automations" listed (off) |
| A4 | Staff access | Log in as an SG Travels staff member | Menu visible; list read-only (no New / switch / Edit / Delete); opening `/followups/new` redirects to `/followups` |
| A5 | Override back to category | Super Admin → set the business back to "follow category" | Menu disappears for SG Travels again |

### B. Enquiry follow-up (free text)

| ID | Test | Steps | Expected |
|---|---|---|---|
| B1 | Create | Follow-ups → Enquiry follow-up → keep text → delay **30 minutes** → Turn on now → Create | Card shows "30 minutes after the customer's last message, between 9:00 AM and 9:00 PM (India time)", switch on |
| B2 | Due customer | From a test phone send "hello" to SG Travels; don't book; wait 30+ min (between 9 AM–9 PM IST); run dry run | Line `would send [..] via text → <name> 9198*****…` |
| B3 | Send | Run with `--confirm` | Phone receives "Hi <name>, just checking in…"; message appears in the dashboard chat; send log shows **Sent — free text** |
| B4 | No double send | Run `--confirm` again | `candidates: 0`; nothing sent |
| B5 | Booked customer skipped | Message again, then make a booking; wait 30 min; dry run | Not listed (open booking / booked in last 7 days) |
| B6 | Window margin | Customer whose last message is ~23 h 55 min old | Not sent (window about to close) |
| B7 | Hindi/Marathi | Set the test customer's language to Hindi; repeat B2–B3 | Hindi text; unnamed customer reads "नमस्ते जी" |
| B8 | Send hours | Set send hours to a window that excludes "now"; dry run | Nothing planned (`outsideHours: 1`) |
| B9 | Validation | Delay 20 minutes; or 24 hours; or start = end time | Wizard blocks Next with a clear message |

### C. Win back (Marketing template)

| ID | Test | Steps | Expected |
|---|---|---|---|
| C1 | No template | Create Win back with no approved Marketing template | Explanation + "Create a template →" link to Broadcasts; can't continue |
| C2 | Template + mapping | Create + get approved a Marketing template "Hi {{1}}, {{2}} misses you!"; pick it; map {{1}} = Customer name, {{2}} = Business name | Template preview fills "Hi Rahul, <business> misses you!" |
| C3 | Opt-in required | Due customer (silent 7+ days, past booking) **not** opted in | Not a candidate |
| C4 | Send | Opt the customer in (Customers page), make them due (delay 7 days on an old customer), dry run then `--confirm` | Template received; log **Sent — template** |
| C5 | Only past customers | Customer never booked, opted in, silent 30 days | Skipped while "Only customers who booked before" is on |
| C6 | Template rejected later | Template becomes rejected → switch the automation on | Refused with the server's reason shown on the card |

### D. Review request (Utility template)

| ID | Test | Steps | Expected |
|---|---|---|---|
| D1 | Create | Approved **Utility** template "Hi {{1}}, how was booking {{2}}?"; Review request; map {{1}} = Customer name, {{2}} = Booking code; delay 30 minutes; on | Saved; card timing "30 minutes after a booking is completed…" |
| D2 | Completed booking | Mark a test booking **Completed**; wait 30+ min within 10 AM–8 PM; dry run | Booking listed (shows booking code) |
| D3 | Send | `--confirm` | Template (or free text if chat window open) received with the booking code; no opt-in needed |
| D4 | Once per booking | Reopen (mark Confirmed) and Complete again; wait; sweep | Not sent again for that booking |
| D5 | Reopened before send | Mark completed, and set back to Confirmed before it becomes due | Not sent (no longer completed) |
| D6 | Old bookings | Bookings completed before the migration | Never trigger (no completed time recorded) |

### E. Payment reminder (Utility template)

| ID | Test | Steps | Expected |
|---|---|---|---|
| E1 | Create | Utility template with {{1}} = Customer name, {{2}} = Amount due; Payment reminder; delay 30 minutes; on | Saved |
| E2 | Request payment | From the dashboard chat send the **payment QR with an amount** (e.g. 1500) to the test customer, linked to a booking; don't reply from the phone | — |
| E3 | Send | Wait 30+ min within 10 AM–8 PM; dry run; `--confirm` | Reminder with "₹1,500"; log Sent |
| E4 | No amount | Send QR without amount; repeat | Text reads "your payment for booking SG…" |
| E5 | Customer replied | Customer sends a message (e.g. screenshot) after the QR | Not reminded |
| E6 | Paid | Mark the booking's payment **Paid** before it's due | Not reminded |
| E7 | Cancelled | Cancel the booking before it's due | Not reminded |
| E8 | New request | After paid → mark pending again (new request) | A new reminder can go out for the new request |

### F. Custom

| ID | Test | Steps | Expected |
|---|---|---|---|
| F1 | Last-message trigger | Custom → "After the customer's last message" → own text → 1 hour | Behaves like B (free text, ≤ 23 h) |
| F2 | No-messages trigger | Custom → "After no messages for a while" → Utility → Utility template → 2 days | Template sends to inactive customers; no opt-in needed for Utility |
| F3 | Booking placeholders blocked | Put `{{amount}}` in an enquiry/custom text | Server refuses with "only available for booking follow-ups" |

### G. Shared rules

| ID | Test | Steps | Expected |
|---|---|---|---|
| G1 | One per day | Two automations due for the same customer the same day | Only one sends; the other logs "They already got a follow-up today" (or isn't claimed) |
| G2 | Daily limit | Daily limit 1, two due customers | One sent today, the other next day |
| G3 | Per-customer limit | Limit 1; same customer due again later | Not sent again by that automation |
| G4 | Blocked | Block a due customer | Not sent |
| G5 | Bot paused | Pause the bot for a due customer (or a staff member replies) | Not sent while paused |
| G6 | Switch off | Switch the automation off | Nothing sent |
| G7 | Delete | Delete → confirm | Card and its send history gone |

### H. STOP / START (affects all businesses)

| ID | Test | Steps | Expected |
|---|---|---|---|
| H1 | STOP | Test phone sends **STOP** | Reply "Done — you won't receive offers or reminders…"; customer shows **Opted out (sent STOP)** badge (web + app) |
| H2 | Broadcast exclusion | Broadcast preview / Customers "broadcast eligible" | Opted-out customer not counted |
| H3 | Follow-up exclusion | Make the customer due for any follow-up | Never sent |
| H4 | START within 24 h | Send **START** | "Messages have resumed" reply; badge gone |
| H5 | START after 24 h | STOP, wait > 24 h, send START | Badge gone (no extra reply; normal greeting) |
| H6 | Custom stop text | Business with its own stop message (Settings) | Its own text wins |

### I. Web UI

| ID | Test | Expected |
|---|---|---|
| I1 | Mobile (≈380 px) | Wizard step pills scroll sideways; no page side-scroll; cards stack |
| I2 | Placeholder chips | Insert at the cursor position |
| I3 | Translations box | Shown only for languages enabled in Settings |
| I4 | Audience count | Loads on step 4; "5,000+" when capped; error message on failure |
| I5 | Save but activation refused | Turn on now + template not approved → lands on list with the reason, saved switched off |
| I6 | Edit | Use case locked; other fields editable; save |
| I7 | Send log | Empty: "Nothing sent yet. Follow-ups are checked every 15 minutes."; entries newest first; Load more |

### J. Deploy / infrastructure

| ID | Test | Expected |
|---|---|---|
| J1 | Server deploy | Render log: "Redis connected", no repeating "max number of clients" errors (one brief burst possible during an overlapping deploy) |
| J2 | Sweeper enabled | With `ENABLE_FOLLOWUP_SWEEPER=true`: "Follow-up sweeper scheduled…" at boot, "Follow-up sweep done" every 15 min |
| J3 | Sending still works | Send a manual WhatsApp reply from the dashboard after deploy | Delivered |

---

## 5. Automated tests

Run `npm test` in ApnaBot-server (**326 tests, all passing**). Follow-up related files:

| File | Covers |
|---|---|
| `src/utils/followup.test.js` | Presets, validation edges, delay ranges, template rules, variable mapping, booking placeholders, trigger keys, due ranges, rendering & fallbacks (en/hi/mr, ₹ amounts) |
| `src/services/followupSweep.service.test.js` | Due / not due for every preset, window margin, booking exclusions, opt-out / blocked / paused / opt-in, send hours, daily cap, per-customer cap, claim conflicts, fresh re-checks, stale claims, one failure not stopping others, one-per-day rule, trigger priority, review & payment flows |
| `src/services/windowAwareSend.service.test.js` | Text vs template, wallet debit / refund, low balance, blocked, not connected, message id + cost |
| `src/services/demoReminder.service.test.js` | Coaching demo reminders unchanged after the shared-sender refactor |
| `src/utils/ist.test.js` | India-time day start, send hours (incl. overnight), next window |
| `src/services/broadcastAudience.resolve.test.js` | Broadcasts exclude opted-out customers |
| `src/controllers/customer.controller.test.js` | Broadcast-eligible rule includes opt-out |
| `src/services/categoryFeature.service.test.js` | `followups` switch for all categories ('*'), per-business pilot |
| `src/scripts/backfillOptedOut.test.js` | Opt-out backfill logic |
| `src/config/redisRetry.test.js` | Reconnect never gives up |

Web: `npx tsc --noEmit`, `npm run build` clean; no new lint problems. Flutter: `flutter test` (217) and `flutter analyze` clean.

---

## 6. Remaining work

### 6.1 To go live (no code)
1. Deploy server + web (done if already pushed); ship the Flutter badge with the next app release.
2. Super Admin: switch **Follow-up automations on for SG Travels only** (not the travels category — that would include Search cab AI).
3. Render: set `ENABLE_FOLLOWUP_SWEEPER=true` (production server only — never on a local machine pointed at the live database).
4. Create and submit WhatsApp templates in Broadcasts: one **Marketing** (win back) and one **Utility** (review / payment). Approval can take time — start early.
5. Run test cases §4 on SG Travels.
6. Roll out to other businesses / categories one at a time.

### 6.2 Housekeeping
- **PRD.md (server + web)** — not yet updated for follow-ups, STOP opt-out, Redis Cloud (it still says Upstash).
- **Redis Cloud console** — change eviction policy from `volatile-lru` to `noeviction` (BullMQ warning; otherwise queued jobs can be silently dropped when memory fills).

### 6.3 Known bugs found during this work (outside follow-ups, not fixed)
1. **Broadcast refunds while billing is off** — a failed broadcast message refunds the wallet even though nothing was charged (harmless today; matters once wallet billing is switched on).
2. **Staff permissions not enforced** — permission flags are stored but no API checks them; staff can send (paid) broadcasts.
3. **Delivery status of our sent messages isn't tracked** — WhatsApp's "delivered / failed" updates aren't matched to messages we send, so a template that fails after WhatsApp accepted it isn't noticed or refunded.

### 6.4 Known limitations of follow-ups v1
- Templates with an **image header** can't be used (body-only templates only).
- **Custom** automations can't use the booking triggers (completed / payment) — presets only.
- Timing depends on the server being awake; on Render's free plan a sleeping server catches up on the next wake (booking follow-ups older than 2 days are skipped, not sent late).
- No delivery/read status in the send log (see bug 3).
- Translations only for Hindi and Marathi.
- India time only (no per-business timezone).

### 6.5 Possible next features
- **Booking reminder** before a scheduled booking (dropped from v1 — travel bookings don't store a parseable date/time yet).
- Follow-ups screen in the Flutter app.
- Custom automations on booking triggers; booking filters (e.g. only certain forms/services).
- Delivery/read tracking and per-automation conversion stats (replied / booked after a follow-up).
- Image-header templates.

---

## 7. Reference — send log reasons

| Code | Shown to owner |
|---|---|
| `blocked` | You've blocked this customer. |
| `opted_out` | The customer sent STOP. |
| `bot_paused` | The bot is paused for this customer. |
| `customer_replied` | The customer messaged again before it was sent. |
| `daily_limit_customer` | They already got a follow-up today. |
| `window_closing` | The free 24-hour chat window was about to close. |
| `booked` | The customer booked. |
| `no_template` | The chat window had closed and there was no approved template to send. |
| `not_opted_in` | The customer hasn't opted in to marketing messages. |
| `booking_gone` | The booking no longer exists. |
| `booking_reopened` | The booking is no longer marked completed. |
| `booking_cancelled` | The booking was cancelled. |
| `paid` | The payment was marked paid. |
| `payment_changed` | The payment request changed before it was sent. |
| `not_connected` | WhatsApp wasn't connected. |
| `low_balance` | Wallet balance was too low. |
| `rejected` | WhatsApp didn't accept the message. |
| `interrupted` | Sending was interrupted; it won't be retried. |
| `customer_gone` | The customer no longer exists. |
| `error` | Something went wrong while sending. |

### Configuration

| Setting | Where | Default |
|---|---|---|
| `ENABLE_FOLLOWUP_SWEEPER` | Render env (server) | off |
| Follow-up automations switch | Super Admin → Features (category or business) | off |
| Sweep interval / first run | `server.js` | 15 min / 60 s after boot |
| Max sends per sweep | `followupSweep.service.js` | 300 |
| Late-send limit (booking follow-ups) | `utils/followup.js` | 2 days |
