# Vocatech Integration — Live Progress Tracker

> **Recovery note:** if the conversation autocompacts and a future session resumes, read this file FIRST. It captures the live state of plan execution: current task, latest commit, known issues, and what's next.
>
> Updated after every task. Committed + pushed to origin so it's durable across sessions and machines.

**Plan:** `docs/superpowers/plans/2026-05-11-vocatech-integration.md`
**Spec:** `docs/superpowers/specs/2026-05-11-vocatech-integration.md`
**Branch:** `feat/vocatech-integration` (off main, pushed to origin)
**Execution mode:** Subagent-driven, wave-by-wave with parallel worktrees where files are disjoint.
**Model split:** sonnet for most implementers, opus for W2 (large webhook bundle) and W4.1 (Calls and SMS tab UI). **opus for ALL code-quality reviewers.**
**Push policy:** after every wave merge, push the feature branch to origin. Documented in memory `feedback_git_push_cadence.md`.

## Wave plan

| Wave | Tasks | Status |
|---|---|---|
| W0 (1 task) | 0.1 schema migration | ✅ done |
| W1 (parallel ×2) | 1.1 API client + HMAC verifier, 1.2 phone matcher | ✅ done |
| W2 (1 task) | webhook route + all 4 event handlers + outbound endpoints | ✅ done |
| W3 (1 bundled task) | backfill job + roster sync job + nightly cron (bundled to avoid merge conflicts on queues.ts/worker.ts/schedule.ts/vocatech.ts) | ✅ done |
| W4 (parallel ×2) | 4.1 Calls and SMS tab UI, 4.2 Settings section | ✅ done |
| W5 (1 task) | Activity inline + Today unmatched inbox | not started |

## Task status

| Task ID | Subject | Model | Status | Commit |
|---|---|---|---|---|
| 286 (W0.1) | Schema migration | sonnet | ✅ completed | `e3b5548` |
| 287 (W1.1) | API client + HMAC verifier | sonnet | ✅ completed | `5840243`, merged in W1 batch |
| 288 (W1.2) | Phone matcher | sonnet | ✅ completed | `828f7ca` + `45582d8` (ext-digit fix), merged in W1 batch |
| 289 (W2) | Webhook + handlers bundle | **opus** | ✅ completed | `92776ea` + `edeb46a` (review fixes), merged `2c3f338` |
| 290 (W3.1) | Backfill job | sonnet | ✅ completed | bundled in W3, merged `e7730a4` |
| 291 (W3.2) | Roster sync job | sonnet | ✅ completed | bundled in W3, merged `e7730a4` |
| 292 (W4.1) | Calls and SMS tab | **opus** | ✅ completed | `a07dcb7` + fix `e21c230`, merged `07edc40` |
| 293 (W4.2) | Settings section | sonnet | ✅ completed | `7deb90e` + fix `7e7aa1d`, merged `9becdd7` |
| 294 (W5) | Activity inline + unmatched inbox | sonnet | pending | — |

## Commits on branch

- `e3b5548` — `feat(vocatech): schema for events + phone_communications + customer last-pushed timestamp`
- `14b32bf` — `docs(vocatech): live progress tracker + PROGRESS.md update (W0.1 done)`
- (W1 worktree commits) `5840243` + `828f7ca` + `45582d8`
- merge commits via W1 batch (push at `c3d53b0`)
- `cf185a3` — progress update after W1
- (W2 worktree commits) `92776ea` + `edeb46a` (customer-exists + 429 handling fixes)
- merged W2 (push at `2c3f338`)
- `ffd8f22` — progress + backlog capture
- (W3 worktree commits on voc/jobs) `c28580e` + `ce3ef79` + `7cad850` (critical fixes) + `0929bc7` (important fixes)
- merged W3 at `e7730a4`, pushed to origin
- `331bd80` — fix client to match real API shape (envelope, page-numbered pagination, incoming/outgoing direction, INSERT IGNORE)
- `99015dc` — fix contacts client + roster sync against OpenAPI spec (fields-keyed payload, error parsing, precondition check)
- `5bcce31` — fix sendMessage + message.received webhook against OpenAPI spec
- W4.1 (voc/calls-sms-tab): `a07dcb7` + fix `e21c230` (toNumber reset + aria-label), merged `07edc40`
- W4.2 (voc/settings): `7deb90e` + fix `7e7aa1d` (apostrophe), merged `9becdd7`

