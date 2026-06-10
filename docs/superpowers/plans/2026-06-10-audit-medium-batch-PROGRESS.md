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
- [ ] T4 #14 qty_change effective-rate discount preservation
- [ ] T5 #15 server-side parse-gap verify gate
- [ ] T6 #16 Gmail direction from live aliases
- [ ] T7 FK drift schema declarations + no-op migration 0042
- [x] T8 local migration-journal backfill — DONE inline (no commit): missing DDL applied (ai_learned_corrections table, email_log.draft_ai_notes, 2 idx, 4 FKs), journal rows 37–41 backfilled, `db:migrate` clean. Memory updated.
- [ ] Full verify (tests/typecheck/build/Playwright spot-check)
- [ ] Opus review (two-stage) + fixes
- [ ] MERGE + PUSH + watch Deploy green + prod post-checks over SSH
