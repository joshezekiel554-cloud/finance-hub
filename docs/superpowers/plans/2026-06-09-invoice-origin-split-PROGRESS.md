# Invoice Origin Split — PROGRESS TRACKER (compact-proof)

**If you (Claude) are resuming after a compaction, read this first**, then `git log --oneline -20` to see exactly where execution stopped, then continue the next unchecked step.

- **Spec:** `docs/superpowers/specs/2026-06-09-invoice-origin-split-design.md`
- **Wave A plan:** `docs/superpowers/plans/2026-06-09-invoice-origin-split-wave-a.md`
- **Wave B plan:** `docs/superpowers/plans/2026-06-09-invoice-origin-split-wave-b.md`
- **Branches:** Wave A → `feat/invoice-origin-split`; Wave B → `feat/invoice-origin-split-wave-b`.
- **User directives:** work autonomously to completion; quality over token-saving; fix bugs; review; merge + push + **watch Deploy to completion** each wave; **commit after every task** (compact-proofing).

## Conventions / locked decisions
- Enum lowercase `feldart|tj`. `invoices.origin` NOT NULL default feldart; backfill `tj` for `doc_number LIKE '2%'`. `origin_source` prefix|manual|needs_review.
- Credit-memo origin v1: DC####/returns → feldart; else prefix; else needs_review. (No QBO LinkedTxn → no inherit-from-invoice yet.)
- Chase overdue is invoice-driven; TJ figure nets TJ unapplied credit.
- Autopilot chase candidates = Feldart only.
- Dispute schema + "Paid→Void in QBO (with confirm)" = Wave B.

## Status log (append one line per task as completed, with commit sha)
- [x] Spec written + reviewed + approved (`5669f93`, `cd25d45`)
- [x] Recon (4 Explore agents) done
- [x] Wave A + Wave B plans + this tracker committed — `b7296b1`
- [x] Wave A T1 schema/migration — `23ed032` (migration 0040)
- [x] Wave A T2 origin classifier — `e14284a`
- [x] Wave A T3 sync origin + credit_memos — `87dc26f`
- [x] Wave A T4 per-origin balances — `cbe2489`
- [x] Wave A T5 lookups/digest scoping — `a43be16`
- [x] Wave A T6 chase route + toggle — `f14688b`
- [x] Wave A T7 customer-detail route (+T9 route) — `15e1813`
- [x] Wave A T8 customer-detail page — `66aa03d`
- [x] Wave A T9 customers list page — `94ea3ce`
- [x] Wave A T10 autopilot feldart-scope — `83b05be`
- [x] Wave A T11 origin-review sweep — `ad272a2`
- [x] Wave A T12 verify + impeccable sweep + review + fixes — Playwright-verified all surfaces with real data (feldart 101 / tj 21 / both 117 chase rows, 5 mixed customers), Opus review found 1 HIGH (chase double-net credit) + colSpan off-by-one, both fixed (`1a95bfe`). 628 tests pass.
- [x] **Operator-feedback enhancement** (`ba67287`): chase "Both" option; customers list Feldart/TJ/Both lens (Both → 3 cols incl Combined; single book → just that col) + combinedBalance sort key.
- [x] Wave A MERGE/PUSH/DEPLOY — merge `3746d1b` to main, pushed, **deployed OK in 1m48s** (migration 0040 applied on VPS, /health passed). WAVE A LIVE on finance.feldart.com.
- [ ] Wave B T1 dispute schema/migration  ← NEXT (branch feat/invoice-origin-split-wave-b)
- [ ] Wave B T1 dispute schema/migration
- [ ] Wave B T2 TJ templates seed
- [ ] Wave B T3 chase send branch + exclude verifying
- [ ] Wave B T4 dispute endpoints
- [ ] Wave B T5 dispute UI + bookkeeper email
- [ ] Wave B T6 settings bookkeeper
- [ ] Wave B T7 per-origin statements
- [ ] Wave B T8 verify + review + MERGE/PUSH/DEPLOY

## Decisions made autonomously (flag to user at end)
- Credit-memo "inherit origin from applied invoice" dropped for v1 (QBO fetch lacks LinkedTxn). Manual sweep + override covers misclassifications.
- Customers list: replace blended Balance column with Feldart+TJ columns (keep Overdue blended) to manage width — revisit visually.
- Wave C (AI assist off transcripts + external handover) intentionally NOT built — out of scope per spec; "all waves" = A + B.
- Dropped planned `aggregateCreditBalanceByOrigin` helper (T3 step5): redundant now that `credit_memos` stores origin — per-origin credit is a `SELECT origin, SUM(balance) ... GROUP BY origin` query consumed by `computeOriginBalances`.
- Credit netting (`balances.ts`): credit reduces both balance and overdue floored at 0 (conservative — avoids over-chasing). Net overdue <= net balance always.
- **Open follow-ups from review (LOW, deferred):** (1) `chase-next.ts` autopilot nets Feldart overdue against the customer's BLENDED unapplied credit (TJ credit can slightly reduce a Feldart chase proposal) — conservative/advisory only, violates strict "TJ credit never offsets Feldart" in that one advisory path; (2) `0040` backfill uses `doc_number LIKE '2%'` without trim (a leading-space docNumber self-corrects on next sync). Neither blocks; worth a Wave B-adjacent cleanup.
