# Invoice Origin Split — Wave B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use `- [ ]`. **Commit after every task** (compact-proofing). Wave B depends on Wave A being merged.

**Goal:** Give the TJ track its own voice and the dispute loop: TJ-specific tiered chase templates (firm, not legalistic), a manual "claims-paid → verifying → email bookkeeper → void/resume" dispute lifecycle, one-click bookkeeper email, and per-origin statements.

**Architecture:** Local dispute-state columns on `invoices` (never round-trip to QBO except the void). Chase send branches template slug by origin. Bookkeeper email reuses the existing compose modal pre-filled. Statements gain an origin filter. Void resolution reuses the existing QBO sparse-update void write-path + audit pattern.

**Tech Stack:** as Wave A.

**Spec:** `docs/superpowers/specs/2026-06-09-invoice-origin-split-design.md`

**Branch:** `feat/invoice-origin-split-wave-b`.

## Locked decisions (Wave B)

- Dispute columns on `invoices`: `disputeState enum(verifying, confirmed_paid, confirmed_unpaid)` nullable, `disputeClaimedAt`, `disputeNote`, `disputeUpdatedBy` (fk users). Migration `0041`.
- `disputeState='verifying'` excludes the invoice from active TJ chase/scoring/digest (extends Wave A lookups).
- TJ templates: slugs `tj_l1`/`tj_l2`/`tj_l3`, `context: chase`; ramping firmness, top tier firm-not-legalistic, every tier carries the dispute invite.
- Chase send picks `origin === 'tj' ? tj_l${level} : chase_l${level}` (`chase.ts:587`).
- "Paid → Void" voids in QBO from the hub (sparse update `Active:false`, `client.ts:527`), then local soft-void + `audit_log` (pattern at `sync.ts:607–624`), with a confirm dialog.
- Bookkeeper email: `app_settings.tj_bookkeeper_email` (+ `tj_bookkeeper_name`); opens compose pre-filled via `context.prefill` + `customerEmail`.
- Per-origin statements: `sendStatement` gains `origin?: 'feldart'|'tj'` filter (`send.ts:397`).

## File map

| File | Change |
|---|---|
| `src/db/schema/invoices.ts` | + dispute columns |
| `migrations/0041_*.sql` | generated |
| `scripts/seed-email-templates.ts` (or seed route) | + tj_l1/l2/l3 rows |
| `src/server/routes/chase.ts` | template slug branches on origin; verifying-exclusion already via lookups |
| `src/modules/chase/lookups.ts` | exclude `disputeState='verifying'` from active TJ list |
| `src/server/routes/disputes.ts` (new) | claims-paid / resolve-paid(void) / resolve-unpaid |
| `src/integrations/qb/client.ts` | (reuse) void sparse update |
| `src/web/components/dispute-actions.tsx` (new) | row buttons + verifying badge + note |
| `src/web/pages/chase.tsx` | dispute actions on TJ rows |
| `src/web/pages/customer-detail.tsx` | dispute actions on TJ invoice rows + bookkeeper email button |
| `src/db/schema/app-settings.ts` + route | + tj_bookkeeper_email / _name |
| `src/web/pages/settings.tsx` | bookkeeper fields |
| `src/modules/statements/send.ts` + `index.ts` | origin filter |
| `src/server/routes/chase.ts` (batch-statement) / statement routes | pass origin |

---

### Task 1: Schema — dispute columns + migration

**Files:** Modify `src/db/schema/invoices.ts`; generate `migrations/0041_*.sql`.

- [ ] **Step 1:** Add to `invoices`:

```ts
disputeState: mysqlEnum("dispute_state", ["verifying", "confirmed_paid", "confirmed_unpaid"]),
disputeClaimedAt: timestamp("dispute_claimed_at"),
disputeNote: text("dispute_note"),
disputeUpdatedBy: varchar("dispute_updated_by", { length: 255 }).references(() => users.id, { onDelete: "set null" }),
```
Add index `disputeStateIdx: index("idx_invoices_dispute_state").on(t.disputeState)`.

- [ ] **Step 2:** `npm run db:generate` → verify `0041_*.sql`. Typecheck clean.
- [ ] **Step 3:** Commit: `git add -A && git commit -m "feat(db): invoice dispute-state columns (wave B)"`.

---

### Task 2: TJ chase templates (seed)

**Files:** Modify the email-template seeder (`scripts/seed-email-templates.ts` or the seed mechanism found in Wave A recon).

- [ ] **Step 1:** Add three `email_templates` rows, `context: chase`, slugs `tj_l1/tj_l2/tj_l3`, with subject/body. Tone: tj_l1 gentle + handover acknowledgement + dispute invite; tj_l2 firmer; tj_l3 firm-not-legalistic (no "further action"/legal threat). Each body includes the merge fields the chase render uses (mirror `chase_l1/2/3` placeholders) and the line *"If you've already settled this with Torah Judaica, reply and we'll verify."*

- [ ] **Step 2:** Run the seeder; verify rows exist (query by slug). 
- [ ] **Step 3:** Commit: `git add -A && git commit -m "feat(templates): TJ chase templates tj_l1/l2/l3 (wave B)"`.

---

### Task 3: Chase send — branch template by origin; exclude verifying

**Files:** Modify `src/server/routes/chase.ts` (~:587), `src/modules/chase/lookups.ts`.

