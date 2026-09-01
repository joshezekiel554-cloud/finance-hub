# Yiddy Roster Sales Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a one-off, self-contained interactive HTML report over the ~119 `yiddy`-tagged customers so the salesman can see order frequency, value, trends, lull causes, and product gaps per store.

**Architecture:** Three-stage pipeline, all under `scripts/`: (1) `yiddy-report-gather.ts` runs ON the prod VPS (dist-import recipe) and dumps one JSON blob — MySQL data via drizzle + QBO SalesReceipts/Items via the QB client; (2) `scripts/yiddy-report/metrics.ts` (pure, unit-tested) + `compute.ts` crunch that blob locally into `report-data.json` and a `notes-input.json` for the AI-sanitized-notes review gate; (3) `render.ts` bakes approved data into `template.html` → final standalone HTML. No app/schema changes; nothing with customer data gets committed.

**Tech Stack:** TypeScript via `tsx`, Drizzle (existing `src/db`), existing `src/integrations/qb/client.ts`, vitest for metric tests, vanilla JS + inline SVG in the HTML template (no external deps).

**Spec:** `docs/superpowers/specs/2026-09-01-yiddy-roster-sales-report-design.md`

---

## Key facts an implementer must know

- **Prod access recipe** (from `reference_vps-ssh-access`): `ssh finance-vps` → `/home/deploy/finance-hub`, which contains `dist/` but **no `src/`**. To run a script that imports `../src/...` there:
  ```bash
  scp scripts/yiddy-report-gather.ts finance-vps:finance-hub/scripts/
  ssh finance-vps "cd finance-hub && sed 's|\.\./src/|../dist/|g' scripts/yiddy-report-gather.ts > scripts/.tmp-yiddy-gather.ts && npx dotenv-cli -e .env.production -- npx tsx scripts/.tmp-yiddy-gather.ts > /tmp/yiddy-gathered.json && rm scripts/.tmp-yiddy-gather.ts scripts/yiddy-report-gather.ts"
  scp finance-vps:/tmp/yiddy-gathered.json scripts/yiddy-report-out/gathered.json
  ssh finance-vps "rm /tmp/yiddy-gathered.json"
  ```
  Therefore the gather script lives FLAT at `scripts/yiddy-report-gather.ts` (imports `../src/...` so the sed rewrite matches) and must log NOTHING to stdout except the final JSON (use `console.error` for progress).
- **QB client:** `qbClient` is exported from `src/integrations/qb/client.ts`; its generic `query`/`queryAll` are `private` (compile-time only — callable at runtime). Single realm (`env.QB_REALM_ID`); Feldart vs TJ is a DocNumber-prefix split (`1…` = feldart, `2…` = tj). Its calls auto-refresh OAuth tokens against the prod DB — which is why gathering runs on the VPS, sharing the app's token store.
- **Voided docs:** local invoices → exclude `status = 'void'`; QBO SalesReceipts → exclude `TotalAmt == 0` (QBO zeroes voided receipts).
- **SR line SKUs:** SalesReceipt lines carry `SalesItemLineDetail.ItemRef.value` (QBO Item id), not a SKU. Fetch `SELECT Id, Name, Sku FROM Item` once and map.
- **"New product" epoch:** the initial catalog sync seeded most `products` rows with one `created_at` burst. Epoch = the earliest calendar day holding ≥ 30% of all product rows; products created ON or BEFORE that day are excluded from "new". "New" = created after epoch AND within the last 6 months.
- **Tests:** `npx vitest run <file>` (bare `npm test` is WATCH — never use it).
- **Nothing containing customer data is committed:** `scripts/yiddy-report-out/` is gitignored in Task 1. Committed: gather/compute/render scripts, metrics + tests, template.
- **Before writing template chart code** (Task 7), the implementer MUST invoke the `dataviz` skill (per its trigger rule) — it governs the bar-chart/sparkline styling.

## Date handling

"Now" is injected, not read from the clock, so tests are deterministic and the report is reproducible: every metrics function takes `genDate: string` (ISO `YYYY-MM-DD`). `compute.ts` defaults it to today but accepts `--gen-date 2026-09-01`. Months are handled as `"YYYY-MM"` strings throughout. Windows:
- **TTM** = the 12 whole months ending with the generation month (inclusive). For genDate 2026-09-01: `2025-10` … `2026-09`.
- **Prior year** = the 12 months before that: `2024-10` … `2025-09`.
- Gather pulls 25 months of documents (`>= 2024-08-01` for genDate 2026-09-01) so both windows plus the season look-back are covered; lifetime first-order date and lifetime order-date list come from a slim all-time query.

---

### Task 1: Scaffold — types, gitignore, directories

**Files:**
- Create: `scripts/yiddy-report/types.ts`
- Modify: `.gitignore` (append)

- [ ] **Step 1: Append the output dir to `.gitignore`**

```
# one-off yiddy report working data (customer data — never commit)
scripts/yiddy-report-out/
```

- [ ] **Step 2: Create `scripts/yiddy-report/types.ts`**

