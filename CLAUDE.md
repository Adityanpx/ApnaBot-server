# Working rules for Claude Code on ApnaBot-server

Read PRD.md before starting any non-trivial task — it has the current
architecture, what's live, what's deferred, and known gaps. This file is
about HOW to work; PRD.md is about WHAT currently exists.

## Non-negotiable process rules

1. **Report before you build.** For anything touching schema, the booking
   engine, webhook.controller.js, or any live-traffic path: read the
   relevant code fully and report findings BEFORE writing code. State
   your recommendation with reasoning — don't silently pick one option
   among several and hope it's right.

2. **Never guess a schema, endpoint, or shape you haven't verified.** If
   you don't have the actual column list, request body shape, or table
   contents in front of you, say so and ask, rather than inventing a
   plausible one. A wrong guess here has cost real debugging time
   multiple times in this project.

3. **Flag every deviation from the plan explicitly**, even small ones.
   Don't silently "improve" something outside the requested scope — call
   it out and let the human decide.

4. **Verify against real data, not synthetic fixtures**, whenever a real
   business exists to test against (currently: SG Travels, category
   'travels', and Averix Solutions, category 'software_it' — see PRD.md
   for IDs). Test accounts are freely resettable. **Exception: Search cab
   AI (category 'travels') is a LIVE production business with real
   WhatsApp customers** — never reset it or run a `--confirm` script /
   AI-flow apply against it, and say explicitly whether any change to a
   live-traffic path affects it. Look its id up fresh from `businesses`.

5. **Dry-run before --confirm on any script that writes to the database.**
   Every migration/data script in this repo follows: default = print what
   it would do, `--confirm` flag = actually do it. Keep this pattern for
   new scripts.

6. **After any change to shared logic (booking engine, matching engine,
   confirmation-text formatting), re-run the relevant verification script**
   (`src/scripts/verifyBookingGraph.js` for the graph booking engine) before
   declaring the change safe. A refactor that "looks" mechanical can still
   break the thing it was extracted from — treat every touch as a
   regression risk until proven otherwise.

7. **State explicitly when something is a one-time cutover/deploy
   moment** (i.e., pushing this code changes live customer-facing
   behavior immediately, no feature flag). Don't let this pass as "just
   another commit."

8. **Never commit or push without being asked.** Show diffs, wait for
   explicit go-ahead.

9. **When you find a bug outside the current task's scope** (e.g. a
   stale doc comment, a dead code path, drift between a migration file
   and the live schema), report it — don't silently fix it in the same
   diff unless asked, and don't ignore it either.

10. **Keep the fix pattern consistent with what's already in the file.**
    This codebase has an established style (snake_case DB columns,
    camelCase in JS via `toCamelCase`/`toSnakeCase`, try/catch-and-log at
    call sites, RPC for atomic counters) — match it rather than
    introducing a new pattern for a small change.

## Housekeeping

- Update PRD.md's "Current state" section whenever a major piece lands
  (new table, new engine, a business fully migrated, etc.) — don't let
  it silently go stale. Flag to the human when PRD.md needs updating
  rather than assuming someone else will.
- If you're about to touch a file and PRD.md's description of it
  disagrees with what's actually in the file, say so before proceeding —
  that's a signal PRD.md is out of date, not that you should silently
  trust the stale doc.