- [ ] **Step 1:** In the chase send + preview handlers, after loading the customer/origin, compute `const slug = origin === "tj" ? \`tj_l${level}\` : \`chase_l${level}\`;` and load that template. (Origin is the request's chase origin or derived from the invoices in scope.)
- [ ] **Step 2:** In `lookups.ts` (Wave A `getOverdueCustomers('tj')`), exclude invoices/customers where `disputeState = 'verifying'` from the active TJ list, scoring, and digest.
- [ ] **Step 3:** Typecheck clean. Add a lookups test asserting a verifying TJ invoice is excluded.
- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(chase): TJ template selection + exclude verifying invoices (wave B)"`.

---

### Task 4: Dispute endpoints

**Files:** Create `src/server/routes/disputes.ts`; register in `routes/index.ts`.

- [ ] **Step 1:** `POST /api/invoices/:id/dispute/claims-paid` (body `{ note? }`): set `disputeState='verifying'`, `disputeClaimedAt=now`, `disputeNote`, `disputeUpdatedBy=user.id`; audit_log. Reject if invoice origin !== 'tj'.
- [ ] **Step 2:** `POST /api/invoices/:id/dispute/resolve-unpaid`: set `disputeState='confirmed_unpaid'` (returns to active TJ chase); audit_log.
- [ ] **Step 3:** `POST /api/invoices/:id/dispute/resolve-paid`: read invoice (`qbInvoiceId`, `syncToken`); call `qb.updateInvoice({ Id, SyncToken, sparse: true, Active: false })`; locally set `status='void'`, `balance='0'`, `disputeState='confirmed_paid'`; write `audit_log` (action `dispute.void_qbo`, before/after, userId). Handle QBO error gracefully (return 502, leave state).
- [ ] **Step 4:** Add a focused test for the state transitions (mock the QBO client for resolve-paid). Typecheck clean.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(api): TJ dispute lifecycle endpoints incl. QBO void (wave B)"`.

---

### Task 5: Dispute UI — row actions + verifying badge + bookkeeper email

**Files:** Create `src/web/components/dispute-actions.tsx`; modify `src/web/pages/chase.tsx`, `src/web/pages/customer-detail.tsx`.

- [ ] **Step 1:** `DisputeActions` component: for a TJ invoice, shows `Customer claims paid` (→ POST claims-paid, optimistic). When `disputeState='verifying'`: show a `Verifying · claims paid <date>` badge, a note field, `✉ Email TJ bookkeeper`, and `Paid → Void` (confirm dialog) / `Not paid` buttons wired to the endpoints. Invalidate the relevant queries on success.
- [ ] **Step 2:** `✉ Email TJ bookkeeper`: open the compose modal with `context = { customerId, customerEmail: appSettings.tj_bookkeeper_email, prefill: { subject, bodyHtml } }` referencing the invoice (number/customer/amount/date). (Read the bookkeeper address from the app-settings query.)
- [ ] **Step 3:** Mount `DisputeActions` on TJ rows in the chase list (TJ toggle) and the customer-detail TJ invoice section. Verifying invoices render distinctly (muted + badge).
- [ ] **Step 4:** Typecheck clean.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(web): TJ dispute actions + bookkeeper email (wave B)"`.

---

### Task 6: Settings — TJ bookkeeper email

**Files:** Modify `src/db/schema/app-settings.ts` (canonical keys), `src/server/routes/app-settings.ts` (if keys are whitelisted), `src/web/pages/settings.tsx`.

- [ ] **Step 1:** Add `tj_bookkeeper_email` (+ `tj_bookkeeper_name`) to the canonical settings keys.
- [ ] **Step 2:** Render two inputs in Settings (mirror the statement-PDF settings field pattern); save via the existing PATCH.
- [ ] **Step 3:** Typecheck clean.
- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(settings): TJ bookkeeper email/name (wave B)"`.

---

### Task 7: Per-origin statements

**Files:** Modify `src/modules/statements/send.ts` (+ `index.ts` type), and the statement send routes / chase batch-statement to pass origin.

- [ ] **Step 1:** Add `origin?: 'feldart'|'tj'` to the statement send input; slot `origin ? eq(invoices.origin, origin) : undefined` into the open-invoices `where` (`send.ts:397`).
- [ ] **Step 2:** Where statements are triggered from the (now origin-scoped) chase list, pass the active origin so a TJ statement only lists TJ invoices. Default (no origin) stays blended for any non-origin caller.
- [ ] **Step 3:** Add a test asserting an origin-filtered statement only includes that origin's invoices. Typecheck clean.
- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(statements): per-origin statement filtering (wave B)"`.

---

### Task 8: Verify + review + ship

- [ ] **Step 1:** Apply `0041` locally; start dev servers.
- [ ] **Step 2:** Playwright: TJ chase uses TJ template (preview); claims-paid parks an invoice out of the TJ list + shows badge; bookkeeper email opens pre-filled; resolve-unpaid resumes; resolve-paid voids (mock/guard against hitting real QBO — verify the call is constructed, or test against a sandbox). Per-origin statement lists only that origin. Screenshot; clean up.
- [ ] **Step 3:** Independent Opus review over the Wave B diff (dispute state machine correctness; void path safety incl. confirm + audit; template selection; no accidental QBO writes in tests). Fix findings.
- [ ] **Step 4:** Typecheck + `npx vitest run` (touched suites). Green.
- [ ] **Step 5:** Merge → `main`; push; watch Deploy to completion.
