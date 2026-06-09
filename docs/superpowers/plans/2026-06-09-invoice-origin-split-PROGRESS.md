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
- [x] Wave A + Wave B plans + this tracker committed — `<sha-pending>`
- [ ] Wave A T1 schema/migration
- [ ] Wave A T2 origin classifier
- [ ] Wave A T3 sync origin + credit_memos
- [ ] Wave A T4 per-origin balances
- [ ] Wave A T5 lookups/digest scoping
- [ ] Wave A T6 chase route + toggle
- [ ] Wave A T7 customer-detail route
- [ ] Wave A T8 customer-detail page
- [ ] Wave A T9 customers list route + page
- [ ] Wave A T10 autopilot feldart-scope
- [ ] Wave A T11 origin-review sweep
- [ ] Wave A T12 verify + review + MERGE/PUSH/DEPLOY
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
