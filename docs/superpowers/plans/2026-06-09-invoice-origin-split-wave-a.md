# Invoice Origin Split — Wave A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Commit after every task** (compact-proofing).

**Goal:** Make invoice origin (`feldart` | `tj`) a first-class, stored dimension and separate the two receivable books across chase, customer detail, and the customers list, so Feldart chasing is clean and TJ is its own track.

**Architecture:** Logical split — an `origin` column on `invoices` (seeded from docNumber prefix, never overwritten once manually set) + a new `credit_memos` table carrying origin. Per-origin balances/overdue computed on read from invoices (+ TJ credit netting). Chase becomes origin-scoped with a `Feldart|TJ` toggle; customer detail shows both tracks; customers list shows split balance columns.

**Tech Stack:** Fastify v5 + Drizzle (mysql2), React 18 + TanStack Query/Router + Tailwind v4, drizzle-kit migrations.

**Spec:** `docs/superpowers/specs/2026-06-09-invoice-origin-split-design.md`

**Branch:** `feat/invoice-origin-split` (inline on main working copy).

## Locked decisions (Wave A)

- Enum values lowercase: `feldart` | `tj`.
- `invoices.origin` NOT NULL default `'feldart'`; backfill sets `tj` for `doc_number LIKE '2%'`. `origin_source` NOT NULL default `'prefix'`.
- Invoice classifier: `docNumber.trim().startsWith('2') → 'tj'`, else `'feldart'`.
- Credit-memo classifier (v1, no QBO LinkedTxn available): `feldart` if `qbCreditMemoId` matches a `returns.qboCreditMemoId` **or** docNumber starts `DC`; else by prefix (`2…`→tj, `1…`→feldart); else `needs_review` (origin best-guess `feldart`, `originSource='needs_review'`). Manual override sets `originSource='manual'`.
- Chase per-origin overdue is computed **from invoices** (not the blended `customers.overdueBalance`). The TJ chase figure **nets TJ unapplied credit**.
- Dispute-state schema is Wave B (separate migration).

## File map

| File | Change |
|---|---|
| `src/db/schema/invoices.ts` | + `origin`, `originSource` columns + index |
| `src/db/schema/credit-memos.ts` (new) | new `credit_memos` table |
| `src/db/schema/index.ts` | export credit-memos |
| `migrations/0040_*.sql` | generated + appended backfill |
| `src/modules/invoicing/origin.ts` (new) + test | `originFromDocNumber`, `classifyCreditMemoOrigin` |
| `src/integrations/qb/types.ts` | (no change — confirm CreditMemo shape) |
| `src/integrations/qb/sync.ts` | set origin on invoice upsert (respect manual); populate `credit_memos` |
| `src/integrations/qb/credit-memo-aggregation.ts` + test | add per-origin aggregation |
| `src/modules/chase/balances.ts` (new) + test | per-origin balance/overdue + TJ netting |
| `src/modules/chase/lookups.ts` | `origin` param, invoice-driven overdue |
| `src/modules/chase/scoring.ts` | (unchanged signature; fed filtered invoices) |
| `src/modules/chase/digest.ts` | thread `origin` |
| `src/server/routes/chase.ts` | `origin` query param + filter |
| `src/web/lib/search-schemas/chase.ts` | `origin` enum |
| `src/web/pages/chase.tsx` | Feldart\|TJ toggle |
| `src/server/routes/customers.ts` | per-origin sub-balances (detail + list), `origin` on invoice rows, sort keys |
| `src/web/pages/customer-detail.tsx` | two KPIs + origin-grouped invoices + chips |
| `src/web/pages/customers.tsx` | split balance columns |
| `src/modules/ai-agent/candidates/*` | scope chase candidates to feldart |
| `src/server/routes/origin-review.ts` (new) | sweep: list needs_review + override endpoint |
| `src/web/pages/origin-review.tsx` (new) + nav | one-time sweep UI |

---

### Task 1: Schema — origin columns + credit_memos table + migration

**Files:** Modify `src/db/schema/invoices.ts`; Create `src/db/schema/credit-memos.ts`; Modify `src/db/schema/index.ts`; Generate `migrations/0040_*.sql`.

- [ ] **Step 1:** In `src/db/schema/invoices.ts`, add to the `invoices` table (after `status`):

```ts
origin: mysqlEnum("origin", ["feldart", "tj"]).notNull().default("feldart"),
originSource: mysqlEnum("origin_source", ["prefix", "manual", "needs_review"])
  .notNull()
  .default("prefix"),
```
Add index in the table's index block: `originIdx: index("idx_invoices_origin").on(t.origin),` and a composite `originBalanceIdx: index("idx_invoices_origin_balance").on(t.origin, t.balance),`.

