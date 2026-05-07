# Returns Redesign — Live Progress Tracker

> **Recovery note:** if the conversation autocompacts and a future session resumes, read this file FIRST. It captures the live state of plan execution: current task, latest commit, known issues, and what's next.
>
> Updated after every task. Committed to git so it's durable across sessions.

**Plan:** `docs/superpowers/plans/2026-05-07-returns-redesign.md`
**Spec:** `docs/superpowers/specs/2026-05-07-returns-redesign.md`
**Branch:** `feat/returns-phase-5-7`
**Execution mode:** Subagent-driven, sequential for Wave 0 (Phase 0), then parallel worktrees for Wave 1+
**Model split:** sonnet for most implementers, opus for 4.2 / 4.3 / 4.4 implementers, **opus for ALL code-quality reviewers** (per user policy update on 2026-05-07). Spec-compliance reviewers stay sonnet.

## Wave plan

| Wave | Tasks | Status |
|---|---|---|
| W0 (sequential) | 0.1 → 0.2 → 0.3 → 0.4 → 0.5 | in progress |
| W1 (parallel ×3) | 1.1, 1.2, 1.3 | not started |
| W2 (parallel ×2) | 2.1, 4.1 | not started |
| W3 (parallel ×2) | 2.2, 4.2 | not started |
| W4 (parallel ×2) | 3.1 (component only), 4.3 | not started |
| W5 (sequential) | 3.1 endpoint + 4.4 | not started |
| W6 (parallel) | 3.2, ... | not started |
| Phase 5 | 5.1 cutover (operator-gated) | blocked on operator validation |

## Task status

| Task ID | Subject | Model | Status | Commit |
|---|---|---|---|---|
| 265 (0.1) | Schema migration | sonnet | ✅ completed | `16771d8` |
| 266 (0.2) | RMA# regex module | sonnet | ✅ completed | `579c5f0` then fix `8eb829d` |
| 267 (0.3) | Email linker module | sonnet | ✅ completed | `5353ccc` |
| 268 (0.4) | Wire into Gmail poll | sonnet | in_progress | — |
| 269 (0.5) | Server endpoints | sonnet | pending | — |
| 270 (1.1) | SKU order bug | sonnet | pending | — |
| 271 (1.2) | Invoice recipients | sonnet | pending | — |
| 272 (1.3) | CustomerMemo field | sonnet | pending | — |
| 273 (2.1) | ReturnReceiptCard | sonnet | pending | — |
| 274 (2.2) | Today tab card list | sonnet | pending | — |
| 275 (3.1) | ProcessReturnPanel | sonnet | pending | — |
| 276 (3.2) | Wire to RMA detail | sonnet | pending | — |
| 277 (4.1) | Register CM route | haiku | pending | — |
| 278 (4.2) | CM line items table | **opus** | pending | — |
| 279 (4.3) | CM memo + recipients | **opus** | pending | — |
| 280 (4.4) | process-return endpoint | **opus** | pending | — |
| 281 (5.1) | Cutover (operator-gated) | sonnet | blocked | — |

## Latest commits on branch

(See `git log` for full history; below are the ones from this plan.)

- `16771d8` — `feat(returns-redesign): schema for email_rma_links + damages_note + receipt dismiss`
- `579c5f0` — `feat(returns-redesign): add RMA number format module for email auto-linking`
- `7800a04` — `docs(returns-redesign): add live progress tracker for autocompact recovery`
- `8eb829d` — `fix(returns-redesign): mask DC matches before sequential regex to avoid duplicate refs`
- `64773b2` — `docs(returns-redesign): progress update — 0.2 done, 0.3 next`
- `5353ccc` — `feat(returns-redesign): email linker module with poll-time + backfill entry points`

## Known issues

_(none currently)_

### Resolved

**Task 0.2 — sequential regex captured embedded digits in DC matches** — fixed in `8eb829d`. DC matches are masked with whitespace before SEASONAL_RE runs. Re-reviewed and approved.

## How to resume after autocompact

If you (future Claude) are reading this after a compact:

1. **Read the spec and plan** (paths above). They're authoritative.
2. **Read this file fully.** It shows current task, current bug, latest commit.
3. **Run `git log --oneline -20`** to see the actual git state.
4. **Run `TaskList`** to see the canonical task list with statuses.
5. **Continue from the in-progress task.** Don't re-do completed work.
6. **Update this file** after every task you complete or after every meaningful state change.

If the in-progress task has a known issue (see Known Issues above), fix it first via a follow-up subagent dispatch, then proceed.

## Decisions locked in (don't re-litigate)

From the brainstorming session:
- Email-RMA linking is **passive** (Gmail poll-time scanner) + **manual button** ("Check for emails")
- Today tab is a **triage inbox** with collapsible HTML cards + 3 dismiss actions
- All processing happens on the **RMA detail page**
- Credit memo create page is a **dedicated route** (`/returns/$rmaId/credit-memo`)
- Damages = **free-text only** (option C from Q1), no per-line tagging — appears at bottom of CustomerMemo
- Tax default = **off per line**
- Auto-dismiss `done` fires when **credit memo is created**
- Multiple receipts → **combined discrepancy table** (one view, summed quantities)
- Auto-attach matches **any sender, RMA# in subject or body**
- Brief **co-existence period** (~1 week) before deleting old dialogs (Phase 5)
