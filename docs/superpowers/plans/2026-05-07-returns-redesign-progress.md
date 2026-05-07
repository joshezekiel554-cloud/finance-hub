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
| W0 (sequential) | 0.1 → 0.2 → 0.3 → 0.4 → 0.5 | ✅ done |
| W1 (parallel ×3) | 1.1, 1.2, 1.3 | ✅ done |
| W2 (parallel ×2) | 2.1, 4.1 | ✅ done |
| W3 (parallel ×2) | 2.2, 4.2 | ✅ done |
| W4 (parallel ×2) | 3.1 full + 4.3 | ✅ done |
| W5 (parallel ×2) | 4.4 + 3.2 | ✅ done |
| Task 2.3 (added) | HTML body capture | in progress |
| Phase 5 | 5.1 cutover (operator-gated) | blocked on operator validation |

## Task status

| Task ID | Subject | Model | Status | Commit |
|---|---|---|---|---|
| 265 (0.1) | Schema migration | sonnet | ✅ completed | `16771d8` |
| 266 (0.2) | RMA# regex module | sonnet | ✅ completed | `579c5f0` then fix `8eb829d` |
| 267 (0.3) | Email linker module | sonnet | ✅ completed | `5353ccc` |
| 268 (0.4) | Wire into Gmail poll | sonnet | ✅ completed | `4e9d773` |
| 269 (0.5) | Server endpoints | sonnet | ✅ completed | `1f20a4b` + fix `b9844dd` |
| 270 (1.1) | SKU order bug | sonnet | ✅ completed | `dbec032` + `74bcc95` (real fix), merged `764ae2b` |
| 271 (1.2) | Invoice recipients | sonnet | ✅ completed | `bc1578b`, merged `60bff51` |
| 272 (1.3) | CustomerMemo field | sonnet | ✅ completed (no code) | empty branch deleted; QBO action required |
| 273 (2.1) | ReturnReceiptCard | sonnet | ✅ completed | `9cc5aa7` + `4f63278`, merged `37dea2a` |
| 274 (2.2) | Today tab card list | sonnet | ✅ completed | `6eb8412` + `49cac02`, merged `c560cc4` |
| 282 (2.3) | **(added)** HTML email body capture | sonnet | pending | — |
| 275 (3.1) | ProcessReturnPanel | sonnet | ✅ completed | `9e0eac7`, merged `3c6b2b5` |
| 276 (3.2) | Wire to RMA detail | sonnet | ✅ completed | `b6a7c00`, merged `e22627f` |
| 277 (4.1) | Register CM route | haiku | ✅ completed | `0ae2f1f`, merged `5812b9f` |
| 278 (4.2) | CM line items table | **opus** | ✅ completed | `4314699` + `d7b2d22` (parsed-receipts merge), merged `d10d9e7` |
| 279 (4.3) | CM memo + recipients | **opus** | ✅ completed | `2f7ea37`, merged `3ae8cbc` |
| 280 (4.4) | process-return endpoint | **opus** | ✅ completed | `f02fbd8`, merged `2152205`; page fix `485dfc3` |
| 281 (5.1) | Cutover (operator-gated) | sonnet | blocked | — |

## Latest commits on branch

(See `git log` for full history; below are the ones from this plan.)

- `16771d8` — `feat(returns-redesign): schema for email_rma_links + damages_note + receipt dismiss`
- `579c5f0` — `feat(returns-redesign): add RMA number format module for email auto-linking`
- `7800a04` — `docs(returns-redesign): add live progress tracker for autocompact recovery`
- `8eb829d` — `fix(returns-redesign): mask DC matches before sequential regex to avoid duplicate refs`
- `64773b2` — `docs(returns-redesign): progress update — 0.2 done, 0.3 next`
- `5353ccc` — `feat(returns-redesign): email linker module with poll-time + backfill entry points`
- `3f0d0c0` — `docs(returns-redesign): progress update — 0.3 done, opus reviewers policy set`
- `4e9d773` — `feat(returns-redesign): call email linker on every Gmail poll classify`
- `1f20a4b` — `feat(returns-redesign): refresh-email-links + dismiss-with-reason endpoints + linked RMAs in Today`
- `b9844dd` — `fix(returns-redesign): tighten dismiss-with-reason text cap to fit varchar(64)`
- `db3375c` — progress update before Wave 1
- (Wave 1 worktree commits) `dbec032` + `bc1578b` + `74bcc95`
- `764ae2b` — Merge task/sku-order
- `60bff51` — Merge task/invoice-recipients

## Known issues

### Operator action required (NOT a code bug)

**Task 1.3 — `CustomerMemo` not showing on QBO statements**
- Code is correct (`CustomerMemo: { value: ... }` already set in `credit-memo-builder.ts:249`)
- Bug is in QBO statement template configuration
- **Operator action:** QBO web UI → Settings (gear) → Custom Form Styles → Edit your statement template → Content tab → enable "Customer message" / "Message on statement"
- Until enabled, CustomerMemo is sent correctly via API but invisible on rendered statements

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