- [ ] **Step 2:** Create `src/db/schema/credit-memos.ts`:

```ts
import { decimal, index, mysqlEnum, mysqlTable, timestamp, varchar, date } from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { invoices } from "./invoices";

export const creditMemos = mysqlTable("credit_memos", {
  id: varchar("id", { length: 24 }).primaryKey(),
  qbCreditMemoId: varchar("qb_credit_memo_id", { length: 64 }).notNull().unique(),
  customerId: varchar("customer_id", { length: 24 })
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  docNumber: varchar("doc_number", { length: 64 }),
  total: decimal("total", { precision: 12, scale: 2 }).notNull().default("0"),
  balance: decimal("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  origin: mysqlEnum("origin", ["feldart", "tj"]).notNull().default("feldart"),
  originSource: mysqlEnum("origin_source", ["auto", "manual", "needs_review"])
    .notNull()
    .default("auto"),
  appliedInvoiceId: varchar("applied_invoice_id", { length: 24 }).references(
    () => invoices.id,
    { onDelete: "set null" },
  ),
  txnDate: date("txn_date"),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  customerIdIdx: index("idx_credit_memos_customer_id").on(t.customerId),
  originIdx: index("idx_credit_memos_origin").on(t.origin),
}));

export type CreditMemo = typeof creditMemos.$inferSelect;
export type NewCreditMemo = typeof creditMemos.$inferInsert;
```

- [ ] **Step 3:** Export from `src/db/schema/index.ts` (add `export * from "./credit-memos";`).

- [ ] **Step 4:** Generate migration: `npm run db:generate`. Verify a new `migrations/0040_*.sql` exists with the ALTER TABLE invoices + CREATE TABLE credit_memos.

- [ ] **Step 5:** Append backfill to the **new** 0040 SQL file (it is unapplied, safe to edit):

```sql
--> statement-breakpoint
UPDATE `invoices` SET `origin` = 'tj' WHERE `doc_number` LIKE '2%';
```

- [ ] **Step 6:** Typecheck: `npx tsc -p tsconfig.json --noEmit`. Expected: clean.

- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(db): invoice origin columns + credit_memos table (wave A)"`.

---

### Task 2: Origin classification module (pure, TDD)

**Files:** Create `src/modules/invoicing/origin.ts`, `src/modules/invoicing/origin.test.ts`.

- [ ] **Step 1:** Write `src/modules/invoicing/origin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { originFromDocNumber, classifyCreditMemoOrigin } from "./origin";

describe("originFromDocNumber", () => {
  it("classifies 2-prefixed as tj", () => expect(originFromDocNumber("20567")).toBe("tj"));
  it("classifies 1-prefixed as feldart", () => expect(originFromDocNumber("10241")).toBe("feldart"));
  it("trims whitespace", () => expect(originFromDocNumber("  20001 ")).toBe("tj"));
  it("defaults feldart for null/empty", () => {
    expect(originFromDocNumber(null)).toBe("feldart");
    expect(originFromDocNumber("")).toBe("feldart");
  });
});

describe("classifyCreditMemoOrigin", () => {
  const feldartIds = new Set(["cm-from-returns"]);
  it("feldart when id is a returns credit memo", () =>
    expect(classifyCreditMemoOrigin({ qbCreditMemoId: "cm-from-returns", docNumber: "2999" }, feldartIds))
      .toEqual({ origin: "feldart", originSource: "auto" }));
  it("feldart when docNumber starts DC", () =>
    expect(classifyCreditMemoOrigin({ qbCreditMemoId: "x", docNumber: "DC00012" }, feldartIds))
      .toEqual({ origin: "feldart", originSource: "auto" }));
  it("tj by prefix 2", () =>
    expect(classifyCreditMemoOrigin({ qbCreditMemoId: "x", docNumber: "20003" }, feldartIds))
      .toEqual({ origin: "tj", originSource: "auto" }));
  it("feldart by prefix 1", () =>
    expect(classifyCreditMemoOrigin({ qbCreditMemoId: "x", docNumber: "10003" }, feldartIds))
      .toEqual({ origin: "feldart", originSource: "auto" }));
  it("needs_review when prefix is ambiguous", () =>
    expect(classifyCreditMemoOrigin({ qbCreditMemoId: "x", docNumber: "C-999" }, feldartIds))
      .toEqual({ origin: "feldart", originSource: "needs_review" }));
});
```

- [ ] **Step 2:** Run `npx vitest run src/modules/invoicing/origin.test.ts` → FAIL (module missing).

