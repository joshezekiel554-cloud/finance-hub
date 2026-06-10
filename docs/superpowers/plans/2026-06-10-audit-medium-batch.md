# Audit Medium Findings (#11–#17) + FK Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use `- [ ]`. **Commit after every task** (compact-proofing). Tasks are independent unless noted — execute in order anyway (T7 must come last before merge because it regenerates drizzle meta).

**Goal:** Close the remaining medium findings from the 2026-06-02 full-system audit — five silent-correctness/money bugs and one robustness gap — plus reconcile the schema↔migration FK drift and clean up the drifted local migration journal.

**Architecture:** Each finding is a narrow, self-contained fix in its existing module; no new subsystems. The FK drift is fixed by declaring the four existing DB constraints in the Drizzle schema with their exact prod names and shipping a deliberately-empty migration so no environment re-runs DDL it already has.

**Tech Stack:** as the rest of the repo (Fastify v5, Drizzle/mysql2, vitest, React/TanStack on the web side).

**Branch:** `fix/audit-medium-batch` (from `main` @ `68f37aa`).

**Recon provenance:** all findings re-verified against current code 2026-06-10 (6 Explore agents). Prod FK names verified live over SSH (`ssh finance-vps`).

## Locked decisions

- **#11**: don't change the tax default; *surface* lookup failures. `getSourceInvoiceTaxStatus` returns `failedDocNumbers: string[]` and logs each failure; callers expose it so the UI can warn "couldn't verify tax for invoice(s) X — check QBO" when defaulting the checkbox off.
- **#12**: blended chase severity stops trusting denormalized `customers.overdueBalance`. The blended lookup computes the same per-origin figures the rest of the app shows (`computeOriginBalances`: Feldart overdue + TJ overdue net of TJ credits) and passes the sum as the raw-overdue override to `computeSeverity`. The denormalized field stays only as the cheap candidate pre-filter.
- **#13**: switch hold tag writes to Shopify Admin **GraphQL `tagsAdd`/`tagsRemove`** (atomic server-side, no read-modify-write). Reads for status display stay REST.
- **#14**: on `qty_change`, preserve a baked-in line discount by using the **effective unit rate** (`origAmount / origQty`) when `origAmount ≠ round2(unitPrice × origQty)` (>1¢ delta); send `UnitPrice = effRate`, `Amount = round2(effRate × newQty)`.
- **#15**: enforce the parse-gap verify gate **server-side** in the send route: request carries `verifiedRemoveLineIds: string[]` + `unreadAck: boolean`; server re-derives flagged removes/unreadable rows from the source email with the same logic the GET uses and 400s on any uncovered flag.
- **#16**: direction classification uses the live Gmail sendAs alias list (`listAliases()`, already cached 5-min TTL) unioned with `BUSINESS_EMAILS` as a hard fallback (network failure ⇒ fallback only, warn-log). `BUSINESS_EMAILS` stays for the QBO-sync billing-email filter.
- **FK drift**: declare the 4 existing FKs in schema TS with their **exact prod constraint names** via `foreignKey({ name })` (NOT `.references()` — that would generate a differently-named constraint): `fk_activities_ai_proposal`, `fk_chase_log_ai_proposal`, `fk_email_log_ai_proposal`, `fk_statement_sends_ai_proposal` — all `ON DELETE SET NULL`, referencing `ai_proposals.id`. Generate migration 0042, then **blank its SQL** (comment only) because every environment already has the constraints from `0036_autopilot.sql`. `ai_proposals.scan_id` (no FK) and varchar status/category are intentional — no action.
- **Local journal**: local DB schema already matches 0041; only `__drizzle_migrations` rows 0037–0041 are missing. Backfill those rows (hash = sha256 hex of the migration file content, created_at = the journal entry's `when`); do NOT re-run DDL. Env-only task, no repo commit beyond the helper script if worth keeping.
- Out of scope (flag-only): restocking/shipping-fee taxability policy on credit memos (operator decision, see plan footer); the low/cleanup audit tier; `/process-return` fee-handling parity (#17's remaining gap is covered in T1's sibling step below — see T1 Step 5).

## File map

| File | Change |
|---|---|
| `src/modules/returns/source-invoice-tax.ts` | + `failedDocNumbers`, logging (#11) |
| `src/server/routes/returns.ts` | surface `failedDocNumbers` / `taxStatusUncertain`; `assertFeeItemConfigured` + fee tax-code parity on `/process-return` negative lines (#11, #17) |
| `src/web/` RMA credit-memo dialog component | amber warning when tax lookup partial (#11) |
| `src/modules/chase/lookups.ts` | blended path computes invoice-derived overdue override (#12) |
| `src/modules/chase/scoring.ts` | (only if override param needs widening) (#12) |
| `src/integrations/shopify/hold.ts` (+ `client.ts` if no GraphQL helper) | `tagsAdd`/`tagsRemove` mutations (#13) |
| `src/modules/b2b-invoicing/sender.ts` | effective-rate qty_change (#14) |
| `src/server/routes/invoicing.ts` | server-side verify gate on send (#15) |
| `src/web/pages/invoicing-today.tsx` | send payload carries `verifiedRemoveLineIds` + `unreadAck` (#15) |
| `src/integrations/gmail/poller.ts` | dynamic alias direction set (#16) |
| `src/integrations/gmail/business-emails.ts` | doc update; keep for QBO filter (#16) |
| `src/db/schema/audit.ts`, `src/db/schema/crm.ts` | declare 4 FKs with prod names (FK drift) |
| `migrations/0042_*.sql` + `meta/` | generated then blanked (FK drift) |
| `scripts/dev/backfill-local-migration-journal.ts` (new, optional) | local journal backfill (env task) |

---

### Task 1: #11 + #17 — surface tax-lookup failures; /process-return fee parity

**Files:** `src/modules/returns/source-invoice-tax.ts`, `src/server/routes/returns.ts` (~:741 caller + the GET tax-status route — grep `getSourceInvoiceTaxStatus` for all callers), RMA credit-memo dialog component (find via the tax-status fetch), `src/modules/returns/credit-memo-builder.ts` (read-only reference: `assertFeeItemConfigured` at :120-130, fee lines :190-227).

- [ ] **Step 1 (test first):** in `source-invoice-tax` tests, add: (a) one doc lookup throws, other succeeds with tax ⇒ `hadTax:true`, `failedDocNumbers:["<failed>"]`; (b) ALL lookups throw ⇒ `hadTax:false`, `failedDocNumbers` lists all. Mock `QboClient.getInvoiceByDocNumber`.
- [ ] **Step 2:** implement — extend the return type:

```ts
export type SourceInvoiceTaxStatus = {
  hadTax: boolean;
  ratePercent: number;
  taxCodeRef: string | null;
  failedDocNumbers: string[]; // lookups that errored (NOT "not found") — tax status may be incomplete
};
```

and in the loop:

```ts
} catch (err) {
  failedDocNumbers.push(docNum);
  log.warn({ rmaId, docNumber: docNum, err }, "source-invoice tax lookup failed");
}
```

(`const log = createLogger({ component: "returns.source-invoice-tax" })` — module currently has no logger.)
- [ ] **Step 3:** callers in `returns.ts`: include `failedDocNumbers` in the tax-status GET response; in `/process-return`, when `failedDocNumbers.length > 0` include it in the route's existing `taxStatusError`-style response surface (don't block).
- [ ] **Step 4:** dialog UI: when the tax-status response has `failedDocNumbers.length > 0 && !hadTax`, render an amber inline warning: `Couldn't verify sales tax for invoice(s) {list} — check QBO before crediting without tax.` (match the existing amber notes style).
- [ ] **Step 5 (#17):** in `/process-return` (routes/returns.ts:586-975): export `assertFeeItemConfigured` from `credit-memo-builder.ts` and call it when any operator-supplied line has a negative `unitPrice` or `amount` AND its `itemId` equals the configured `rma_shipping_fee_item_id`/`rma_restocking_fee_item_id`; also apply the same `lineTaxCode` the route derives for item lines (`anyTaxable` logic at ~:676) to negative fee lines so fees are tax-consistent with the builder path. Add a route-level unit test if the existing test harness covers returns routes; otherwise test the extracted helper.
- [ ] **Step 6:** `npm test` green, typecheck clean. Commit: `fix(returns): surface source-invoice tax lookup failures + process-return fee parity (audit #11/#17)`.

---

### Task 2: #12 — blended chase severity derives overdue from invoices

**Files:** `src/modules/chase/lookups.ts` (:36-72 `getOverdueCustomersBlended`), `src/modules/chase/scoring.ts` (:82-87 denormalized preference; override param already exists — see origin-scoped callers e.g. `chase-next.ts:88-90`), `src/modules/chase/balances.ts` (reuse `computeOriginBalances`).

- [ ] **Step 1 (test first):** lookups/scoring test: customer with `overdueBalance = 2000` (stale denormalized) but invoices Feldart $500/10d + TJ $15000/180d ⇒ blended severity must be computed from **$15,500 @ 180d** (CRITICAL-range score), not $2,000. Also: TJ credits net against the TJ portion (reuse fixtures from the wave-A balances tests).
- [ ] **Step 2:** in `getOverdueCustomersBlended`, after loading the customer's invoices (+ TJ credits, as the origin-scoped paths do), compute `const { feldartOverdue, tjOverdueNet } = computeOriginBalances(...)` (exact helper signature per balances.ts) and pass `rawOverdueOverride: feldartOverdue + tjOverdueNet` into `computeSeverity`, mirroring how `chase-next.ts:88-90` passes origin-scoped overrides. Keep the `overdueBalance > 0` SQL pre-filter for candidate selection but OR it with an open-overdue-invoice EXISTS condition if `buildOpenInvoiceConditions` makes that a one-liner; if not, leave the pre-filter and note it in the commit body.
- [ ] **Step 3:** check other `computeSeverity` call sites (grep) — any caller still relying on the denormalized preference for a *blended* figure gets the same override treatment; origin-scoped callers are already correct.
- [ ] **Step 4:** `npm test` green. Commit: `fix(chase): blended severity computed from invoice set, not denormalized balance (audit #12)`.

---

### Task 3: #13 — atomic Shopify tag mutations

**Files:** `src/integrations/shopify/hold.ts` (:109-146 `addTag`/`removeTag`, :84-104 `setCustomerTags`), `src/integrations/shopify/client.ts` (check for an existing GraphQL helper; add `graphql<T>(query, variables)` if absent — the integration is documented as Admin GraphQL but holds uses REST).

- [ ] **Step 1 (test first):** hold tests: `addTag`/`removeTag` issue a single GraphQL mutation (`tagsAdd`/`tagsRemove`) with the customer GID `gid://shopify/Customer/<id>` and the single tag — assert no full-tag-set write occurs; userErrors in the response throw.
- [ ] **Step 2:** implement:

```ts
const TAGS_ADD = `mutation tagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;
const TAGS_REMOVE = `mutation tagsRemove($id: ID!, $tags: [String!]!) {
  tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
}`;
```

`addTag`/`removeTag` keep their signatures; they call the mutation then `getCustomerTags` (existing REST read) to return fresh `tagsAfter`. Delete `setCustomerTags` if no other caller (grep first); keep `parseTags`. Note in comments: GraphQL tag ops are atomic server-side, eliminating the RMW race (audit #13); needs `write_customers` scope (already granted).
- [ ] **Step 3:** verify the route caller (`src/server/routes/holds.ts`) still compiles unchanged (it consumes `tagsAfter`).
- [ ] **Step 4:** `npm test` green. Commit: `fix(shopify): atomic tagsAdd/tagsRemove for hold flips (audit #13)`.

---

### Task 4: #14 — qty_change preserves baked-in line discounts

**Files:** `src/modules/b2b-invoicing/sender.ts` (:184-200 qty_change; :442 add-line is out of scope — adds have no original Amount).

- [ ] **Step 1 (test first):** sender tests: original line `UnitPrice 100, Qty 10, Amount 850` (discount baked in), qty_change to 8 ⇒ payload line has `Amount 680` (= 85 × 8) and `UnitPrice 85`; non-discounted line (`Amount === UnitPrice×Qty`) keeps exact old behavior; rounding-noise line (≤1¢ delta) treated as non-discounted; `origQty = 0` guarded (falls back to `unitPrice`).
- [ ] **Step 2:** implement in the qty_change branch:

```ts
const origAmount = Number(line.Amount ?? 0);
const origQty = Number(detail.Qty ?? 0);
const listPrice = Number(detail.UnitPrice ?? 0);
const hasBakedDiscount =
  origQty > 0 && Math.abs(origAmount - round2(listPrice * origQty)) > 0.01;
const effRate = hasBakedDiscount ? origAmount / origQty : listPrice;
// ...
UnitPrice: effRate,
Amount: round2(effRate * newQty),
```

(match the branch's actual local names; add a comment that this preserves 3rd-party special pricing the comment at :14-15 describes).
- [ ] **Step 3:** `npm test` green. Commit: `fix(b2b): qty_change preserves baked-in line discounts via effective rate (audit #14)`.

---

### Task 5: #15 — server-side enforcement of the parse-gap verify gate

**Files:** `src/server/routes/invoicing.ts` (send handler ~:750; flagged-remove derivation feeding the row payload ~:1229), `src/web/pages/invoicing-today.tsx` (:1134-1158 gate state, :2346 checkbox; the send mutation payload).

- [ ] **Step 1:** read both sides; extract the flagged-remove/unreadable-rows derivation into a shared helper if it currently lives inline in the GET (server-side only — the UI gets flags from the API already).
- [ ] **Step 2 (test first):** route test (or helper test if no route harness): send body with a flagged `remove` not covered by `verifiedRemoveLineIds` ⇒ 400 with a message naming the SKU(s); `unparsedRows` present and `unreadAck !== true` ⇒ 400; fully covered ⇒ proceeds (mock the QBO send).
- [ ] **Step 3:** server: send handler re-derives flags from the stored source email (same parse the GET used), validates `body.verifiedRemoveLineIds: string[]` + `body.unreadAck: boolean` (zod, default `[]`/`false`), 400s on uncovered flags. Removes that aren't flagged need no verification (matches UI behavior).
- [ ] **Step 4:** web: include `verifiedRemoveLineIds: Array.from(verifiedLineIds)` and `unreadAck` in the send mutation body. No UX change.
- [ ] **Step 5:** `npm test` green, typecheck clean. Commit: `fix(b2b): enforce parse-gap verify gate server-side on send (audit #15)`.

---

### Task 6: #16 — Gmail direction classification from live aliases

**Files:** `src/integrations/gmail/poller.ts` (:122-124 `classifyDirection`, call sites :318 and :566), `src/integrations/gmail/aliases.ts` (:40-67 `listAliases`, already 5-min cached), `src/integrations/gmail/business-emails.ts` (comment update only).

- [ ] **Step 1 (test first):** poller tests: email FROM an alias present in the sendAs list but NOT in `BUSINESS_EMAILS` ⇒ `outbound`; `listAliases` throws ⇒ falls back to `BUSINESS_EMAILS` and classification still works (+ a warn log).
- [ ] **Step 2:** implement:

```ts
async function getOutboundAddressSet(): Promise<Set<string>> {
  const set = new Set(BUSINESS_EMAILS); // hard fallback, always included
  try {
    for (const a of await listAliases()) set.add(a.sendAsEmail.toLowerCase());
  } catch (err) {
    log.warn({ err }, "listAliases failed; direction uses hardcoded fallback only");
  }
  return set;
}
function classifyDirection(email: ParsedEmail, outbound: Set<string>): "inbound" | "outbound" {
  return outbound.has(email.fromEmail.toLowerCase()) ? "outbound" : "inbound";
}
```

Build the set **once per poll cycle** (top of `pollNewEmails` and `syncEmailsForCustomer`) and thread it to both call sites (`listAliases`' own cache makes this cheap). Match `listAliases`' actual return field names. Update the `business-emails.ts` TODO comment: poller now resolved; constant remains for the QBO billing-email filter.
- [ ] **Step 3:** `npm test` green. Commit: `fix(gmail): classify direction from live sendAs aliases (audit #16)`.

---

### Task 7: FK drift — declare the four existing constraints (LAST code task)

**Files:** `src/db/schema/audit.ts` (:145 `chase_log.aiProposalId`), `src/db/schema/crm.ts` (:79 activities, :301 email_log, :344 statement_sends), `migrations/0042_*.sql` + `migrations/meta/` (generated).

Prod constraint names (verified live 2026-06-10): `fk_activities_ai_proposal`, `fk_chase_log_ai_proposal`, `fk_email_log_ai_proposal`, `fk_statement_sends_ai_proposal` — all `FOREIGN KEY (ai_proposal_id) REFERENCES ai_proposals(id) ON DELETE SET NULL ON UPDATE NO ACTION` (from `0036_autopilot.sql:49-52`).

- [ ] **Step 1:** in each of the four tables' extra-config (third arg — match the file's existing style), add e.g.:

```ts
foreignKey({
  name: "fk_chase_log_ai_proposal",
  columns: [t.aiProposalId],
  foreignColumns: [aiProposals.id],
}).onDelete("set null"),
```

Import `foreignKey` from `drizzle-orm/mysql-core` and `aiProposals` from `./ai-proposals.js`. If a circular import appears, switch that table's declaration to the lazy-column form (`() => aiProposals.id`) or move the FK to the table that avoids the cycle — do NOT leave any of the four undeclared.
- [ ] **Step 2:** `npm run db:generate` → inspect `migrations/0042_*.sql`: it must contain exactly the 4 `ADD CONSTRAINT` statements (names matching above) and nothing else. If names differ, fix the schema declarations, delete the generated migration + snapshot, regenerate.
- [ ] **Step 3:** **blank the SQL file** — replace its contents with:

```sql
-- Intentionally empty. The four fk_*_ai_proposal constraints this migration
-- would add already exist in every environment via 0036_autopilot.sql; this
-- migration only syncs drizzle's meta snapshot so `drizzle-kit generate`
-- stops being one keystroke away from dropping them. (audit FK-drift fix)
```

Keep the journal entry and snapshot exactly as generated.
- [ ] **Step 4:** verify: `npm run db:generate` again ⇒ reports no schema changes. `npm run db:migrate` against the LOCAL db (after Task 8's journal backfill) ⇒ applies 0042 as a no-op, exits clean, and `SELECT COUNT(*) FROM __drizzle_migrations` increments.
- [ ] **Step 5:** `npm test` green, typecheck clean. Commit: `fix(db): declare existing ai_proposal_id FKs in schema; no-op migration 0042 (FK drift)`.

---

### Task 8: local migration-journal cleanup (env-only; pairs with T7 Step 4)

**Files:** local DB only. Optionally commit `scripts/dev/backfill-local-migration-journal.ts` if it comes out clean enough to keep.

State (diagnosed 2026-06-10): local `feldart_finance` schema already matches 0041 (origin, dispute_state, credit_memos, customer_ai_cards, ai_customer_context all present) but `__drizzle_migrations` has only 37 rows (last id 37) vs 42 journal entries — rows for 0037–0041 missing because their DDL was applied by hand.

- [ ] **Step 1:** spot-verify the local schema really contains everything 0037–0041 create (list each migration's CREATE/ALTER targets; query information_schema). Any genuinely missing DDL: apply it manually FIRST (tolerate nothing — at this point misses must be fixed, not skipped).
- [ ] **Step 2:** backfill rows — for each journal entry idx 37–41: `INSERT INTO __drizzle_migrations (hash, created_at) VALUES (<sha256 hex of migrations/<tag>.sql file contents>, <journal entry's 'when' millis>)`, in idx order. (Drizzle's mysql migrator applies entries with `when > MAX(created_at)` — correct `created_at` is what matters; hash is bookkeeping.)
- [ ] **Step 3:** `npm run db:migrate` ⇒ exits clean with nothing to apply (before T7) / applies only no-op 0042 (after T7). Update `reference_local-dev-verification.md` memory: journal drift RESOLVED, db:migrate usable again locally.

---

## Verification & ship (after all tasks)

- [ ] Full suite: `npm test` (baseline was 631 passing) + `npm run typecheck` + `npm run build`.
- [ ] Playwright spot-check in the running local app (per `reference_local-dev-verification.md`: DEV_USER_EMAIL bypass, kill stale :3001): RMA credit-memo dialog renders (amber warning only when simulated failure), Today→Orders send still works with the gate, chase list renders, hold flip works against… (Shopify mutation can't be safely exercised locally — rely on tests + types).
- [ ] Independent **Opus review subagent** (two-stage: spec compliance, then code quality). Fix findings.
- [ ] Clean up (.env bypass re-commented, dev servers killed, artifacts removed).
- [ ] Merge to `main`, push, **watch the Deploy run to completion** (re-run on SSH timeout). Deploy runs `db:migrate` on prod ⇒ 0042 no-op must apply clean; verify over `ssh finance-vps` afterwards (`SELECT COUNT(*) FROM __drizzle_migrations`, pm2 status, app responds).
- [ ] Update memories (MEMORY.md current-state line, new reference for the FK-drift resolution if useful).

## Flagged for the operator (not in this batch)

- **Restocking/shipping fee taxability policy:** the 2026-06-01 tax fix stamps fee deduction lines TAX when tax is on (matches the dialog preview math). If restocking fees should be non-taxable, both the dialog and the builder need a deliberate change — decision needed, then a small follow-up.
- Low/cleanup audit tier (LIKE-wildcard escaping, References header threading, float cents drift, syncPayments scaling, SSE cross-user, NaN guards, friendly error states) — still parked in the audit notes.
