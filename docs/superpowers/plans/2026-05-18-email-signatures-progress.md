# Email Signatures — Live Progress Tracker

**Plan:** [`2026-05-18-email-signatures.md`](./2026-05-18-email-signatures.md)
**Spec:** [`docs/superpowers/specs/2026-05-18-email-signatures-design.md`](../specs/2026-05-18-email-signatures-design.md)
**Branch:** `feat/email-signatures`
**Started:** 2026-05-18

This file is updated after every task completes — pushed to origin so it survives auto-compact. Read top-down for current state.

---

## Status legend

- ☐ pending
- 🔄 in progress
- ✅ done
- ⚠️ blocked / needs attention
- 🔁 needs rework after review

## Wave map

| Wave | Tasks | Mode | Status |
|---|---|---|---|
| 0 | 1, 2 | Subagent (sequential) | ✅ |
| 1 | 3, 4 | Subagent (sequential — Task 4 imports Task 1's schema) | ✅ |
| 2 | 5 | Subagent | ✅ |
| 3 | 6a, 6b, 6c, 6d, 6e, 6f, 6g | Sequential subagents (revised from team — see event log 15:03) | ✅ |
| 4 | 7, 8 | Subagent (sequential foreground — same rationale as Wave 3) | ✅ |
| 5 | 9 | Subagent | ✅ |
| 6 | 10a, 10b, 10c, 10d | **Team of 4** (parallel, no-commit pattern) | ✅ |
| 7 | 11 | Subagent | 🔄 |
| 8 | 12 | Inline (manual smoke) | ☐ |

Two-stage Opus review runs at end of each wave before next dispatch.

---

## Task ledger

### Task 1: Drizzle schema + relations
- Status: ✅
- Owner: schema-builder
- Files: `src/db/schema/user-signatures.ts`, `src/db/schema/alias-signatures.ts`, `src/db/schema/index.ts`, `src/db/relations.ts`
- Commit: `f992d50`
- Notes: Clean — no deviations. `tsc -b && tsc-alias && vite build` all green.

### Task 2: Generate + verify migration
- Status: ✅
- Owner: migration-runner
- Files: `migrations/0034_email_signatures.sql`, `migrations/meta/_journal.json`
- Commit: `bc6ecb9`
- Notes: Drizzle-kit generated correct SQL (2 CREATE TABLE, 2 FK ALTERs, 2 INDEXes). `npm run db:migrate` applied cleanly.

### Task 3: Sanitizer (TDD)
- Status: ✅
- Owner: sanitizer-tdd
- Files: `src/modules/email-compose/signatures.ts`, `src/modules/email-compose/signatures.test.ts`
- Commit: `c02b552`
- Notes: 9/9 tests pass. Real-signature smoke deferred (file outside repo).

### Task 4: composeSignatureHtml + appendSignatures
- Status: ✅
- Owner: append-builder
- Files: `src/modules/email-compose/signatures.ts` (extend), `src/modules/email-compose/signatures.test.ts` (extend)
- Commit: `4cce105`
- Notes: 14/14 tests pass. composeSignatureHtml pure-tested; appendSignatures DB-layer tested via downstream integration.

### Task 5: User-signatures CRUD route
- Status: ✅
- Owner: routes-builder
- Files: `src/server/routes/signatures.ts`, `src/server/routes/signatures.test.ts`, `src/server/routes/index.ts`
- Commit: `4588f29` (+ followup `3475b5e` for missed drizzle snapshot)
- Notes: 18/18 tests pass. All 6 endpoints (user CRUD + alias GET/PATCH), Zod 413 boundary, transactional default-clear, audit_log on every write.

### Task 6a: email-send.ts (compose modal route)
- Status: ✅
- Owner: send-route-6a
- Files: `src/server/routes/email-send.ts`
- Commit: `5e80eee`
- Notes: Sig appended into html branch; `text` derived from final post-sig html so MIME parts stay consistent.

### Task 6b: chase.ts
- Status: ✅
- Owner: send-route-6b
- Files: `src/server/routes/chase.ts`
- Commit: `77caca8`
- Notes: User sig appended; alias passes `""` because chase route doesn't carry an alias today (Gmail primary). Future: add alias selector to chase dialog → revisit aliasEmail arg.

### Task 6c: statements.ts (plumb only)
- Status: ✅
- Owner: send-route-6c
- Files: `src/server/routes/statements.ts` (NOT statement-sends.ts — that's audit-log GETs)
- Commit: `ea0b9ed`
- Notes: Body schema bumped + TODO comment for 6f. Plan amended to fix file-name mistake.

### Task 6d: invoicing.ts (send-invoice)
- Status: ✅ (N/A — no-op)
- Owner: send-route-6d
- Files: `src/server/routes/invoicing.ts` (no changes)
- Commit: —
- Notes: Invoices send via QBO's `/invoice/{id}/send` and `/salesreceipt/{id}/send` endpoints — QBO renders the body. No finance-hub bodyHtml to append to. Signatures are not applicable. Documented in plan's "Spec adaptations".

### Task 6e: returns.ts (RMA approval + denial)
- Status: ✅ (N/A — no-op, already wired via 6a)
- Owner: send-route-6e
- Files: `src/server/routes/returns.ts` (no changes)
- Commit: `fffcc44` (empty audit commit)
- Notes: RMA dialogs POST to `/api/send` (Task 6a's route), not dedicated handlers. Routes in returns.ts are *preview* only. So 6a already wires the end-to-end path; 10c/10d will plumb `userSignatureId` from the dialogs into the /api/send payload.

### Task 6f: statements module
- Status: ✅
- Owner: send-module-6f
- Files: `src/modules/statements/send.ts`, `src/server/routes/statements.ts`
- Commit: `a8630ea`
- Notes: appendSignatures inside the module (spec §9 relaxation — module IS the orchestrator). STATEMENT_ALIAS=accounts@feldart.com hardcoded → alias sig resolves cleanly after Task 11 seed.

### Task 6g: chase-digest cron job
- Status: ✅
- Owner: cron-wirer-6g
- Files: `src/jobs/definitions/chase-digest.ts`
- Commit: `8eec04d`
- Notes: userId:null, alias hard-coded "accounts@feldart.co.uk". Added `alias:` to sendEmail so send + sig-lookup keys align. Followup: signatures land outside `</body>` (htmlEnvelope returns full doc) — renders fine in clients but flagged.

### Task 7: SignatureEditor modal
- Status: ✅
- Owner: editor-builder
- Files: `src/web/components/signature-editor.tsx`
- Commit: `ecf8b16`
- Notes: Uses Dialog/Button/Input primitives; plain <label> (no Label primitive). Mapped color to accent-danger token.

### Task 8: SignaturePicker dropdown
- Status: ✅
- Owner: picker-builder
- Files: `src/web/components/signature-picker.tsx`
- Commit: `790ab73`
- Notes: Plain `<select>` per plan. Existing `./ui/select.tsx` not used (out of scope to retrofit). Auto-pre-selects default on mount.

### Task 9: Settings page integration
- Status: ✅
- Owner: settings-wirer
- Files: `src/web/pages/settings.tsx`
- Commit: `74ae464`
- Notes: Both sections inserted after EmailTemplatesSection (lines 78-79). Empty-sanitization warning implemented in both save handlers. +271 lines.

### Task 10a: compose-modal picker wiring
- Status: ✅
- Owner: picker-10a (team email-sigs-wave6)
- Files: `src/web/components/compose-modal.tsx`
- Commit: `fc055cc`
- Notes: Picker rendered in footer (mr-auto), userSignatureId in /api/send payload. Moved mr-auto off error span to keep layout. Picker-10a's build verified the combined 4-file state.

### Task 10b: chase-email-send-dialog picker wiring
- Status: ✅
- Owner: picker-10b (team email-sigs-wave6)
- Files: `src/web/components/chase-email-send-dialog.tsx`
- Commit: `cad95f1`
- Notes: Picker in footer (mr-auto), userSignatureId in /api/chase/send-chase-email payload.

### Task 10c: rma-approval-email-dialog picker wiring
- Status: ✅
- Owner: picker-10c (team email-sigs-wave6)
- Files: `src/web/components/rma-approval-email-dialog.tsx`
- Commit: `1d78cc6`
- Notes: Picker in DialogFooter, userSignatureId in /api/send payload.

### Task 10d: rma-denial-email-dialog picker wiring
- Status: ✅
- Owner: picker-10d (team email-sigs-wave6)
- Files: `src/web/components/rma-denial-email-dialog.tsx`
- Commit: `c2cd37b`
- Notes: Picker in footer, userSignatureId in /api/send payload + reset-on-open useEffect (bonus).

### Task 11: Gmail seed script
- Status: ☐
- Owner: —
- Files: `scripts/seed-alias-signatures-from-gmail.ts`, `package.json`
- Commit: —
- Notes: —

### Task 12: Smoke + finish
- Status: ☐
- Owner: —
- Files: (verification only)
- Commit: —
- Notes: —

---

## Event log (newest first)

- **2026-05-18 15:59** — Wave 6 complete. picker-10b ✅ `cad95f1`, picker-10c ✅ `1d78cc6`, picker-10d ✅ `c2cd37b`. Team pattern validated: 4 parallel pickers completed in ~3 minutes wall-clock (vs ~12 min sequential estimate). No-commit + batch-orchestrator-commit avoided git index race. picker-10d went idle without DM but its file change verified directly via git diff.
- **2026-05-18 15:57** — Wave 6 dispatched: 4 parallel background pickers in team `email-sigs-wave6`. All 4 modified files simultaneously; orchestrator commits one-by-one as notifications arrive. Picker-10a ✅ `fc055cc` (compose modal). Waiting on 10b/10c/10d.
- **2026-05-18 15:33** — Task 9 ✅ `74ae464` (settings-wirer). MySignaturesSection + AliasSignaturesSection wired. **Wave 5 complete**.
- **2026-05-18 15:30** — Task 8 ✅ `790ab73` (picker-builder). SignaturePicker dropdown. Wave 4 complete.
- **2026-05-18 15:27** — Task 7 ✅ `ecf8b16` (editor-builder). SignatureEditor modal built with project primitives.
- **2026-05-18 15:24** — Task 6g ✅ `8eec04d` (cron-wirer-6g). chase-digest cron wired with userId:null. **Wave 3 complete**: 5 real wires + 2 N/A.
- **2026-05-18 15:21** — Task 6f ✅ `a8630ea` (send-module-6f). appendSignatures inside statements module. Route TODO from 6c resolved.
- **2026-05-18 15:18** — Task 6e ✅ N/A (send-route-6e). RMA dialogs send via /api/send (already wired in 6a). Returns.ts has preview routes only. Plan §Spec-adaptations #8 added.
- **2026-05-18 15:14** — Task 6d ✅ N/A (send-route-6d). Invoices send via QBO native endpoints, not Gmail. No appendSignatures possible without scope-expanding refactor. Plan §Spec-adaptations #7 added.
- **2026-05-18 15:12** — Task 6c ✅ `ea0b9ed` (send-route-6c). statements.ts (not statement-sends.ts) plumbed. Plan amended for the file-name mistake.
- **2026-05-18 15:09** — Task 6b ✅ `77caca8` (send-route-6b). /api/chase/send-chase-email wired; chase route has no alias param so alias-sig skipped (backlog).
- **2026-05-18 15:06** — Task 6a ✅ `5e80eee` (send-route-6a). /api/send wired; signatures in both html+text MIME parts.
- **2026-05-18 15:03** — Wave 3 mode revised: sequential foreground subagents (not team-of-7). Parallel teammates on shared working tree would race on git's index lock; sequential delivers a steady stream of per-task reports that matches the "constantly reporting" requirement better.
- **2026-05-18 15:02** — Task 5 ✅ `4588f29` + followup `3475b5e` (routes-builder). 6 CRUD endpoints, 18/18 tests, build green. Followup commit added missing drizzle snapshot (migration-runner oversight in bc6ecb9). Wave 2 complete.
- **2026-05-18 14:59** — Task 4 ✅ `4cce105` (append-builder). composeSignatureHtml + appendSignatures + resolveUserSignature/resolveAliasSignature; 14/14 tests. Wave 1 complete.
- **2026-05-18 14:56** — Task 3 ✅ `c02b552` (sanitizer-tdd). sanitizeSignatureHtml + 9 vitest cases, all green.
- **2026-05-18 14:53** — Task 2 ✅ `bc6ecb9` (migration-runner). Migration 0034_email_signatures applied cleanly. Wave 0 complete.
- **2026-05-18 14:51** — Task 1 ✅ `f992d50` (schema-builder). user-signatures + alias-signatures Drizzle tables wired, relations updated, build green.
- **2026-05-18 14:45** — Plan + progress tracker created. Committed on `feat/email-signatures`. Beginning Wave 0.