- [ ] **Step 3:** Write `src/modules/invoicing/origin.ts`:

```ts
export type InvoiceOrigin = "feldart" | "tj";

export function originFromDocNumber(docNumber: string | null | undefined): InvoiceOrigin {
  return (docNumber ?? "").trim().startsWith("2") ? "tj" : "feldart";
}

export function classifyCreditMemoOrigin(
  cm: { qbCreditMemoId: string; docNumber: string | null | undefined },
  feldartCreditMemoIds: ReadonlySet<string>,
): { origin: InvoiceOrigin; originSource: "auto" | "needs_review" } {
  const doc = (cm.docNumber ?? "").trim();
  if (feldartCreditMemoIds.has(cm.qbCreditMemoId) || doc.toUpperCase().startsWith("DC"))
    return { origin: "feldart", originSource: "auto" };
  if (doc.startsWith("2")) return { origin: "tj", originSource: "auto" };
  if (doc.startsWith("1")) return { origin: "feldart", originSource: "auto" };
  return { origin: "feldart", originSource: "needs_review" };
}
```

- [ ] **Step 4:** Run the test → PASS.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(invoicing): origin classification helpers (wave A)"`.

---

### Task 3: Sync — set invoice origin (respect manual) + populate credit_memos

**Files:** Modify `src/integrations/qb/sync.ts`; `src/integrations/qb/credit-memo-aggregation.ts` (+ test).

Reference: invoice upsert at `sync.ts:385–447`; manual-skip pattern mirrors customer upsert exclusions (`sync.ts:209–237`); credit memo sync `sync.ts:662–696`; per-customer `sync.ts:910–921`.

- [ ] **Step 1:** In `sync.ts`, import `originFromDocNumber, classifyCreditMemoOrigin` from `../../modules/invoicing/origin.js`.

- [ ] **Step 2:** In the invoice upsert: compute `const origin = originFromDocNumber(qboInvoice.DocNumber);`. On INSERT set `origin` and `originSource: "prefix"`. In the ON DUPLICATE KEY UPDATE `set`, include `origin` **only when** the existing row's `originSource !== 'manual'` and `!== 'needs_review'`. Implement by reading the `before` row (already read for drift) and conditionally building the update set (mirror how `paymentTerms` etc. are excluded for customers). Never include `originSource` in the update set (so manual/needs_review stick).

- [ ] **Step 3:** Credit memos: after fetching `QboCreditMemo[]`, build `feldartCreditMemoIds` = set of `returns.qboCreditMemoId` (query `returns` table, non-null). For each memo: resolve `customerId` from `qbCustomerId`; classify origin via `classifyCreditMemoOrigin`; **upsert** into `credit_memos` (insert/ODKU by `qbCreditMemoId`) with docNumber/total/balance/txnDate/origin/originSource/lastSyncedAt — but **do not overwrite** `origin/originSource` when existing `originSource === 'manual'`. Delete (or zero) credit_memos no longer returned (fully applied) — simplest: rows absent from the latest fetch get `balance='0'` (mirror the existing reset-then-set pattern).

- [ ] **Step 4:** Keep `customers.unapplied_credit_balance` aggregation working (blended, back-compat) — unchanged.

- [ ] **Step 5:** In `credit-memo-aggregation.ts`, add `aggregateCreditBalanceByOrigin(memos: {qbCustomerId,balance,origin}[]): Map<string, {feldart:number; tj:number}>` with a test in `credit-memo-aggregation.test.ts` (origin-keyed sums; ignores balance<=0).

- [ ] **Step 6:** Run `npx vitest run src/integrations/qb/credit-memo-aggregation.test.ts` → PASS. Typecheck clean.

- [ ] **Step 7:** Commit: `git add -A && git commit -m "feat(sync): derive invoice origin + populate credit_memos (wave A)"`.

---

### Task 4: Per-origin balances module (TDD)

**Files:** Create `src/modules/chase/balances.ts`, `src/modules/chase/balances.test.ts`.

- [ ] **Step 1:** Test `balances.test.ts`: given a customer's invoices (each `{origin, balance, dueDate, status}`) and per-origin unapplied credit, `computeOriginBalances(invoices, credit)` returns `{ feldart: {balance, overdue}, tj: {balance, overdue} }` where:
  - `balance` = sum of open invoice balances of that origin;
  - `overdue` = sum of open balances past due date of that origin;
  - **TJ** balance/overdue are netted by TJ unapplied credit (floored at 0); Feldart netted by Feldart credit.

