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
- [x] W1 T6 dashboard per-book amounts — `da1316c` (blendedSeverityWithParts wrapper; totalOverdue dropped; spec+quality ✅ no findings). Suite 719/719.
- [x] W1 T7 verify + wave review — gates green (719/719, tsc, build); Playwright pass on all 4 surfaces + pure-Feldart/both-books cases, 0 console errors; Opus wave review: SHIP (cosmetic 'both' residue in chase dialog type → W2 cleanup item). MERGE/DEPLOY next.
- [x] W2 plan written — `192cce9`
- [x] W2 T1 migration 0044 + schema — `c5811be` (spec+quality ✅; note for T3: warn-log unwired finders)
- [x] W2 T2 bookkeeper thread linkage — `ea1f5d3` (spec+quality ✅, guard-before-send verified). Suite 725/725.
- [ ] W2 execution remaining (T3 proposers, T4 autopilot UI, T5 AI card, T6 digest+cleanups)
- [ ] W2 verify + review + MERGE/PUSH/DEPLOY
