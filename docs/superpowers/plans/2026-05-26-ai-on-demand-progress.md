# AI on-demand — live progress

**Branch:** `feat/ai-on-demand`
**Started:** 2026-05-26
**Mode:** inline + team fan-out where file-disjoint

## Status: Phase A in flight — 3 agents working in parallel

## Phase A — setup (parallel team, 3 agents)

- [x] **Task 1** — Gate autopilot scan cron behind `app_settings.autopilot_scan_cron_enabled` (default off) — *committed `b1cf86b`*
- [x] **Task 2** — Refactor 5 candidate finders to accept optional `customerId` — *committed; 42/42 candidate tests pass*
- [x] **Task 3** — Migration 0039: `customer_ai_cards` table + `email_log.draft_ai_notes` column — *committed `4a82da2`*

**Phase A complete.** Moving to Phase B (sequential foreground).

## Phase B — backend modules + routes (sequential)

- [x] **Task 4** — `customer-card.ts` module (scan + LLM synth) — *7/7 tests pass; committed*
- [x] **Task 5** — GET + POST regenerate routes — *committed*
- [x] **Task 7** — `draft-reply.ts` module (clean run / with operator notes) — *7/7 tests pass; committed*
- [x] **Task 8** — POST `/api/email-log/:id/draft-reply` route — *committed*

**Phase B complete.** Moving to Phase C (frontend fan-out via team).

## Phase C — frontend (inline sequential — UI tasks have interdeps)

- [x] **Task 9** — Compose modal "AI" panel (notes textarea + Generate button) — *committed `80fdd38`*
- [x] **Task 10** — "Draft reply" button on inbound rows in customer email list — *committed*
- [x] **Task 6** — `<CustomerAiCard />` component + customer-detail integration — *committed `4eb37ca`*
- [x] **Task 11** — "Draft reply" button on dashboard emails widget — *committed*
- [x] **Task 12** — Cron toggle UI on `/ai-training` — *committed*

**Phase C complete.** Moving to Phase D (verify + ship).

## Phase D — verify + ship

- [x] **Task 13** — Full test/typecheck/build, push branch, open PR — **PR #2 OPEN**

## Status: DONE — awaiting user merge decision

**PR:** https://github.com/joshezekiel554-cloud/finance-hub/pull/2
**Branch:** `feat/ai-on-demand` (11 commits)
**Tests:** 589/589 passing · typecheck clean · build clean

---

## Recent commits

_(populated as work lands)_

## Decisions taken in flight

_(populated as decisions arise)_