Write 3+ cases: feldart-only, tj-only with credit netting (e.g. tj open £180, credit £50 → £130), and mixed; plus a credit-exceeds-balance floor-at-0 case.

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3:** Implement `computeOriginBalances`. Pure function; `overdue` uses `dueDate < today && balance>0`. Net credit off `balance` and `overdue` (overdue netting capped so it never goes negative).

- [ ] **Step 4:** Run → PASS. Typecheck clean.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(chase): per-origin balance computation with credit netting (wave A)"`.

---

### Task 5: Chase lookups + digest origin-scoping

**Files:** Modify `src/modules/chase/lookups.ts`, `src/modules/chase/digest.ts`, `src/modules/chase/index.ts`.

Reference: `getOverdueCustomers()` `lookups.ts:15–52`; `getOverdueForCustomer` `:56–81`; digest `digest.ts`.

- [ ] **Step 1:** Add `origin: InvoiceOrigin` param to `getOverdueCustomers(origin)`. Instead of filtering by the denormalized `customers.overdueBalance`, select customers that have ≥1 open invoice of `origin` (join/EXISTS on invoices). For each, load that origin's open invoices, fetch per-origin unapplied credit (from `credit_memos`), compute overdue via `computeOriginBalances`, and only include customers whose origin overdue > 0. Feed origin-filtered invoices to `computeSeverity`.

- [ ] **Step 2:** Add `origin` to `getOverdueForCustomer(customerId, origin)`.

- [ ] **Step 3:** `digest.ts`: add `origin` to `DailyDigestOptions`, thread to `getOverdueCustomers(origin)`.

- [ ] **Step 4:** Add/extend tests for lookups origin filtering if a test harness exists (`chase.test.ts`); otherwise rely on route-level verification. Typecheck clean.

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(chase): origin-scoped lookups + digest (wave A)"`.

---

### Task 6: Chase route + search schema + page toggle

**Files:** Modify `src/server/routes/chase.ts`, `src/web/lib/search-schemas/chase.ts`, `src/web/pages/chase.tsx`.

Reference: `listQuerySchema` `chase.ts:72`; WHERE `:146–180`; daysOverdue subquery `:199–205`; page filters `chase.tsx:116–196`.

- [ ] **Step 1:** Add `origin: z.enum(["feldart","tj"]).catch("feldart")` to `listQuerySchema` and to `src/web/lib/search-schemas/chase.ts`.

- [ ] **Step 2:** In the `/customers` handler, scope the list to the origin: the customer qualifies if it has open invoices of that origin; `overdueBalance`/`balance`/`daysSinceOldestUnpaid` in the response are computed for that origin (reuse the per-origin computation — either via correlated subqueries filtered by `invoices.origin = :origin` plus TJ credit netting, or by post-filtering using `getOverdueCustomers(origin)`). Keep the response shape; values are now origin-scoped.

- [ ] **Step 3:** In `chase.tsx`, add `originFilter` from search, include in the query key + fetch param, and render a `Feldart | TJ` segmented toggle in the FilterBar (default Feldart). Reuse the existing toggle/segmented styling already used for customerType.

- [ ] **Step 4:** Typecheck clean. (Live verification in Task 12.)

- [ ] **Step 5:** Commit: `git add -A && git commit -m "feat(chase): origin toggle on /chase (wave A)"`.

---

### Task 7: Customer detail route — per-origin sub-balances + invoice origin

**Files:** Modify `src/server/routes/customers.ts`.

Reference: GET `/:id` KPI subqueries `:1012–1061`; GET `/:id/invoices` SELECT `:1351–1370`, DocRow `:1413–1436`, assembly `:1438–1484`.

- [ ] **Step 1:** GET `/:id`: add per-origin sub-balance fields to the response: `feldartBalance, feldartOverdue, feldartOpenCount, tjBalance, tjOverdue, tjOpenCount` (correlated subqueries on invoices grouped by origin; TJ netted by TJ unapplied credit from `credit_memos`). Keep existing blended KPI fields.

- [ ] **Step 2:** GET `/:id/invoices`: add `origin: invoices.origin` to the SELECT; add `origin` to the `DocRow` type and the assembled output (invoices get their origin; credit-memo rows get their `credit_memos.origin`).

- [ ] **Step 3:** Typecheck clean.

- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(api): per-origin sub-balances + invoice origin on customer detail (wave A)"`.

---

### Task 8: Customer detail page — two KPIs + origin-grouped invoices

**Files:** Modify `src/web/pages/customer-detail.tsx`.

Reference: `KpiRailCard` `:1391–1422`, rail `:1426–1465`; `InvoicesPanel`/`InvoiceRow` `:878–894, 2175–2299`.

