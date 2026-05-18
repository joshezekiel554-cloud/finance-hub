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
| 0 | 1, 2 | Subagent (sequential) | 🔄 |
| 1 | 3, 4 | Subagent (sequential — Task 4 imports Task 1's schema) | ☐ |
| 2 | 5 | Subagent | ☐ |
| 3 | 6a, 6b, 6c, 6d, 6e, 6f, 6g | **Team of 7** | ☐ |
| 4 | 7, 8 | Subagent (parallel — file-disjoint UI components) | ☐ |
| 5 | 9 | Subagent | ☐ |
| 6 | 10a, 10b, 10c, 10d | **Team of 4** | ☐ |
| 7 | 11 | Subagent | ☐ |
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
- Status: ☐
- Owner: —
- Files: `migrations/0034_email_signatures.sql`, `migrations/meta/_journal.json`
- Commit: —
- Notes: —

### Task 3: Sanitizer (TDD)
- Status: ☐
- Owner: —
- Files: `src/modules/email-compose/signatures.ts`, `src/modules/email-compose/signatures.test.ts`
- Commit: —
- Notes: —

### Task 4: composeSignatureHtml + appendSignatures
- Status: ☐
- Owner: —
- Files: `src/modules/email-compose/signatures.ts` (extend), `src/modules/email-compose/signatures.test.ts` (extend)
- Commit: —
- Notes: —

### Task 5: User-signatures CRUD route
- Status: ☐
- Owner: —
- Files: `src/server/routes/signatures.ts`, `src/server/routes/signatures.test.ts`, `src/server/routes/index.ts`
- Commit: —
- Notes: —

### Task 6a: email-send.ts (compose modal route)
- Status: ☐
- Owner: —
- Files: `src/server/routes/email-send.ts`
- Commit: —
- Notes: —

### Task 6b: chase.ts
- Status: ☐
- Owner: —
- Files: `src/server/routes/chase.ts`
- Commit: —
- Notes: —

### Task 6c: statement-sends.ts (plumb only)
- Status: ☐
- Owner: —
- Files: `src/server/routes/statement-sends.ts`
- Commit: —
- Notes: —

### Task 6d: invoicing.ts (send-invoice)
- Status: ☐
- Owner: —
- Files: `src/server/routes/invoicing.ts`
- Commit: —
- Notes: —

### Task 6e: returns.ts (RMA approval + denial)
- Status: ☐
- Owner: —
- Files: `src/server/routes/returns.ts`
- Commit: —
- Notes: —

### Task 6f: statements module
- Status: ☐
- Owner: —
- Files: `src/modules/statements/send.ts`
- Commit: —
- Notes: —

### Task 6g: chase-digest cron job
- Status: ☐
- Owner: —
- Files: `src/jobs/definitions/chase-digest.ts`
- Commit: —
- Notes: —

### Task 7: SignatureEditor modal
- Status: ☐
- Owner: —
- Files: `src/web/components/signature-editor.tsx`
- Commit: —
- Notes: —

### Task 8: SignaturePicker dropdown
- Status: ☐
- Owner: —
- Files: `src/web/components/signature-picker.tsx`
- Commit: —
- Notes: —

### Task 9: Settings page integration
- Status: ☐
- Owner: —
- Files: `src/web/pages/settings.tsx`
- Commit: —
- Notes: —

### Task 10a: compose-modal picker wiring
- Status: ☐
- Owner: —
- Files: `src/web/components/compose-modal.tsx`
- Commit: —
- Notes: —

### Task 10b: chase-email-send-dialog picker wiring
- Status: ☐
- Owner: —
- Files: `src/web/components/chase-email-send-dialog.tsx`
- Commit: —
- Notes: —

### Task 10c: rma-approval-email-dialog picker wiring
- Status: ☐
- Owner: —
- Files: `src/web/components/rma-approval-email-dialog.tsx`
- Commit: —
- Notes: —

### Task 10d: rma-denial-email-dialog picker wiring
- Status: ☐
- Owner: —
- Files: `src/web/components/rma-denial-email-dialog.tsx`
- Commit: —
- Notes: —

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

- **2026-05-18 14:51** — Task 1 ✅ `f992d50` (schema-builder). user-signatures + alias-signatures Drizzle tables wired, relations updated, build green.
- **2026-05-18 14:45** — Plan + progress tracker created. Committed on `feat/email-signatures`. Beginning Wave 0.
