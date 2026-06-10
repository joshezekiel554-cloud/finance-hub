# Origin Split 2.0 — live progress tracker

Spec: `../specs/2026-06-10-origin-split-2-design.md` · Branch: `feat/origin-split-2` (off main `4329f7a`, which includes the audit batch) · Started 2026-06-10 · Operator authorized full autonomous Wave 1 + Wave 2 execution.

Context notes (survive compact):
- Surface choices locked via visual brainstorm: chase = Feldart queue + TJ wind-down panel (option B); customer detail = two book panels (B); autopilot = two proposal sections (A); customers list = Feldart-shaped + TJ strip/on-demand column (C).
- Wave 1 = UI separation (plan `2026-06-10-origin-split-2-wave-1.md`, migration 0043 tj_exposure_snapshots). Wave 2 = AI separation (TJ proposer + tj_dispute_nudge + per-book AI card + digest TJ section; plan to be written after Wave 1 ships; needs migration 0044: ai_proposals.origin, customer_ai_cards.summary_feldart/tj, invoices.bookkeeper_thread_id for nudge detection — recon 2026-06-10 found no existing invoice↔bookkeeper-thread linkage).
- Statement per-row send + statement-send-dialog currently post NO origin (silent blended) — fixed by W1 T5.
- VPS direct SSH available (`ssh finance-vps`).

## Status log
- [x] Spec written, operator-approved, committed (`818042b` post-rebase)
- [x] Recon (2 thorough agents) — anchors embedded in W1 plan
- [x] W1 T1 winddown backend + 0043 — `006e7ec` + polish `b6500b0` (spec ✅, quality ✅; baselineDate + 15-min upsert throttle added). winddown 18 tests, chase suite 57/57. Migration `0043_omniscient_sauron` applied locally.
- [x] W1 T2 chase two sections — `95376bc` + review fixes `b607d63` (spec ✅ incl. sequential TJ chase queue judged faithful; quality ✅ after per-row statement scoping + shared bookkeeper-compose helper extraction). Full suite 710/710. book-sections/ components born.
- [x] W1 T3 customers list strip — `09baff4` + spec fix `5f084a0` (Feldart-scoped Overdue + feldartBalance default sort; spec §5 caught blended overdue) + `e126abb` (Days column scoped). Spec ✅, quality ✅. Suite 710/710.
- [x] W1 T4 customer-detail panels — `b1a64e6` + review fixes `3679426` (spec ✅ after pill-age restore + mixed-book bulk-chase guard; quality ✅). Header pills (feldartOldestDays/tjVerifyingCount KPIs added), BookInvoiceSection shared renderer, rail KPI cards + OriginChip + blended footer deleted, header Chase/Statement moved into panels. Suite 710/710. T5 notes: flip statement origin REQUIRED; check AI-card send_statement 'feldart' default for pure-TJ; statement PREVIEW still blended.
- [x] W1 T5 statements origin required — `3423567` + doc-comment fix (spec ✅ blended-path grep clean repo-wide incl. jobs/AI; quality ✅ rolling-deploy 400 fail-safe verified). Preview parity via shared buildOpenInvoiceConditions. Suite 717/717. W2 note: compose-modal statement attach is feldart-only — book picker candidate.
- [ ] W1 T6 dashboard per-book amounts
- [ ] W1 T7 verify + Opus wave review + MERGE/PUSH/DEPLOY
- [ ] W2 plan written
- [ ] W2 execution (proposer/nudge/AI card/digest)
- [ ] W2 verify + review + MERGE/PUSH/DEPLOY