- [ ] **Step 1:** Render **two** KPI cards in the rail — "Feldart owed" and "TJ owed" — fed from the new route fields (hide the TJ card when `tjBalance === 0 && tjOverdue === 0` to avoid noise for pure-Feldart customers). Keep open-invoice counts per origin.

- [ ] **Step 2:** In the Invoices tab, add `origin` to the `InvoiceRow` type; group rows into a Feldart section and a TJ section (each with a labelled header + subtotal), and render a small origin chip per row (`1·` purple = feldart, `2·` amber = tj). Use existing Badge primitive.

- [ ] **Step 3:** Typecheck clean.

- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(web): two-track KPIs + origin-grouped invoices on customer detail (wave A)"`.

---

### Task 9: Customers list route + page — split balance columns

**Files:** Modify `src/server/routes/customers.ts` (GET `/`), `src/web/pages/customers.tsx`.

Reference: sortCol map `customers.ts:280–289`; SELECT `:357–380`; normalize `:398–415`; table headers `customers.tsx:694–757`, rows `:760–912`.

- [ ] **Step 1:** Route GET `/`: add subquery fields `feldartBalance, tjBalance, feldartOverdueBalance, tjOverdueBalance` (per-origin sums from invoices; TJ netted by TJ credit). Add matching sort keys to `sortCol`. Normalize nulls to `"0.00"`.

- [ ] **Step 2:** Page: add `Feldart` and `TJ` balance columns (SortableTh) after the existing Balance column; render the cells. To manage width, consolidate: replace the single blended "Balance" column with the two origin columns (keep "Overdue" blended), OR keep all three — decide by viewing the table; default to **replacing** blended Balance with Feldart+TJ.

- [ ] **Step 3:** Typecheck clean.

- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat(web): split Feldart/TJ balance columns on customers list (wave A)"`.

---

### Task 10: Autopilot — scope chase candidates to Feldart

**Files:** Modify `src/modules/ai-agent/candidates/chase-next.ts` (+ any cadence candidate that chases on overdue balance).

- [ ] **Step 1:** In the chase-related candidate queries, restrict to `invoices.origin = 'feldart'` (exclude TJ from AI chase proposals). Where candidates use customer-level overdue, switch to the feldart per-origin overdue.

- [ ] **Step 2:** Update/extend the candidate test(s) to assert TJ-only customers produce no chase proposal. Run → PASS. Typecheck clean.

- [ ] **Step 3:** Commit: `git add -A && git commit -m "feat(autopilot): scope chase candidates to Feldart origin (wave A)"`.

---

### Task 11: Origin-review sweep (needs_review credit memos + manual override)

**Files:** Create `src/server/routes/origin-review.ts`; register in `src/server/routes/index.ts`; Create `src/web/pages/origin-review.tsx` + route + a Settings link.

- [ ] **Step 1:** Route: `GET /api/origin-review` returns invoices and credit_memos where `originSource = 'needs_review'` (+ allow listing any for manual reclass). `POST /api/origin-review/override` body `{ kind: 'invoice'|'credit_memo', id, origin }` sets `origin` + `originSource='manual'` and writes an `audit_log` row.

- [ ] **Step 2:** Page: a simple table of needs_review rows with a Feldart/TJ override control per row; invalidates on save. Add a link from Settings (or the customers list) — low-prominence (one-time tool).

- [ ] **Step 3:** Typecheck clean.

- [ ] **Step 4:** Commit: `git add -A && git commit -m "feat: origin-review sweep for ambiguous credit memos (wave A)"`.

---

### Task 12: Verify in running app + review + fix

- [ ] **Step 1:** Apply migration locally: ensure local DB up; `npm run db:migrate` (note local DB may be behind on 0037–0039 per reference_local-dev-verification — apply those first if needed, or `db:push`). Start `dev:server` + `dev:web` (kill stale 3001 first; `.env` has `DEV_USER_EMAIL`).
- [ ] **Step 2:** Playwright: `/chase` toggle flips Feldart/TJ and the list changes; customer detail shows two KPIs + grouped invoices; customers list shows split columns. Screenshot each; clean up screenshots.
- [ ] **Step 3:** Dispatch an independent Opus review subagent over the Wave A diff (correctness: origin never overwrites manual; TJ credit netting; no Feldart/TJ leakage in chase; SQL subquery correctness). Fix findings.
- [ ] **Step 4:** Full typecheck + `npx vitest run` (touched suites). Green.
- [ ] **Step 5:** Commit fixes; merge `feat/invoice-origin-split` → `main`; push; watch the Deploy run to completion (re-run on SSH timeout).
