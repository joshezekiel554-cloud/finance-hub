# Origin Split 2.0 — Wave 2 (AI Separation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use `- [ ]`. **Commit after every task.** Anchors from 2026-06-10 recon + Wave 1; read the code first.

**Goal:** The AI works both books, separately: TJ autopilot proposals (chase tiers + dispute nudges) in their own queue section, per-book AI customer-card summaries, and a TJ section in the daily chase digest. Plus the small cleanups Wave 1 parked.

**Spec:** `docs/superpowers/specs/2026-06-10-origin-split-2-design.md` §3 + §2 (AI card) + cross-cutting.
**Branch:** `feat/origin-split-2` (continues; Wave 1 merged to main — rebase the branch onto main first).

## Locked decisions (Wave 2)

- **Migration 0044** (one migration for the wave): `ai_proposals.origin` enum('feldart','tj') NULL (null = book-agnostic categories); `customer_ai_cards.summary_feldart` text NULL + `summary_tj` text NULL (existing `summary` stays as blended/single-book fallback); `invoices.bookkeeper_thread_id` varchar(128) NULL (Gmail threadId of the dispute's bookkeeper thread).
- **New proposal categories:** `tj_chase` (TJ severity → tj_l1/2/3, mirroring chase_next's two-stage propose→draft) and `tj_dispute_nudge` (verifying invoice whose bookkeeper thread is silent ≥ 7 days → drafts a bookkeeper follow-up; if NO thread linked yet, proposes the FIRST bookkeeper email instead). Both insert with `origin: 'tj'`; `chase_next` inserts `origin: 'feldart'`; ops_*/cadence_* stay NULL.
- **Thread linkage:** when the operator sends a bookkeeper email from the dispute flow, the send records the resulting Gmail threadId onto the invoice (`bookkeeperThreadId`). Plumbing: the compose context gains optional `disputeInvoiceId`; the email-send route, after a successful send, updates the invoice row (audit_log row included). The TJ panel + customer-detail bookkeeper buttons pass the invoiceId (panel header button uses the oldest verifying invoice — already its docNumber source).
- **Nudge silence detection:** latest `email_log` row with `threadId = invoices.bookkeeperThreadId` (either direction); silent = `emailDate ≤ now − 7d`. No thread → "needs first bookkeeper email" nudge (different proposal summary text, same category).
- **Autopilot page sections:** proposals with `origin='tj'` render in an amber TJ section (BookSectionHeader reuse); everything else (feldart + NULL book-agnostic) renders in the Feldart/main section. TJ section hidden when empty.
- **TJ proposals respect the same gates as Feldart:** autopilot scan cron setting, propose→approve only, dedupe vs in-flight, dismissed/snoozed semantics. Verifying invoices are EXCLUDED from tj_chase severity (Wave B) but ARE the subject of tj_dispute_nudge.
- **AI card per-book:** when the customer has both books (per the same predicate as the header pills), the generator produces `summary_feldart` + `summary_tj` (one prompt, structured output with two fields — NOT two API calls); single-book customers keep using `summary` only. Card actions gain optional `origin`; customer-detail's action handler uses `action.origin` when present (falls back to the Wave 1 smart default). Card UI renders origin-chipped paragraphs when per-book fields exist.
- **Digest:** the daily chase digest gains a TJ section fed by the same TJ severity path (verifying excluded) + a dispute-pipeline line (N verifying, M awaiting first bookkeeper email). Where the digest prompt/renderer lives: `src/modules/chase/digest.ts` + `src/integrations/anthropic/chase-digest.ts`.
- **Cleanups (from Wave 1 reviews):** delete the dead `'both'` from chase-email-send-dialog prop type + send/preview route schemas (enum becomes feldart|tj, default feldart); compose-modal statement attach gains a tiny Feldart/TJ picker (defaults Feldart) — closes the W1 regression where TJ statements couldn't be attached from compose.

## File map

| File | Change |
|---|---|
| `src/db/schema/ai-proposals.ts` + `customer-ai-cards.ts` + `invoices.ts` + `migrations/0044_*` | T1 |
| `src/server/routes/email-send.ts` + compose-modal/context + dispute callers | T2 thread linkage |
| `src/modules/ai-agent/candidates/tj-chase.ts` + `tj-dispute-nudge.ts` (new) + `scanner.ts` + voice/template ladder | T3 |
| `src/modules/ai-agent/` drafting (tj templates) + executor/tools origin threading | T3 |
| `src/web/pages/autopilot.tsx` | T4 sections |
| `src/modules/ai-agent/customer-card.ts` + route + `customer-ai-card.tsx` + customer-detail handler | T5 |
| `src/modules/chase/digest.ts` + `src/integrations/anthropic/chase-digest.ts` | T6 |
| chase dialog/routes `'both'` removal + compose-modal statement picker | T6 |

---

### Task 1: Migration 0044 + schema
- [ ] Schema edits per locked decisions (three files). `npm run db:generate` → 0044; apply locally (`db:migrate`).
- [ ] `AI_PROPOSAL_CATEGORIES` gains `tj_chase`, `tj_dispute_nudge`; category metadata (labels/badges) wherever the UI maps categories (autopilot.tsx NO_DRAFT_CATEGORIES etc. — tj_dispute_nudge IS a draft category).
- [ ] Typecheck + tests. Commit `feat(db): ai origin + per-book card summaries + bookkeeper thread linkage (osplit2 W2 T1)`.

### Task 2: Bookkeeper thread linkage
- [ ] Compose context gains `disputeInvoiceId?: string`; the TJ panel + customer-detail bookkeeper buttons pass it (per-invoice buttons → that invoice; panel-header button → oldest verifying invoice).
- [ ] email-send route: after successful send, when `disputeInvoiceId` present → verify the invoice exists, is origin 'tj' (reject otherwise, 400), update `bookkeeperThreadId` with the sent message's threadId + audit_log row (action `dispute.bookkeeper_thread_linked`, before/after).
- [ ] Tests: route-level helper or module test for the linkage guard; TDD.
- [ ] Commit `feat(disputes): link bookkeeper email thread to invoice (osplit2 W2 T2)`.

### Task 3: TJ proposer — tj_chase + tj_dispute_nudge
- [ ] **tests first** for both candidate finders (mock db seams like chase-next's tests): tj_chase = TJ severity path (net credits, verifying excluded, tier→tj_l level), dedupe semantics identical to chase_next; tj_dispute_nudge = verifying invoices: linked thread silent ≥7d → follow-up nudge; no thread → first-email nudge; thread active <7d → no proposal.
- [ ] Implement both candidates; wire into `scanner.ts` category loop; proposals insert `origin`.
- [ ] Drafting: tj_chase drafts use tj_l{level} templates + the voice guide (mirror CHASE_TIER_SLUG with a TJ ladder); tj_dispute_nudge drafts a bookkeeper email (recipient = tj_bookkeeper_email setting; body references invoice + claim date + prior thread context if any). Executor: approve → send via existing tools with origin threading (chase email tool gains origin; statement tool already requires it).
- [ ] Commit `feat(ai): TJ chase + dispute-nudge proposers (osplit2 W2 T3)`.

### Task 4: Autopilot page — two sections
- [ ] Group proposals: `origin === 'tj'` → amber TJ section (BookSectionHeader book="tj"); rest → Feldart/main section (BookSectionHeader book="feldart"). Existing sort within each. Category badges for the two new categories (amber-toned for tj_dispute_nudge like the mockup's DISPUTE NUDGE chip).
- [ ] TJ section hidden when no TJ proposals. Mobile stacks.
- [ ] Commit `feat(autopilot): per-book proposal sections (osplit2 W2 T4)`.

### Task 5: AI card per-book
- [ ] Generator: when customer has both books (same predicate as header pills — read kpi or compute), prompt carries per-book balances/ages/dispute states and the structured output schema gains `summary_feldart` + `summary_tj`; single-book unchanged (blended `summary`). Persist accordingly. Actions array entries gain `origin` where the action is book-specific (send_chase_email, send_statement).
- [ ] Route returns the new fields; component renders per-book paragraphs with FELDART/TJ chips when present (mockup: origin-chipped lines); customer-detail action handler prefers `action.origin`.
- [ ] Tests for the generator's schema/persistence branch (mock Anthropic like existing card tests).
- [ ] Commit `feat(ai): per-book customer card summaries + origin-aware actions (osplit2 W2 T5)`.

### Task 6: Digest TJ section + cleanups + SHIP
- [ ] Digest: TJ section (TJ severity rows + dispute-pipeline line). Read how the digest builds its prompt/HTML and mirror for TJ; clearly separated in the output email.
- [ ] Cleanups: drop `'both'` from chase-email-send-dialog prop type + chase send/preview route schemas; compose-modal statement-attach Feldart/TJ picker (default Feldart).
- [ ] Full gates (vitest/tsc/build) + Playwright pass (/autopilot sections with seeded proposals if feasible locally — else render check; AI card render; compose picker) + Opus wave review + fixes.
- [ ] Merge → push → watch Deploy → prod post-checks over SSH (migrations 45; pm2; app; spot-check /autopilot + a customer AI card).