```ts
// Shared shapes for the yiddy-roster report pipeline.
// gather (VPS) → GatheredData JSON → compute → ReportData JSON → render.

export type GatheredDoc = {
  // "inv" rows come from the local invoices table; "sr" rows from the
  // QBO SalesReceipt API. Merged everywhere downstream.
  kind: "inv" | "sr";
  docNumber: string | null;
  date: string; // ISO YYYY-MM-DD
  total: number;
  // invoices: balance>0 && status not paid/void ⇒ open. SRs: always paid.
  open: boolean;
  openBalance: number;
  origin: "feldart" | "tj";
  status: string; // display string: paid | open | overdue | Sales receipt…
  lines: Array<{ sku: string | null; name: string | null; qty: number; lineTotal: number }>;
};

export type GatheredCustomer = {
  id: string;
  displayName: string;
  phone: string | null;
  additionalPhones: Array<{ label: string; number: string }>;
  primaryEmail: string | null;
  contacts: Array<{ name: string | null; email: string | null; role: string | null; phone: string | null }>;
  paymentTerms: string | null;
  holdStatus: "active" | "hold" | "payment_upfront";
  balance: number;
  overdueBalance: number;
  internalNotes: string | null;
  aiCustomerContext: string | null;
  firstOrderDate: string | null; // lifetime min doc date (local invoices only — see caveat in compute)
  lifetimeOrderDates: string[]; // lifetime local-invoice dates, ascending (cadence baseline)
  docs: GatheredDoc[]; // 25-month window, invoices + SRs merged, ascending date
  holdPeriods: Array<{ from: string; to: string | null; reason: string | null }>; // from activities hold_on/hold_off
  orderHoldNotes: Array<{ date: string; reason: string | null; note: string | null }>; // shopify order-hold lifecycle
  creditMemos: Array<{ date: string; total: number }>; // TTM window
};

export type GatheredData = {
  generatedAt: string;
  genDate: string; // YYYY-MM-DD used for all windows
  products: Array<{ sku: string; name: string; b2bPrice: number | null; createdAt: string }>;
  customers: GatheredCustomer[];
};

export type TrendBadge = "growing" | "steady" | "declining" | "dormant";

export type StoreReport = {
  id: string;
  name: string;
  // call-sheet
  phones: Array<{ label: string; number: string }>;
  emails: string[];
  contacts: Array<{ name: string | null; role: string | null; email: string | null; phone: string | null }>;
  paymentTerms: string | null;
  holdStatus: string;
  balance: number;
  overdueBalance: number;
  // headline metrics
  ttmSpend: number;
  priorYearSpend: number;
  yoyPct: number | null; // null when priorYearSpend is 0
  ttmOrders: number;
  priorYearOrders: number;
  daysSinceLastOrder: number | null;
  medianGapDays: number | null;
  trend: TrendBadge;
  seasonFlag: boolean;
  firstOrderDate: string | null;
  bookSplit: { feldart: number; tj: number }; // TTM spend per book
  // chart
  monthly: Array<{ month: string; orders: number; spend: number; held: boolean }>;
  // averages
  aovTtm: number | null;
  aovPriorYear: number | null;
  distinctSkusTtm: number;
  // drill-down
  orders: Array<{ docNumber: string | null; kind: "inv" | "sr"; date: string; total: number; origin: string; status: string }>; // TTM only, desc
  openInvoiceTotal: number;
  topProducts: Array<{ sku: string; name: string | null; value: number }>; // top 5 by TTM value
  newProductsTaken: Array<{ sku: string; name: string }>;
  newProductsNotTaken: Array<{ sku: string; name: string }>;
  popularGaps: Array<{ sku: string; name: string; storesBuying: number }>; // top 10
  returns: { count: number; value: number };
  holdPeriods: Array<{ from: string; to: string | null; reason: string | null }>;
  note: string | null; // sanitized, injected at render time
};

export type ReportData = {
  genDate: string;
  generatedAt: string;
  rosterCount: number;
  totals: {
    ttmSpend: number;
    priorYearSpend: number;
    ttmOrders: number;
    trendCounts: Record<TrendBadge, number>;
  };
  winBack: Array<{ id: string; name: string; priorSpend: number; daysSinceLastOrder: number | null; trend: TrendBadge }>;
  seasonFlags: Array<{ id: string; name: string; lastYearSeasonSpend: number }>;
  stores: StoreReport[];
};
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore scripts/yiddy-report/types.ts
git commit -m "chore(yiddy-report): scaffold types + gitignore working dir"
```

---

### Task 2: Metrics — month bucketing, windows, YoY

**Files:**
- Create: `scripts/yiddy-report/metrics.ts`
- Create: `scripts/yiddy-report/metrics.test.ts`

