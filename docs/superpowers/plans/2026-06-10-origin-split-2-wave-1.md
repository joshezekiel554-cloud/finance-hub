# Origin Split 2.0 — Wave 1 (UI Separation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. Steps use `- [ ]`. **Commit after every task.** Line numbers are post-audit-batch (main `4329f7a`) and approximate — read the code.

**Goal:** Remove every origin mode/toggle; every page shows both books as two separated sections; the TJ wind-down workflow consolidates into a purpose-built panel on /chase; no blended money number remains operator-visible.

**Spec:** `docs/superpowers/specs/2026-06-10-origin-split-2-design.md` (§1, §2, §4, §5)
**Branch:** `feat/origin-split-2` (rebased on main `4329f7a`). Recon 2026-06-10 (2 thorough agents) — anchors below are from it.

## Locked decisions (Wave 1)

- **TJ monthly delta needs history we don't have** → new table `tj_exposure_snapshots (snap_date date PK, exposure decimal(12,2))`, **upserted on every winddown-endpoint read** (self-populating, no cron). Delta = today − latest snapshot dated ≤ today−28d; if none, omit delta (UI hides it). Migration **0043**.
- **Aging buckets:** <90d / 90–180d / >180d overdue, by invoice `dueDate`, net balances (verifying excluded from "actionable" but INCLUDED in exposure + buckets — exposure is money owed regardless of dispute state; the verifying count is shown separately).
- **TJ severity/tier in the panel** reuses `originSeverity`-based `getOverdueCustomersForOrigin("tj")` (lookups.ts:107) — no new scoring.
- **/api/chase/customers** loses its `origin` param and becomes **Feldart-only** (the TJ panel has its own endpoint `GET /api/chase/tj-winddown`).
- **Statement sends: `origin` becomes REQUIRED end-to-end** (spec §5). Today the per-row chase send (chase.tsx:294-300) and the statement-send-dialog POST NO origin and silently blend — that's a live bug this wave fixes. Enforcement flips ON only in T5 after all callers pass it (T2/T4 update their callers first).
- **Customers list TJ strip data** comes from the winddown endpoint (`exposure`, `customerCount`) — no second aggregation. "Show TJ column" preference: `localStorage["customers.showTjColumn"]`.
- **Customer detail rail:** split KPI cards (customer-detail.tsx:1505-1520) are REMOVED (superseded by header pills + panel KPIs). AI card stays blended in Wave 1 (per-book = Wave 2).
- **Pure-TJ customers:** Feldart panel always renders (even $0 — it's the living book); TJ panel hides only when zero TJ balance AND zero TJ overdue AND zero open disputes AND zero open TJ invoices.
- **Shared components** in `src/web/components/book-sections/`: `BookSectionHeader` (dot, title, KPI chips, actions slot, indigo/amber accent) + `TjWinddownPanel` (chase) + customer-detail panels reuse the header.
- **URL params** `chase.origin` and `customers.book` deleted from search schemas (zod `.catch()` already drops unknown values silently).
- **Mobile:** sections stack (block layout); sticky headers keep `top-14 md:top-0`.

## File map

| File | Change |
|---|---|
| `src/db/schema/` + `migrations/0043_*.sql` | + tj_exposure_snapshots (T1) |
| `src/server/routes/chase.ts` | + GET /tj-winddown; /customers loses origin param (T1, T2) |
| `src/modules/chase/winddown.ts` (new) | aggregation: exposure, buckets, delta, rows (T1) |
| `src/web/pages/chase.tsx` | toggle removed; two sections; TJ panel mount (T2) |
| `src/web/components/book-sections/*` (new) | BookSectionHeader, TjWinddownPanel, AgingBar (T2) |
| `src/web/lib/search-schemas/chase.ts` | drop `origin` (T2) |
| `src/web/pages/customers.tsx` + `src/server/routes/customers.ts` | lens removed; TJ strip; on-demand TJ column (T3) |
| `src/web/lib/search-schemas/customers.ts` | drop `book` + `combinedBalance` sort (T3) |
| `src/web/pages/customer-detail.tsx` | header pills; two book panels; rail KPI cards removed (T4) |
| `src/modules/statements/send.ts` + `src/server/routes/statements.ts` + `statement-send-dialog.tsx` + chase batch route | origin required everywhere (T5) |
| `src/server/routes/dashboard.ts` + `src/web/components/dashboard/chase-widget.tsx` | per-book amounts on rows (T6) |

---

### Task 1: TJ wind-down backend — snapshot table + aggregation + endpoint

**Files:** Create `src/modules/chase/winddown.ts` (+ test); modify `src/db/schema/` (new table file or chase-adjacent), generate `migrations/0043_*.sql`; modify `src/server/routes/chase.ts`.

- [ ] **Step 1 (schema):** `tjExposureSnapshots` table: `snapDate date PK`, `exposure decimal(12,2) notNull`. `npm run db:generate` → 0043. Apply locally (`npm run db:migrate` — local journal is clean as of today).
- [ ] **Step 2 (tests first):** `winddown.test.ts` — given fixture invoices/credits/disputes: (a) exposure = Σ net TJ per customer (per-origin credit netting via `computeOriginBalances`, floor 0, verifying INCLUDED); (b) buckets by dueDate age <90/90–180/>180 (net per-invoice balance, bucket by days overdue, due-today = not overdue per startOfDayUtc convention); (c) verifying count = open TJ invoices with disputeState='verifying'; (d) delta null when no snapshot ≥28d old, computed when present; (e) customer rows carry netOwed, openCount, disputeChips[{invoiceId, docNumber, state}], tier (from originSeverity path), suggested level.
- [ ] **Step 3 (module):** `getTjWinddown()` in `src/modules/chase/winddown.ts`: reuse `getOverdueCustomersForOrigin("tj")` (lookups.ts:107) for rows/tiers; one invoice query for buckets + per-invoice dispute data; upsert today's snapshot (`INSERT ... ON DUPLICATE KEY UPDATE exposure`); read delta snapshot. Return `{ exposure, deltaVs28d: number|null, buckets: {b90,b180,bOver}, verifyingCount, customers: [...] }` with per-customer `invoices: [{id, docNumber, balance, dueDate, daysOverdue, disputeState, disputeClaimedAt, disputeNote}]` (panel expands client-side — no second fetch).
- [ ] **Step 4 (route):** `GET /api/chase/tj-winddown` in chase.ts → auth-gated, returns the module result.
- [ ] **Step 5:** tests + typecheck. Commit `feat(chase): TJ wind-down aggregation + exposure snapshots (osplit2 W1 T1)`.

### Task 2: Chase page — two sections, toggle gone

**Files:** Modify `src/web/pages/chase.tsx` (1234 LOC; anchors: ORIGIN_LABELS :115-119, originFilter :127/:136-137, query :176-209, batch :214-245, FilterBar origin chips :751-761, dispute link :560-572, per-row send :287-343); `src/web/lib/search-schemas/chase.ts:10`; `src/server/routes/chase.ts` (:73-77 listQuerySchema origin, :215-246 origin conds). Create `src/web/components/book-sections/book-section-header.tsx`, `aging-bar.tsx`, `tj-winddown-panel.tsx`.

- [ ] **Step 1:** Backend: remove `origin` from listQuerySchema; hard-code the Feldart condition (keep the per-origin netting SQL with origin='feldart'). Preview/send endpoints keep their origin param (TJ panel uses them with origin=tj).
- [ ] **Step 2:** `BookSectionHeader` ({book: 'feldart'|'tj', title, kpis: ReactNode, actions: ReactNode}) — dot + title + chips + actions row, 3px top band indigo/amber (mirror the mockup). `AgingBar` ({buckets}) — stacked flex bar info/amber/danger with title tooltips.
- [ ] **Step 3:** `TjWinddownPanel` — fetches `/api/chase/tj-winddown` (query key ["chase","tj-winddown"]); header KPIs (exposure, delta when non-null, verifying count) + AgingBar + "next" hint (count of customers tier ≥ MEDIUM); customer rows (name → customer link, net owed, open count, dispute chips, TJ chase button reusing the existing per-customer chase send flow with origin=tj) expanding to per-invoice rows that mount the existing `DisputeActions` component (props per dispute-actions.tsx; onEmailBookkeeper opens compose prefilled from app_settings.tj_bookkeeper_email — copy the wiring from customer-detail.tsx:3344-3363); TJ-scoped batch statement button (existing batch endpoint, origin:'tj', selection within the panel); collapses to a single line when exposure=0 && verifyingCount=0 && customers empty → "Torah Judaica wind-down complete — $0 outstanding"; hidden entirely when additionally no rows ever (no TJ invoices at all).
- [ ] **Step 4:** chase.tsx: delete ORIGIN_LABELS/originFilter/setter/FilterBar chips/dispute-link block; wrap the existing table under `<BookSectionHeader book="feldart" …>` with Feldart KPIs (overdue total, account count — compute from rows) + existing batch actions; mount `<TjWinddownPanel/>` below; per-row statement send (:294-300) now posts `{ origin: "feldart" }`. Drop `origin` from search-schemas/chase.ts.
- [ ] **Step 5:** typecheck + existing chase tests green (route tests if any). Commit `feat(chase): two-section chase — Feldart queue + TJ wind-down panel (osplit2 W1 T2)`.

### Task 3: Customers list — Feldart-shaped + TJ strip

**Files:** `src/web/pages/customers.tsx` (anchors: BOOK_LABELS :113-117, book :126/:150-151, col logic :129-133, row type :37-62), `src/server/routes/customers.ts` (:234-242 book filter, :303-328 balance exprs/sorts), `src/web/lib/search-schemas/customers.ts` (:14 book, sort keys :19-20).

- [ ] **Step 1:** Backend: remove `book` query param + its EXISTS filter; keep returning `feldartBalance` + `tjBalance` per row; drop `combinedBalance` expr + sort mapping (keep feldart/tj sorts).
- [ ] **Step 2:** Frontend: delete lens UI + book state; default balance column shows `feldartBalance` (header "Balance" with indigo dot); TJ strip above table (amber, from `/api/chase/tj-winddown`: "N customers carry Torah Judaica exposure ($X)" + `Show TJ column` button toggling localStorage-persisted state) — strip hidden when exposure=0 and no TJ rows; TJ column (amber dot header, dash when 0/no history) + tjBalance sort only when shown; small amber `TJ` chip beside names where `tjBalance > 0` (always, independent of column). Remove `book`+`combinedBalance` from the search schema.
- [ ] **Step 3:** typecheck; adjust any tests referencing book/combined. Commit `feat(customers): Feldart-shaped list + TJ exposure strip + on-demand TJ column (osplit2 W1 T3)`.

### Task 4: Customer detail — header pills + two book panels

**Files:** `src/web/pages/customer-detail.tsx` (3717 LOC; anchors: header balance :403-420, rail :1489-1600 incl. KPI cards :1505-1520, originGroups :2436-2460, group render :2800-2819, OriginChip :3034-3050, DisputeActions mount :3221-3228, bookkeeper compose wiring :3344-3363). Reuse `book-sections/book-section-header.tsx`. KPI data: customers route response already has feldart*/tj* fields (:1060-1179).

- [ ] **Step 1:** Header: replace the blended balance/overdue line with two pills — `Feldart $X · oldest Nd` (indigo; from kpi.feldartBalance/feldartOverdue + oldest), `TJ $Y · M disputes` (amber; kpi.tjBalance + verifying count — add a `tjVerifyingCount` field to the customer KPI query, cheap correlated subquery). TJ pill hidden for no-TJ-history customers.
- [ ] **Step 2:** Replace the origin-grouped single table with two panels in the content column: `FeldartPanel` (BookSectionHeader: KPIs open count/balance/overdue + Chase + Statement(origin:'feldart') actions; invoice table = existing row renderer filtered to feldart) and `TjPanel` (amber tint card; KPIs net/verifying; TJ chase (origin:'tj') + ✉ Bookkeeper actions; invoice rows with the existing inline DisputeActions). Extract the shared invoice-row renderer rather than duplicating it. OriginChip on rows becomes redundant inside panels — remove from row, keep component if used elsewhere.
- [ ] **Step 3:** Rail: delete the two KPI cards (:1505-1520); keep AI card, notes, AI-context, recipients/terms order.
- [ ] **Step 4:** Hide TjPanel per the locked predicate; pure-TJ customers still get FeldartPanel ($0 state).
- [ ] **Step 5:** typecheck; existing tests green. Commit `feat(customer-detail): split header pills + per-book panels (osplit2 W1 T4)`.

### Task 5: Statements — origin required end-to-end

**Files:** `src/modules/statements/send.ts` (:78-100 ManagerInput), `src/server/routes/statements.ts` (sendBodySchema :34, handler :44-98), `src/web/components/statement-send-dialog.tsx` (:230 POST), chase batch route (`src/server/routes/chase.ts` :103-112 schema, :404-405 both→undefined mapping), grep for any other `sendStatement(`/`statement-send` callers.

- [ ] **Step 1:** `sendStatement` input: `origin: "feldart" | "tj"` (required, type-level). Batch body schema: `origin: z.enum(["feldart","tj"])` (required — "both" now rejected 400); delete the both→undefined mapping. statements.ts sendBodySchema gains required `origin`.
- [ ] **Step 2:** Callers: statement-send-dialog gains an `origin` prop (passed by both mounting pages — customer-detail panels pass their book; chase Feldart section passes 'feldart'; TJ panel passes 'tj'); confirm chase per-row send (updated in T2) and batch (already passes) compile against required types. Render/PDF path already supports origin filtering (Wave B) — verify the omitted-origin branch is now unreachable and delete it from send.ts.
- [ ] **Step 3 (tests):** statements tests: required-origin rejection (route 400 on missing/"both"), per-origin filtering unchanged (reuse Wave B fixtures).
- [ ] **Step 4:** typecheck + statements tests. Commit `feat(statements): origin required on every send; blended path removed (osplit2 W1 T5)`.

### Task 6: Dashboard widget — per-book amounts

**Files:** `src/server/routes/dashboard.ts` (:390-471; blendedSeverity already computes per-origin parts — expose them), `src/web/components/dashboard/chase-widget.tsx` (:19-27 row type, render).

- [ ] **Step 1:** Route: row shape gains `feldartOverdue: number`, `tjOverdue: number` (the same `computeOriginBalances` results used inside `blendedSeverity` — refactor `blendedSeverity` to optionally return its per-origin components rather than recomputing). Keep ranking blended.
- [ ] **Step 2:** Widget: replace the single `totalOverdue` with color-keyed amounts — indigo `$X` always; amber `· TJ $Y` only when tjOverdue > 0. No blended number rendered.
- [ ] **Step 3:** typecheck + chase tests green. Commit `feat(dashboard): per-book amounts on chase widget (osplit2 W1 T6)`.

### Task 7: Wave verify + ship

- [ ] Full `npx vitest run` + `npm run typecheck` + `npm run build`.
- [ ] Playwright (DEV_USER_EMAIL flow, kill stale :3001/:5173): /chase (both sections, TJ expand → dispute actions, no toggle), /customers (strip + TJ column toggle + chips), customer detail for a both-books customer + a pure-Feldart one (pills, panels, rail), dashboard widget. Screenshot each; impeccable-level visual sweep (spacing, accents match mockups' intent).
- [ ] Independent Opus wave review (whole wave diff; spec compliance + quality + integration).
- [ ] Fix findings; cleanup (.env, servers, artifacts); update tracker + memory.
- [ ] Merge `feat/origin-split-2` → main, push, **watch Deploy to completion**, prod post-checks over `ssh finance-vps` (migrations count 44, pm2, app 200, spot-check /chase renders).
