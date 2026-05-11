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
| W2 (1 task) | webhook route + all 4 event handlers + outbound endpoints | in_progress |
| W3 (parallel ×2) | 3.1 backfill job, 3.2 roster sync job + nightly cron | not started |
| W4 (parallel ×2) | 4.1 Calls and SMS tab UI, 4.2 Settings section | not started |
| W5 (1 task) | Activity inline + Today unmatched inbox | not started |

## Task status

| Task ID | Subject | Model | Status | Commit |
|---|---|---|---|---|
| 286 (W0.1) | Schema migration | sonnet | ✅ completed | `e3b5548` |
| 287 (W1.1) | API client + HMAC verifier | sonnet | ✅ completed | `5840243`, merged in W1 batch |
| 288 (W1.2) | Phone matcher | sonnet | ✅ completed | `828f7ca` + `45582d8` (ext-digit fix), merged in W1 batch |
| 289 (W2) | Webhook + handlers bundle | **opus** | in_progress | — |
| 290 (W3.1) | Backfill job | sonnet | pending | — |
| 291 (W3.2) | Roster sync job | sonnet | pending | — |
| 292 (W4.1) | Calls and SMS tab | **opus** | pending | — |
| 293 (W4.2) | Settings section | sonnet | pending | — |
| 294 (W5) | Activity inline + unmatched inbox | sonnet | pending | — |

## Commits on branch

- `e3b5548` — `feat(vocatech): schema for events + phone_communications + customer last-pushed timestamp`
- `14b32bf` — `docs(vocatech): live progress tracker + PROGRESS.md update (W0.1 done)`
- (W1 worktree commits) `5840243` + `828f7ca` + `45582d8`
- merge commits via W1 batch (push at `c3d53b0`)

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
