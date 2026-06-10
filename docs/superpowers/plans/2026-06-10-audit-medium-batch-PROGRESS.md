# Audit Medium Batch — live progress tracker

Plan: `2026-06-10-audit-medium-batch.md` · Branch: `fix/audit-medium-batch` · Started 2026-06-10

Baseline: main @ `68f37aa`, 631 tests passing.

Context notes (survive compact):
- All findings re-verified 2026-06-10 by 6 Explore agents; prod FK names verified over SSH.
- NEW: Claude has direct VPS SSH access (`ssh finance-vps`) — TJ template seed + tj_bookkeeper_email prod follow-ups already done this session.
- Local DB schema matches 0041; only `__drizzle_migrations` rows 37–41 missing (T8 backfills).
- T7 (FK drift) must be the LAST code task (regenerates drizzle meta).

## Status log (append one line per task as completed, with commit sha)
- [x] Recon (6 Explore agents) + plan written + committed
- [x] T1 #11/#17 returns tax surfacing + fee parity — `f39a702` + review fix `3f12a2b` (spec ✅, quality ✅)
- [x] T2 #12 blended chase severity from invoices — `05e9773` + dashboard `9fc710f` + review fixes `525e563` (spec ✅, quality ✅ after parity+boundary fixes). Suite 652/652.
- [x] T3 #13 atomic Shopify tag mutations — `d4e6514` (graphql client + atomic addTag/removeTag) + `cc939e6` (holds route intent-ops, setCustomerTags deleted, ACCESS_DENIED→403) + `c9cf1bd` (partial-failure audit row). Spec ✅ (36-combination end-state diff = 0 mismatches), quality ✅. Shopify tests 37/37.
- [x] T4 #14 qty_change effective-rate discount preservation — `ff2a9c8` + penny-drift fix `1609dba` (round5 rate; spec ✅, quality ✅). b2b suite 82/82.
- [x] T5 #15 server-side parse-gap verify gate — `fe64429` + zod-cap fix `87bab6c` (spec ✅ parity table verified, quality ✅). Mobile detail page was an ungated second /send caller — now fail-closed. b2b suite 93/93.
- [x] T6 #16 Gmail direction from live aliases — `1f521bd` (spec ✅, quality ✅). Follow-ups noted, non-blocking: (a) listAliases has no negative cache — outage = cold fetch per cycle; (b) historical rows stay misclassified (no backfill); (c) aliasUsed stored raw-case.

## ⏸ PAUSED HERE 2026-06-10 (operator request) — how to resume

Branch `fix/audit-medium-batch` has T1–T6 complete (each two-stage reviewed: spec + Opus quality, all findings fixed). NOT merged, NOT deployed. Remaining:
1. **T7 FK drift** (plan Task 7) — declare the 4 `fk_*_ai_proposal` FKs in schema TS with exact prod names, `npm run db:generate` → blank migration 0042's SQL (comment only), verify generate-again = no changes and local db:migrate applies 0042 as no-op. MUST be the last code task (regenerates drizzle meta).
2. Full verify: `npm test` (baseline 631 → now ~652+ with new tests) + typecheck + build + Playwright spot-check (RMA dialog amber warning, Today→Orders send, chase list).
3. Final whole-branch Opus review.
4. Merge → push → watch Deploy to completion (re-run on SSH timeout) → prod post-checks over `ssh finance-vps` (migrations count, pm2, app up).
- [ ] T7 FK drift schema declarations + no-op migration 0042
- [x] T8 local migration-journal backfill — DONE inline (no commit): missing DDL applied (ai_learned_corrections table, email_log.draft_ai_notes, 2 idx, 4 FKs), journal rows 37–41 backfilled, `db:migrate` clean. Memory updated.
- [ ] Full verify (tests/typecheck/build/Playwright spot-check)
- [ ] Opus review (two-stage) + fixes
- [ ] MERGE + PUSH + watch Deploy green + prod post-checks over SSH