All metrics functions are pure and take `genDate` explicitly. Docs passed in are assumed already filtered of voids (gather's job).

- [ ] **Step 1: Write failing tests for window helpers + monthly bucketing**

```ts
// scripts/yiddy-report/metrics.test.ts
import { describe, expect, test } from "vitest";
import {
  ttmMonths,
  priorYearMonths,
  monthOf,
  bucketMonthly,
  windowTotals,
} from "./metrics";
import type { GatheredDoc } from "./types";

const doc = (date: string, total: number, kind: "inv" | "sr" = "inv"): GatheredDoc => ({
  kind,
  docNumber: "1001",
  date,
  total,
  open: false,
  openBalance: 0,
  origin: "feldart",
  status: "paid",
  lines: [],
});

describe("windows", () => {
  test("ttmMonths ends with the generation month, 12 entries", () => {
    const m = ttmMonths("2026-09-01");
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2025-10");
    expect(m[11]).toBe("2026-09");
  });

  test("priorYearMonths is the 12 months before TTM", () => {
    const m = priorYearMonths("2026-09-01");
    expect(m[0]).toBe("2024-10");
    expect(m[11]).toBe("2025-09");
  });

  test("monthOf extracts YYYY-MM", () => {
    expect(monthOf("2026-01-15")).toBe("2026-01");
  });
});

describe("bucketMonthly", () => {
  test("buckets orders and spend per TTM month, zero-filling empty months", () => {
    const docs = [doc("2026-09-05", 100), doc("2026-09-20", 50), doc("2025-10-01", 25), doc("2024-01-01", 999)];
    const rows = bucketMonthly(docs, "2026-09-01");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ month: "2025-10", orders: 1, spend: 25 });
    expect(rows[11]).toEqual({ month: "2026-09", orders: 2, spend: 150 });
    expect(rows[5].orders).toBe(0); // zero-filled
  });
});

describe("windowTotals", () => {
  test("sums spend/orders inside a month set only", () => {
    const docs = [doc("2026-09-05", 100), doc("2024-11-01", 40), doc("2023-01-01", 7)];
    expect(windowTotals(docs, ttmMonths("2026-09-01"))).toEqual({ spend: 100, orders: 1 });
    expect(windowTotals(docs, priorYearMonths("2026-09-01"))).toEqual({ spend: 40, orders: 1 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: FAIL — `metrics.ts` does not exist / exports missing.

- [ ] **Step 3: Implement in `scripts/yiddy-report/metrics.ts`**

```ts
import type { GatheredDoc } from "./types";

export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

// n months ending with (and including) the month of genDate, ascending.
const monthsEnding = (genDate: string, n: number, endOffset = 0): string[] => {
  const [y, m] = genDate.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1 + endOffset; i >= endOffset; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
};

export const ttmMonths = (genDate: string): string[] => monthsEnding(genDate, 12);
export const priorYearMonths = (genDate: string): string[] => monthsEnding(genDate, 12, 12);

export function bucketMonthly(
  docs: GatheredDoc[],
  genDate: string,
): Array<{ month: string; orders: number; spend: number }> {
  const months = ttmMonths(genDate);
  const map = new Map(months.map((m) => [m, { month: m, orders: 0, spend: 0 }]));
  for (const d of docs) {
    const row = map.get(monthOf(d.date));
    if (!row) continue;
    row.orders += 1;
    row.spend += d.total;
  }
  return months.map((m) => map.get(m)!);
}

export function windowTotals(
  docs: GatheredDoc[],
  months: string[],
): { spend: number; orders: number } {
  const set = new Set(months);
  let spend = 0;
  let orders = 0;
  for (const d of docs) {
    if (!set.has(monthOf(d.date))) continue;
    spend += d.total;
    orders += 1;
  }
  return { spend, orders };
}
```

- [ ] **Step 4: Run tests — all pass**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/yiddy-report/metrics.ts scripts/yiddy-report/metrics.test.ts
git commit -m "feat(yiddy-report): month windows, bucketing, window totals (TDD)"
```

---

### Task 3: Metrics — cadence, trend badge, season flag

**Files:**
- Modify: `scripts/yiddy-report/metrics.ts`
- Modify: `scripts/yiddy-report/metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// append to metrics.test.ts
import { medianGapDays, daysBetween, trendBadge, seasonFlag } from "./metrics";

describe("cadence", () => {
  test("medianGapDays over sorted dates", () => {
    // gaps: 10, 20, 30 → median 20
    expect(medianGapDays(["2026-01-01", "2026-01-11", "2026-01-31", "2026-03-02"])).toBe(20);
  });
  test("null with fewer than 3 orders (no meaningful cadence)", () => {
    expect(medianGapDays(["2026-01-01", "2026-02-01"])).toBeNull();
    expect(medianGapDays([])).toBeNull();
  });
});

describe("trendBadge", () => {
  // signature: trendBadge({ t90Spend, prior90Spend, daysSinceLastOrder, medianGap })
  test("dormant when gap exceeds max(90, 2x median gap)", () => {
    expect(trendBadge({ t90Spend: 0, prior90Spend: 500, daysSinceLastOrder: 120, medianGap: 30 })).toBe("dormant");
    expect(trendBadge({ t90Spend: 0, prior90Spend: 500, daysSinceLastOrder: 100, medianGap: 60 })).toBe("declining"); // 100 < 120 → not dormant, but t90 < 0.7x prior
  });
  test("never ordered → dormant", () => {
    expect(trendBadge({ t90Spend: 0, prior90Spend: 0, daysSinceLastOrder: null, medianGap: null })).toBe("dormant");
  });
  test("growing at >= 1.15x prior 90d spend", () => {
    expect(trendBadge({ t90Spend: 1200, prior90Spend: 1000, daysSinceLastOrder: 5, medianGap: 20 })).toBe("growing");
  });
  test("declining at <= 0.7x, steady in between", () => {
    expect(trendBadge({ t90Spend: 600, prior90Spend: 1000, daysSinceLastOrder: 10, medianGap: 20 })).toBe("declining");
    expect(trendBadge({ t90Spend: 950, prior90Spend: 1000, daysSinceLastOrder: 10, medianGap: 20 })).toBe("steady");
  });
  test("prior 90d empty but ordering now → growing", () => {
    expect(trendBadge({ t90Spend: 400, prior90Spend: 0, daysSinceLastOrder: 12, medianGap: null })).toBe("growing");
  });
});

describe("seasonFlag", () => {
  // season window = generation month ±1, compared year-on-year
  test("flags when last year's Aug-Oct had orders and this year's has none", () => {
    const docs = [doc("2025-09-10", 300)];
    expect(seasonFlag(docs, "2026-09-01")).toEqual({ flagged: true, lastYearSeasonSpend: 300 });
  });
  test("not flagged when this season already ordered", () => {
    const docs = [doc("2025-09-10", 300), doc("2026-08-20", 100)];
    expect(seasonFlag(docs, "2026-09-01").flagged).toBe(false);
  });
  test("not flagged when last year had no season orders", () => {
    expect(seasonFlag([doc("2025-02-01", 50)], "2026-09-01").flagged).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

```ts
// append to metrics.ts
import type { TrendBadge } from "./types";

export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function medianGapDays(sortedDates: string[]): number | null {
  if (sortedDates.length < 3) return null;
  const gaps = sortedDates.slice(1).map((d, i) => daysBetween(sortedDates[i], d));
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

export function trendBadge(args: {
  t90Spend: number;
  prior90Spend: number;
  daysSinceLastOrder: number | null;
  medianGap: number | null;
}): TrendBadge {
  const { t90Spend, prior90Spend, daysSinceLastOrder, medianGap } = args;
  if (daysSinceLastOrder === null) return "dormant";
  const dormantThreshold = Math.max(90, medianGap !== null ? 2 * medianGap : 0);
  if (daysSinceLastOrder > dormantThreshold) return "dormant";
  if (prior90Spend === 0) return t90Spend > 0 ? "growing" : "steady";
  const ratio = t90Spend / prior90Spend;
  if (ratio >= 1.15) return "growing";
  if (ratio <= 0.7) return "declining";
  return "steady";
}

// Season window: generation month ±1. Compares that 3-month set this
// year vs the same months last year.
export function seasonFlag(
  docs: GatheredDoc[],
  genDate: string,
): { flagged: boolean; lastYearSeasonSpend: number } {
  const thisSeason = new Set(monthsEnding(genDate, 3, -1)); // prev, current, next month
  const lastSeason = new Set([...thisSeason].map((m) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`));
  let lastYearSeasonSpend = 0;
  let thisYearHas = false;
  for (const d of docs) {
    const m = monthOf(d.date);
    if (lastSeason.has(m)) lastYearSeasonSpend += d.total;
    if (thisSeason.has(m)) thisYearHas = true;
  }
  return { flagged: lastYearSeasonSpend > 0 && !thisYearHas, lastYearSeasonSpend };
}
```

Note: `monthsEnding` needs `endOffset` to accept negatives (next month). The Task 2 implementation already supports this (offset simply shifts the range); verify the loop bounds handle `endOffset = -1` — `for (let i = n - 1 + endOffset; i >= endOffset; i--)` with n=3, endOffset=-1 yields offsets 1..-1 → prev/current/next month. Add a quick test if unsure:

```ts
test("season window is prev/current/next month", () => {
  const docsNext = [doc("2025-10-05", 10)]; // Oct = next month relative to Sep genDate
  expect(seasonFlag(docsNext, "2026-09-01").lastYearSeasonSpend).toBe(10);
});
```

- [ ] **Step 4: Run tests — all pass**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/yiddy-report/metrics.ts scripts/yiddy-report/metrics.test.ts
git commit -m "feat(yiddy-report): cadence, trend badge, season flag (TDD)"
```

---

### Task 4: Metrics — catalog: new-product epoch/adoption, popular gaps, top products

**Files:**
- Modify: `scripts/yiddy-report/metrics.ts`
- Modify: `scripts/yiddy-report/metrics.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// append to metrics.test.ts
import { catalogEpoch, newProducts, purchasedSkus, popularGaps, topProducts } from "./metrics";

const prod = (sku: string, createdAt: string) => ({ sku, name: sku, b2bPrice: null, createdAt });

describe("catalogEpoch + newProducts", () => {
  const products = [
    // 3 of 5 rows share the initial-sync burst day (>= 30%)
    prod("A", "2025-01-15"), prod("B", "2025-01-15"), prod("C", "2025-01-15"),
    prod("D", "2026-05-01"), prod("E", "2026-08-01"),
  ];
  test("epoch = earliest day holding >= 30% of rows", () => {
    expect(catalogEpoch(products)).toBe("2025-01-15");
  });
  test("new = after epoch AND within 6 months of genDate", () => {
    const n = newProducts(products, "2026-09-01");
    expect(n.map((p) => p.sku)).toEqual(["D", "E"]); // 2026-03-01 cutoff
  });
});

describe("purchase analysis", () => {
  const docsFor = (skus: string[]): GatheredDoc[] => [
    { ...doc("2026-06-01", 100), lines: skus.map((s) => ({ sku: s, name: s, qty: 1, lineTotal: 50 })) },
  ];
  test("purchasedSkus collects line skus, skipping nulls", () => {
    const d = docsFor(["A", "B"]);
    d[0].lines.push({ sku: null, name: "freight", qty: 1, lineTotal: 5 });
    expect(purchasedSkus(d)).toEqual(new Set(["A", "B"]));
  });
  test("popularGaps ranks by breadth across stores, excludes own skus, caps at 10", () => {
    const stores = new Map<string, Set<string>>([
      ["s1", new Set(["A", "B"])],
      ["s2", new Set(["A"])],
      ["s3", new Set(["A", "B", "C"])],
    ]);
    const names = new Map([["A", "Prod A"], ["B", "Prod B"], ["C", "Prod C"]]);
    const gaps = popularGaps("s2", stores, names);
    expect(gaps[0]).toEqual({ sku: "B", name: "Prod B", storesBuying: 2 });
    expect(gaps.map((g) => g.sku)).not.toContain("A"); // s2 already buys A
  });
  test("topProducts sums line value per sku, top 5 desc", () => {
    const d: GatheredDoc[] = [
      { ...doc("2026-06-01", 0), lines: [
        { sku: "A", name: "Prod A", qty: 1, lineTotal: 30 },
        { sku: "B", name: "Prod B", qty: 1, lineTotal: 70 },
        { sku: "A", name: "Prod A", qty: 2, lineTotal: 60 },
      ]},
    ];
    expect(topProducts(d)).toEqual([
      { sku: "A", name: "Prod A", value: 90 },
      { sku: "B", name: "Prod B", value: 70 },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement**

```ts
// append to metrics.ts
type ProductRow = { sku: string; name: string; b2bPrice: number | null; createdAt: string };

export function catalogEpoch(products: ProductRow[]): string | null {
  if (products.length === 0) return null;
  const byDay = new Map<string, number>();
  for (const p of products) {
    const day = p.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [day, count] of days) {
    if (count / products.length >= 0.3) return day;
  }
  return days[0][0]; // no burst day — treat earliest as epoch
}

export function newProducts(products: ProductRow[], genDate: string): ProductRow[] {
  const epoch = catalogEpoch(products);
  const [y, m, d] = genDate.split("-").map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1 - 6, d)).toISOString().slice(0, 10);
  return products
    .filter((p) => {
      const day = p.createdAt.slice(0, 10);
      return (epoch === null || day > epoch) && day >= cutoff;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function purchasedSkus(docs: GatheredDoc[]): Set<string> {
  const set = new Set<string>();
  for (const d of docs) for (const l of d.lines) if (l.sku) set.add(l.sku);
  return set;
}

export function popularGaps(
  storeId: string,
  purchasedByStore: Map<string, Set<string>>,
  skuNames: Map<string, string>,
  cap = 10,
): Array<{ sku: string; name: string; storesBuying: number }> {
  const breadth = new Map<string, number>();
  for (const [sid, skus] of purchasedByStore) {
    if (sid === storeId) continue;
    for (const sku of skus) breadth.set(sku, (breadth.get(sku) ?? 0) + 1);
  }
  const own = purchasedByStore.get(storeId) ?? new Set();
  return [...breadth.entries()]
    .filter(([sku]) => !own.has(sku))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([sku, storesBuying]) => ({ sku, name: skuNames.get(sku) ?? sku, storesBuying }));
}

export function topProducts(
  docs: GatheredDoc[],
  cap = 5,
): Array<{ sku: string; name: string | null; value: number }> {
  const bySku = new Map<string, { name: string | null; value: number }>();
  for (const d of docs) for (const l of d.lines) {
    if (!l.sku) continue;
    const cur = bySku.get(l.sku) ?? { name: l.name, value: 0 };
    cur.value += l.lineTotal;
    bySku.set(l.sku, cur);
  }
  return [...bySku.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, cap)
    .map(([sku, v]) => ({ sku, name: v.name, value: v.value }));
}
```

- [ ] **Step 4: Run FULL suite to catch regressions**

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts`
Expected: PASS (all tasks' tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/yiddy-report/metrics.ts scripts/yiddy-report/metrics.test.ts
git commit -m "feat(yiddy-report): catalog metrics — new products, popular gaps, top products (TDD)"
```

---

### Task 5: Gather script (runs on VPS)

**Files:**
- Create: `scripts/yiddy-report-gather.ts` (FLAT in scripts/ — the sed recipe rewrites `../src/` → `../dist/`)

No unit tests (integration script); correctness is verified by the sanity checks in Task 6. Keep ALL stdout clean — JSON only; progress via `console.error`.

- [ ] **Step 1: Write `scripts/yiddy-report-gather.ts`**

```ts
// One-off gatherer for the yiddy-roster sales report. READ-ONLY.
// Run ON THE VPS via the dist-import recipe (see plan header).
// Emits one GatheredData JSON blob on stdout.
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { qbClient } from "../src/integrations/qb/client.js";

const GEN_DATE = process.env.GEN_DATE ?? new Date().toISOString().slice(0, 10);
const [gy, gm] = GEN_DATE.split("-").map(Number);
const windowStart = new Date(Date.UTC(gy, gm - 1 - 25, 1)).toISOString().slice(0, 10);

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string => new Date(v as string).toISOString().slice(0, 10);

async function main() {
  // ---- roster ----
  const roster = (await db.execute(sql`
    SELECT id, display_name, phone, additional_phones, primary_email,
           payment_terms, hold_status, balance, overdue_balance,
           internal_notes, ai_customer_context
    FROM customers
    WHERE JSON_CONTAINS(tags, '"yiddy"')
    ORDER BY display_name
  `))[0] as unknown as Array<Record<string, unknown>>;
  console.error(`roster: ${roster.length} customers`);
  const ids = roster.map((r) => String(r.id));
  const inList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

  // ---- contacts ----
  const contacts = (await db.execute(sql`
    SELECT customer_id, name, email, role, phone FROM customer_contacts
    WHERE customer_id IN (${inList})
  `))[0] as unknown as Array<Record<string, unknown>>;

  // ---- lifetime invoice dates (cadence + first order) ----
  const lifetime = (await db.execute(sql`
    SELECT customer_id, issue_date FROM invoices
    WHERE customer_id IN (${inList}) AND status != 'void' AND issue_date IS NOT NULL
    ORDER BY issue_date
  `))[0] as unknown as Array<Record<string, unknown>>;

  // ---- windowed invoices + lines ----
  const invRows = (await db.execute(sql`
    SELECT id, customer_id, doc_number, issue_date, total, balance, status, origin
    FROM invoices
    WHERE customer_id IN (${inList}) AND status != 'void'
      AND issue_date >= ${windowStart}
  `))[0] as unknown as Array<Record<string, unknown>>;
  const invIds = invRows.map((r) => String(r.id));
  let lineRows: Array<Record<string, unknown>> = [];
  if (invIds.length > 0) {
    const invIn = sql.join(invIds.map((id) => sql`${id}`), sql`, `);
    lineRows = (await db.execute(sql`
      SELECT invoice_id, sku, description, qty, line_total FROM invoice_lines
      WHERE invoice_id IN (${invIn})
    `))[0] as unknown as Array<Record<string, unknown>>;
  }
  console.error(`invoices: ${invRows.length}, lines: ${lineRows.length}`);

  // ---- hold history (customer-level) + shopify order-hold notes ----
  const holdActs = (await db.execute(sql`
    SELECT customer_id, kind, occurred_at, meta FROM activities
    WHERE customer_id IN (${inList}) AND kind IN ('hold_on','hold_off')
    ORDER BY occurred_at
  `))[0] as unknown as Array<Record<string, unknown>>;
  const orderHolds = (await db.execute(sql`
    SELECT customer_id, hold_started_at, hold_reason, hold_note FROM orders
    WHERE customer_id IN (${inList}) AND hold_state != 'none'
      AND hold_started_at IS NOT NULL AND hold_started_at >= ${windowStart}
  `))[0] as unknown as Array<Record<string, unknown>>;

  // ---- credit memos (TTM approximated by window start; compute filters exactly) ----
  const cms = (await db.execute(sql`
    SELECT customer_id, txn_date, total FROM credit_memos
    WHERE customer_id IN (${inList}) AND txn_date >= ${windowStart}
  `))[0] as unknown as Array<Record<string, unknown>>;

  // ---- products ----
  const prodRows = (await db.execute(sql`
    SELECT sku, name, b2b_price_gbp, created_at FROM products
  `))[0] as unknown as Array<Record<string, unknown>>;

  // ---- QBO: item map + sales receipts ----
  // query/queryAll are private on the client class — compile-time only;
  // reach them at runtime for this one-off read.
  const q = qbClient as unknown as {
    queryAll<T>(
      sfw: string,
      ex: (r: { QueryResponse: Record<string, T[] | undefined> }) => T[] | undefined,
    ): Promise<T[]>;
  };
  type QboItemSlim = { Id: string; Name?: string; Sku?: string };
  const items = await q.queryAll<QboItemSlim>(
    "SELECT Id, Name, Sku FROM Item",
    (r) => r.QueryResponse.Item,
  );
  const itemMap = new Map(items.map((i) => [i.Id, { sku: i.Sku ?? null, name: i.Name ?? null }]));
  console.error(`qbo items: ${items.length}`);

  type QboSrSlim = {
    Id: string;
    DocNumber?: string;
    TxnDate: string;
    TotalAmt: number;
    CustomerRef?: { value: string };
    Line?: Array<{
      Amount?: number;
      SalesItemLineDetail?: { ItemRef?: { value: string; name?: string }; Qty?: number };
    }>;
  };
  const srs = await q.queryAll<QboSrSlim>(
    `SELECT * FROM SalesReceipt WHERE TxnDate >= '${windowStart}'`,
    (r) => r.QueryResponse.SalesReceipt,
  );
  console.error(`qbo sales receipts (all customers, windowed): ${srs.length}`);

  // Map QBO customer id → finance customer id for roster members.
  const qbMapRows = (await db.execute(sql`
    SELECT id, qb_customer_id FROM customers WHERE id IN (${inList})
  `))[0] as unknown as Array<Record<string, unknown>>;
  const qbToLocal = new Map(qbMapRows.map((r) => [String(r.qb_customer_id), String(r.id)]));

  // ---- assemble per-customer ----
  const linesByInv = new Map<string, Array<{ sku: string | null; name: string | null; qty: number; lineTotal: number }>>();
  for (const l of lineRows) {
    const arr = linesByInv.get(String(l.invoice_id)) ?? [];
    arr.push({
      sku: l.sku ? String(l.sku) : null,
      name: l.description ? String(l.description) : null,
      qty: num(l.qty),
      lineTotal: num(l.line_total),
    });
    linesByInv.set(String(l.invoice_id), arr);
  }

  const customers = roster.map((r) => {
    const id = String(r.id);
    const myInvs = invRows.filter((i) => String(i.customer_id) === id).map((i) => {
      const open = num(i.balance) > 0 && !["paid", "void"].includes(String(i.status));
      return {
        kind: "inv" as const,
        docNumber: i.doc_number ? String(i.doc_number) : null,
        date: iso(i.issue_date),
        total: num(i.total),
        open,
        openBalance: open ? num(i.balance) : 0,
        origin: String(i.origin) as "feldart" | "tj",
        status: String(i.status ?? "sent"),
        lines: linesByInv.get(String(i.id)) ?? [],
      };
    });
    const mySrs = srs
      .filter((s) => s.CustomerRef && qbToLocal.get(s.CustomerRef.value) === id)
      .filter((s) => s.TotalAmt !== 0) // voided SRs are zeroed
      .map((s) => ({
        kind: "sr" as const,
        docNumber: s.DocNumber ?? null,
        date: s.TxnDate,
        total: s.TotalAmt,
        open: false,
        openBalance: 0,
        origin: (s.DocNumber?.startsWith("2") ? "tj" : "feldart") as "feldart" | "tj",
        status: "paid",
        lines: (s.Line ?? [])
          .filter((l) => l.SalesItemLineDetail?.ItemRef)
          .map((l) => {
            const ref = l.SalesItemLineDetail!.ItemRef!;
            const item = itemMap.get(ref.value);
            return {
              sku: item?.sku ?? null,
              name: item?.name ?? ref.name ?? null,
              qty: l.SalesItemLineDetail?.Qty ?? 0,
              lineTotal: l.Amount ?? 0,
            };
          }),
      }));
    const docs = [...myInvs, ...mySrs].sort((a, b) => a.date.localeCompare(b.date));

    // hold periods: pair hold_on with the next hold_off
    const myActs = holdActs.filter((a) => String(a.customer_id) === id);
    const holdPeriods: Array<{ from: string; to: string | null; reason: string | null }> = [];
    for (const a of myActs) {
      if (String(a.kind) === "hold_on") {
        const meta = a.meta as Record<string, unknown> | null;
        holdPeriods.push({ from: iso(a.occurred_at), to: null, reason: meta?.reason ? String(meta.reason) : null });
      } else if (holdPeriods.length > 0 && holdPeriods[holdPeriods.length - 1].to === null) {
        holdPeriods[holdPeriods.length - 1].to = iso(a.occurred_at);
      }
    }

    const myLifetime = lifetime.filter((l) => String(l.customer_id) === id).map((l) => iso(l.issue_date));

    return {
      id,
      displayName: String(r.display_name),
      phone: r.phone ? String(r.phone) : null,
      additionalPhones: (r.additional_phones as Array<{ label: string; number: string }> | null) ?? [],
      primaryEmail: r.primary_email ? String(r.primary_email) : null,
      contacts: contacts
        .filter((c) => String(c.customer_id) === id)
        .map((c) => ({
          name: c.name ? String(c.name) : null,
          email: c.email ? String(c.email) : null,
          role: c.role ? String(c.role) : null,
          phone: c.phone ? String(c.phone) : null,
        })),
      paymentTerms: r.payment_terms ? String(r.payment_terms) : null,
      holdStatus: String(r.hold_status) as "active" | "hold" | "payment_upfront",
      balance: num(r.balance),
      overdueBalance: num(r.overdue_balance),
      internalNotes: r.internal_notes ? String(r.internal_notes) : null,
      aiCustomerContext: r.ai_customer_context ? String(r.ai_customer_context) : null,
      firstOrderDate: myLifetime[0] ?? null,
      lifetimeOrderDates: myLifetime,
      docs,
      holdPeriods,
      orderHoldNotes: orderHolds
        .filter((o) => String(o.customer_id) === id)
        .map((o) => ({
          date: iso(o.hold_started_at),
          reason: o.hold_reason ? String(o.hold_reason) : null,
          note: o.hold_note ? String(o.hold_note) : null,
        })),
      creditMemos: cms
        .filter((c) => String(c.customer_id) === id)
        .map((c) => ({ date: iso(c.txn_date), total: num(c.total) })),
    };
  });

  const out = {
    generatedAt: new Date().toISOString(),
    genDate: GEN_DATE,
    products: prodRows.map((p) => ({
      sku: String(p.sku),
      name: String(p.name),
      b2bPrice: p.b2b_price_gbp === null ? null : num(p.b2b_price_gbp),
      createdAt: new Date(p.created_at as string).toISOString(),
    })),
    customers,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Implementation notes:
- Check how `db.execute` returns rows for this mysql2/drizzle version — existing scripts (e.g. `scripts/tag-yiddy-roster.ts`) show the working pattern; match it (the `[0]` destructure above assumes mysql2 tuple shape — adjust to whatever `tag-yiddy-roster.ts` actually does).
- Lifetime cadence baseline comes from local invoices only; for prepay stores (SR-only) `compute.ts` falls back to windowed docs dates (Task 6). This is the documented caveat: cadence for SR-heavy stores reflects the 25-month window, not lifetime.
- The SR pull is all-customers-in-window then filtered to roster via `CustomerRef` — one paginated query beats 119 per-customer queries.

- [ ] **Step 2: Typecheck locally**

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's typecheck script if one exists — check `package.json`)
Expected: no NEW errors from `scripts/yiddy-report-gather.ts`.

- [ ] **Step 3: Commit**

```bash
git add scripts/yiddy-report-gather.ts
git commit -m "feat(yiddy-report): VPS gather script (read-only MySQL + QBO SR pull)"
```

- [ ] **Step 4: Run on VPS and retrieve**

```bash
mkdir -p scripts/yiddy-report-out
scp scripts/yiddy-report-gather.ts finance-vps:finance-hub/scripts/
ssh finance-vps "cd finance-hub && sed 's|\.\./src/|../dist/|g' scripts/yiddy-report-gather.ts > scripts/.tmp-yiddy-gather.ts && GEN_DATE=2026-09-01 npx dotenv-cli -e .env.production -- npx tsx scripts/.tmp-yiddy-gather.ts > /tmp/yiddy-gathered.json && rm scripts/.tmp-yiddy-gather.ts scripts/yiddy-report-gather.ts"
scp finance-vps:/tmp/yiddy-gathered.json scripts/yiddy-report-out/gathered.json
ssh finance-vps "rm /tmp/yiddy-gathered.json"
```

Expected stderr: roster ≈ 119 customers; non-zero invoice/SR/item counts.

- [ ] **Step 5: Sanity-check the blob**

```bash
node -e "const d=require('./scripts/yiddy-report-out/gathered.json'); console.log('customers',d.customers.length,'products',d.products.length,'docs',d.customers.reduce((a,c)=>a+c.docs.length,0),'srs',d.customers.reduce((a,c)=>a+c.docs.filter(x=>x.kind==='sr').length,0))"
```

Expected: customers ≈ 119; srs > 0 (prepay stores exist). If srs = 0, STOP and debug the CustomerRef→local mapping before proceeding.

---

### Task 6: compute.ts — assemble ReportData + notes-input

**Files:**
- Create: `scripts/yiddy-report/compute.ts`
- Modify: `scripts/yiddy-report/metrics.ts` (one new pure function + tests)

- [ ] **Step 1: Failing test for the last pure piece — `t90Windows`**

```ts
// append to metrics.test.ts
import { spendInDayWindow } from "./metrics";

describe("spendInDayWindow", () => {
  test("sums docs with genDate-relative day offsets [from, to)", () => {
    const docs = [doc("2026-08-15", 100), doc("2026-05-15", 40), doc("2026-01-01", 7)];
    expect(spendInDayWindow(docs, "2026-09-01", 0, 90)).toBe(100);   // last 90 days
    expect(spendInDayWindow(docs, "2026-09-01", 90, 180)).toBe(40);  // prior 90
  });
});
```

- [ ] **Step 2: Verify failure, implement, verify pass**

```ts
// append to metrics.ts
export function spendInDayWindow(
  docs: GatheredDoc[],
  genDate: string,
  fromDaysAgo: number,
  toDaysAgo: number,
): number {
  let total = 0;
  for (const d of docs) {
    const age = daysBetween(d.date, genDate);
    if (age >= fromDaysAgo && age < toDaysAgo) total += d.total;
  }
  return total;
}
```

Run: `npx vitest run scripts/yiddy-report/metrics.test.ts` → PASS.

- [ ] **Step 3: Write `scripts/yiddy-report/compute.ts`**

```ts
// Crunches gathered.json → report-data.json + notes-input.json.
// Usage: npx tsx scripts/yiddy-report/compute.ts [--gen-date YYYY-MM-DD]
import { readFileSync, writeFileSync } from "node:fs";
import type { GatheredData, ReportData, StoreReport } from "./types";
import {
  bucketMonthly, windowTotals, ttmMonths, priorYearMonths, monthOf,
  medianGapDays, daysBetween, trendBadge, seasonFlag, spendInDayWindow,
  catalogEpoch, newProducts, purchasedSkus, popularGaps, topProducts,
} from "./metrics";

const OUT = "scripts/yiddy-report-out";
const data: GatheredData = JSON.parse(readFileSync(`${OUT}/gathered.json`, "utf8"));
const genDate =
  process.argv.includes("--gen-date")
    ? process.argv[process.argv.indexOf("--gen-date") + 1]
    : data.genDate;

const ttm = ttmMonths(genDate);
const prior = priorYearMonths(genDate);
const ttmSet = new Set(ttm);
const fresh = newProducts(data.products, genDate);
const skuNames = new Map(data.products.map((p) => [p.sku, p.name]));

// breadth base: what every roster store bought across the whole window
const purchasedByStore = new Map(
  data.customers.map((c) => [c.id, purchasedSkus(c.docs)]),
);

const stores: StoreReport[] = data.customers.map((c) => {
  const ttmDocs = c.docs.filter((d) => ttmSet.has(monthOf(d.date)));
  const t = windowTotals(c.docs, ttm);
  const p = windowTotals(c.docs, prior);
  // cadence: lifetime invoice dates; SR-only stores fall back to window docs
  const cadenceDates =
    c.lifetimeOrderDates.length >= 3
      ? c.lifetimeOrderDates
      : c.docs.map((d) => d.date);
  const gap = medianGapDays(cadenceDates);
  const allDates = [...new Set([...c.lifetimeOrderDates, ...c.docs.map((d) => d.date)])].sort();
  const last = allDates[allDates.length - 1] ?? null;
  const dsl = last ? daysBetween(last, genDate) : null;
  const trend = trendBadge({
    t90Spend: spendInDayWindow(c.docs, genDate, 0, 90),
    prior90Spend: spendInDayWindow(c.docs, genDate, 90, 180),
    daysSinceLastOrder: dsl,
    medianGap: gap,
  });
  const season = seasonFlag(c.docs, genDate);
  const monthly = bucketMonthly(c.docs, genDate).map((m) => ({
    ...m,
    held: c.holdPeriods.some(
      (h) => monthOf(h.from) <= m.month && (h.to === null || monthOf(h.to) >= m.month),
    ),
  }));
  const own = purchasedByStore.get(c.id) ?? new Set<string>();
  const cmTtm = c.creditMemos.filter((m) => ttmSet.has(monthOf(m.date)));
  return {
    id: c.id,
    name: c.displayName,
    phones: [
      ...(c.phone ? [{ label: "Main", number: c.phone }] : []),
      ...c.additionalPhones,
    ],
    emails: [...new Set([c.primaryEmail, ...c.contacts.map((x) => x.email)].filter((e): e is string => !!e))],
    contacts: c.contacts,
    paymentTerms: c.paymentTerms,
    holdStatus: c.holdStatus,
    balance: c.balance,
    overdueBalance: c.overdueBalance,
    ttmSpend: t.spend,
    priorYearSpend: p.spend,
    yoyPct: p.spend > 0 ? Math.round(((t.spend - p.spend) / p.spend) * 100) : null,
    ttmOrders: t.orders,
    priorYearOrders: p.orders,
    daysSinceLastOrder: dsl,
    medianGapDays: gap,
    trend,
    seasonFlag: season.flagged,
    firstOrderDate: c.firstOrderDate ?? c.docs[0]?.date ?? null,
    bookSplit: {
      feldart: ttmDocs.filter((d) => d.origin === "feldart").reduce((a, d) => a + d.total, 0),
      tj: ttmDocs.filter((d) => d.origin === "tj").reduce((a, d) => a + d.total, 0),
    },
    monthly,
    aovTtm: t.orders > 0 ? t.spend / t.orders : null,
    aovPriorYear: p.orders > 0 ? p.spend / p.orders : null,
    distinctSkusTtm: purchasedSkus(ttmDocs).size,
    orders: ttmDocs
      .map((d) => ({ docNumber: d.docNumber, kind: d.kind, date: d.date, total: d.total, origin: d.origin, status: d.status }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    openInvoiceTotal: ttmDocs.reduce((a, d) => a + d.openBalance, 0),
    topProducts: topProducts(ttmDocs),
    newProductsTaken: fresh.filter((pr) => own.has(pr.sku)).map(({ sku, name }) => ({ sku, name })),
    newProductsNotTaken: fresh.filter((pr) => !own.has(pr.sku)).map(({ sku, name }) => ({ sku, name })),
    popularGaps: popularGaps(c.id, purchasedByStore, skuNames),
    returns: { count: cmTtm.length, value: cmTtm.reduce((a, m) => a + m.total, 0) },
    holdPeriods: c.holdPeriods,
    note: null, // injected at render from reviewed notes
  };
});

const trendCounts = { growing: 0, steady: 0, declining: 0, dormant: 0 };
for (const s of stores) trendCounts[s.trend]++;

const report: ReportData = {
  genDate,
  generatedAt: data.generatedAt,
  rosterCount: stores.length,
  totals: {
    ttmSpend: stores.reduce((a, s) => a + s.ttmSpend, 0),
    priorYearSpend: stores.reduce((a, s) => a + s.priorYearSpend, 0),
    ttmOrders: stores.reduce((a, s) => a + s.ttmOrders, 0),
    trendCounts,
  },
  winBack: stores
    .filter((s) => s.trend === "dormant" || s.trend === "declining")
    .sort((a, b) => b.priorYearSpend - a.priorYearSpend)
    .slice(0, 15)
    .map((s) => ({ id: s.id, name: s.name, priorSpend: s.priorYearSpend, daysSinceLastOrder: s.daysSinceLastOrder, trend: s.trend })),
  seasonFlags: data.customers
    .map((c) => ({ c, f: seasonFlag(c.docs, genDate) }))
    .filter((x) => x.f.flagged)
    .sort((a, b) => b.f.lastYearSeasonSpend - a.f.lastYearSeasonSpend)
    .map((x) => ({ id: x.c.id, name: x.c.displayName, lastYearSeasonSpend: x.f.lastYearSeasonSpend })),
  stores: stores.sort((a, b) => b.ttmSpend - a.ttmSpend),
};

writeFileSync(`${OUT}/report-data.json`, JSON.stringify(report));

// notes-input for the sanitization review gate
writeFileSync(
  `${OUT}/notes-input.json`,
  JSON.stringify(
    data.customers
      .filter((c) => c.internalNotes || c.aiCustomerContext || c.orderHoldNotes.length > 0)
      .map((c) => ({
        id: c.id,
        name: c.displayName,
        internalNotes: c.internalNotes,
        aiCustomerContext: c.aiCustomerContext,
        orderHoldNotes: c.orderHoldNotes,
        holdPeriods: c.holdPeriods,
      })),
    null,
    2,
  ),
);
console.log(`stores: ${stores.length}; winBack: ${report.winBack.length}; seasonFlags: ${report.seasonFlags.length}`);
```

- [ ] **Step 4: Run it**

Run: `npx tsx scripts/yiddy-report/compute.ts --gen-date 2026-09-01`
Expected: prints counts; creates `scripts/yiddy-report-out/report-data.json` + `notes-input.json`.

- [ ] **Step 5: Spot-check against prod truth**

Pick 2 stores (one terms store, one payment-upfront store) and verify TTM totals against the finance-hub UI / a direct SQL sum over `ssh finance-vps`. The upfront store MUST show sales-receipt orders. Numbers must reconcile to the pound.

- [ ] **Step 6: Commit**

```bash
git add scripts/yiddy-report/compute.ts scripts/yiddy-report/metrics.ts scripts/yiddy-report/metrics.test.ts
git commit -m "feat(yiddy-report): compute stage — ReportData + notes-input"
```

---

### Task 7: HTML template + render.ts

**Files:**
- Create: `scripts/yiddy-report/template.html`
- Create: `scripts/yiddy-report/render.ts`

**MANDATORY: invoke the `dataviz` Skill before writing any chart markup/CSS in the template** (bar strip + hold shading are charts). Follow its palette/mark rules; the template is standalone so all CSS is inline.

- [ ] **Step 1: Write `scripts/yiddy-report/render.ts`**

```ts
// Bakes report-data.json (+ reviewed notes if present) into template.html.
// Usage: npx tsx scripts/yiddy-report/render.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ReportData } from "./types";

const OUT = "scripts/yiddy-report-out";
const report: ReportData = JSON.parse(readFileSync(`${OUT}/report-data.json`, "utf8"));

const notesPath = `${OUT}/notes-reviewed.json`;
if (existsSync(notesPath)) {
  const notes: Record<string, string | null> = JSON.parse(readFileSync(notesPath, "utf8"));
  for (const s of report.stores) s.note = notes[s.id] ?? null;
  console.log(`notes injected: ${Object.values(notes).filter(Boolean).length}`);
} else {
  console.warn("notes-reviewed.json not found — rendering WITHOUT sanitized notes");
}

const template = readFileSync("scripts/yiddy-report/template.html", "utf8");
// JSON inside <script> — escape "</" so a note can't break out of the tag.
const json = JSON.stringify(report).replace(/</g, "\\u003c");
const html = template.replace("/*__DATA__*/null", json);
const outFile = `${OUT}/yiddy-roster-report-${report.genDate.slice(0, 7)}.html`;
writeFileSync(outFile, html);
console.log(`wrote ${outFile} (${Math.round(html.length / 1024)} KB)`);
```

- [ ] **Step 2: Write `scripts/yiddy-report/template.html`**

Structure (single file, no external requests, all CSS/JS inline; data injected as `const DATA = /*__DATA__*/null;`):

1. **Header:** title "Yiddy roster — sales focus report", genDate, roster count; four stat tiles (TTM spend + YoY, TTM orders, trend counts, season-flag count).
2. **Win-back strip:** horizontally scrollable cards from `DATA.winBack` — name, prior-year spend, days quiet, trend badge; click scrolls to + expands that store's row.
3. **Season strip:** same pattern from `DATA.seasonFlags` ("bought this season last year — nothing yet").
4. **Filter bar:** text input (name substring), `<select>` trend, `<select>` blocker (all / on hold / prepay / has overdue / clear), sort `<select>` (TTM spend / YoY % / days since last order / name).
5. **Store table:** one `<tr>` per store: name, TTM spend, YoY %, orders, days-since-last, median gap, trend badge, blocker badge. Click toggles a detail `<tr>` beneath it containing:
   - call-sheet grid (phones, emails, contacts, terms, balance, overdue, hold status)
   - 12-month bar chart (inline SVG per dataviz skill; spend bars + order-count labels; months with `held: true` get a shaded background band; hold reasons listed under the chart from `holdPeriods`)
   - averages row (AOV TTM vs prior year, distinct SKUs, book split when tj > 0)
   - `<details>` "Orders (N)" — table: doc number, type (Invoice/Sales receipt), date, value, book, status; "Open invoices: £X" line above it
   - top products list; new-products taken/not-taken two-column list; popular-gaps list ("N of the stores we supply buy this"); returns line; sanitized note paragraph (when present)
6. **Behaviour JS (~150 lines vanilla):** `render(stores)` builds rows from the filtered/sorted array; filter/sort handlers re-render; row click toggles detail; currency via `Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" })`.

All dynamic text MUST go through a `esc()` helper (`textContent`-based or entity-escaping) — store names and notes are untrusted-ish strings in an HTML context.

- [ ] **Step 3: Render and eyeball**

Run: `npx tsx scripts/yiddy-report/render.ts`
Then open the output file with Playwright (`browser_navigate` to the `file://` path), screenshot at 1440px and 390px widths, and verify: filters work, a detail row expands, orders dropdown opens, chart renders, no console errors (`browser_console_messages`).

- [ ] **Step 4: Commit (template + render only — never the output)**

```bash
git add scripts/yiddy-report/template.html scripts/yiddy-report/render.ts
git commit -m "feat(yiddy-report): standalone HTML template + render stage"
```

---

### Task 8: Sanitized notes — generate, review gate

No new files in the repo (working files live in the gitignored out-dir).

- [ ] **Step 1: Claude writes the sanitized notes**

Read `scripts/yiddy-report-out/notes-input.json` and author `scripts/yiddy-report-out/notes-reviewed.json` — `{ [storeId]: string | null }`. Rules per spec:
- One neutral factual sentence, only where the notes explain ordering behaviour (holds, payment arrangements, disputes since resolved, seasonal buying habits).
- NO candid remarks, no character judgements, no internal finance chatter, no amounts owed unless already shown in the report anyway.
- `null` (or omit) where there's nothing relevant — most stores.

- [ ] **Step 2: USER REVIEW GATE — hard stop**

Present every generated sentence to Josh in the conversation (store name + sentence). Do NOT proceed to final render until Josh approves or edits them. Apply edits to `notes-reviewed.json`.

- [ ] **Step 3: Re-render with notes**

Run: `npx tsx scripts/yiddy-report/render.ts`
Expected: `notes injected: <n>` and a fresh output HTML.

---

### Task 9: Final verification + delivery

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: PASS (metrics tests + whole existing suite untouched).

- [ ] **Step 2: Reconciliation checks (verification-before-completion)**

- Roster count in header ≈ 119 and equals the table row count with no filters.
- One terms store + one prepay store spot-reconciled to prod (Task 6 Step 5 repeated on the final HTML numbers).
- A store with a known hold (e.g. Meoros Judaica #18926) shows the hold shading + reason in the right months.
- Season strip is non-empty (it's Elul) or, if empty, verify why against the data before accepting.

- [ ] **Step 3: Deliver**

Send the final HTML to Josh via SendUserFile (`display: render`) with a one-line caption. Remind: file contains customer balances + contact details — distribute to Yiddy only.

- [ ] **Step 4: Close out**

Update memory (`project_*` file + MEMORY.md pointer) with: what shipped, where the scripts live, the regenerate recipe (gather-on-VPS → compute → notes gate → render), and the SR-cadence caveat.