## Migration to run before deploy

W3 added `migrations/0031_vocatech_source_event_unique.sql` — adds a `UNIQUE` constraint to `phone_communications.source_event_id`. Run `npm run db:migrate` on each environment before the worker process restarts so the webhook + backfill code (now using `INSERT IGNORE`) is consistent with the schema.

Also bump the journal `when` for 0031 if you regenerate from scratch — drizzle-kit sorts by `when` not `idx`, and the hand-written stub originally had a 2025 placeholder that caused `db:migrate` to skip it. Fixed value: `1778600000000`.

## Operator configuration before roster sync works

Roster sync now refuses to run unless the Vocatech tenant has custom contact fields configured (it would silently push empty contacts otherwise). Recommended setup in Vocatech's admin UI:

| Field | type | is_phone | is_match | Maps to |
|---|---|---|---|---|
| Company | text | no | yes | `customer.displayName` |
| Phone | text | yes | yes | all customer phones, joined by `;` |
| External ID | text | no | yes | `customer.id` (stable dedup key) |

Also need `VOCATECH_FROM_NUMBER` in `.env` (a phone number registered to the tenant) before outbound SMS will work.

## Smoke test status (2026-05-11)

- ✅ migration applied; UNIQUE constraint present
- ✅ backfill end-to-end: 18 calls + 1 SMS over 7 days, ~600ms; idempotency verified
- ✅ roster precondition fires loudly when no fields configured (operator-actionable error)
- ⏸️ roster end-to-end push: blocked on operator configuring Vocatech fields (Joshua waiting on web admin access)
- ⏸️ outbound SMS: blocked on `VOCATECH_FROM_NUMBER` env config
- ⏸️ inbound webhook: not yet tested with a live tunnel
- ✅ W4 UI shipped: Calls & SMS tab on customer detail + Settings → Vocatech section (health badge, backfill, roster push, webhook test). Real test against Joshua's tenant blocked on (a) Vocatech custom fields config (b) `VOCATECH_FROM_NUMBER` env

## Known issues

_(none currently)_

## Decisions locked in (don't re-litigate)

From the Q&A brainstorming session (2026-05-11):

- **No outbound dial endpoint** — Vocatech doesn't expose one in their public API. Operator opted out of click-to-call.
- **UI surface:** Activity tab + new dedicated "Calls and SMS" tab on customer detail. No top-level Calls page, no Today widget for calls.
- **Attribution:** show Vocatech's `extension_name` raw. No mapping to finance-hub users.
- **Unmatched inbox:** lives on the Today tab. Operator can Match-to-customer or Ignore.
- **Scope:** calls + AI summaries + transcripts + recordings + SMS + B2B roster push all in v1.
- **Backfill:** 30 days on first run + Settings button for extended (90d / 1y / all).
- **Phone matching:** US-only, last-10-digits normalization, match ALL phones per customer, show matched label.
- **Roster push primary button:** "Push all B2B customers" (B2C is secondary).
- **SMS thread:** chronological combined with calls in the "Calls and SMS" tab. No sub-tabs.
- **SMS compose:** freeform textarea, no templates in v1.
- **Transcript:** "View full transcript" link → modal. AI summary as headline.
- **Local dev:** fake-event replay admin endpoint + ngrok/Cloudflare tunnel for real webhook testing.

## How to resume after autocompact

If you (future Claude) are reading this after a compact:

1. **Read the spec and plan** (paths above). They're authoritative.
2. **Read this file fully.** Shows current task, current bug, latest commit.
3. **Run `git log --oneline -20`** to see actual git state.
4. **Run `TaskList`** to see canonical task list.
5. **Continue from the in-progress task.** Don't re-do completed work.
6. **Update this file** after every task you complete or after every meaningful state change.
7. **Push to origin** after every wave merge (`git push origin feat/vocatech-integration`).
