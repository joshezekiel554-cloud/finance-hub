// Pure metric functions for the yiddy-roster report. Every function
// takes genDate (ISO YYYY-MM-DD) explicitly so results are
// deterministic and testable — no clock reads here.
import type { GatheredDoc, TrendBadge } from "./types";

export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

// n consecutive months ascending, ending `endOffset` months before the
// month of genDate (endOffset 0 = ends with the generation month;
// negative offsets reach into future months — the season window uses -1).
const monthsEnding = (genDate: string, n: number, endOffset = 0): string[] => {
  const y = Number(genDate.slice(0, 4));
  const m = Number(genDate.slice(5, 7));
  const out: string[] = [];
  for (let i = n - 1 + endOffset; i >= endOffset; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return out;
};

export const ttmMonths = (genDate: string): string[] => monthsEnding(genDate, 12);
export const priorYearMonths = (genDate: string): string[] =>
  monthsEnding(genDate, 12, 12);

export function bucketMonthly(
  docs: GatheredDoc[],
  genDate: string,
): Array<{ month: string; orders: number; spend: number }> {
  const months = ttmMonths(genDate);
  const map = new Map(
    months.map((m) => [m, { month: m, orders: 0, spend: 0 }]),
  );
  for (const d of docs) {
    const row = map.get(monthOf(d.date));
    if (!row) continue;
    row.orders += 1;
    row.spend += d.total;
  }
  return months.map((m) => map.get(m)!);
}

export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function medianGapDays(sortedDates: string[]): number | null {
  if (sortedDates.length < 3) return null;
  const gaps = sortedDates.slice(1).map((d, i) => daysBetween(sortedDates[i]!, d));
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2
    ? gaps[mid]!
    : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2);
}

// Thresholds: growing >= 1.15x prior-90d spend, declining <= 0.7x,
// dormant when quiet for over max(90d, 2x the store's own cadence).
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

// Season window: generation month ±1, compared against the same three
// months a year earlier. Flagged = bought then, silent now.
export function seasonFlag(
  docs: GatheredDoc[],
  genDate: string,
): { flagged: boolean; lastYearSeasonSpend: number } {
  const thisSeason = new Set(monthsEnding(genDate, 3, -1));
  const lastSeason = new Set(
    [...thisSeason].map((m) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`),
  );
  let lastYearSeasonSpend = 0;
  let thisYearHas = false;
  for (const d of docs) {
    const m = monthOf(d.date);
    if (lastSeason.has(m)) lastYearSeasonSpend += d.total;
    if (thisSeason.has(m)) thisYearHas = true;
  }
  return { flagged: lastYearSeasonSpend > 0 && !thisYearHas, lastYearSeasonSpend };
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

type ProductRow = {
  sku: string;
  name: string;
  b2bPrice: number | null;
  createdAt: string;
};

// The initial catalog sync seeded most product rows in one burst, so
// created_at is only meaningful AFTER that day. Epoch = earliest
// calendar day holding >= 30% of all rows.
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
  return days[0]![0]; // no burst day — treat earliest as epoch
}

// Days holding >= 5% of the whole catalog are administrative bulk
// imports (initial sync, catalog migrations), not product launches —
// real launches trickle in small batches.
function bulkDays(products: ProductRow[]): Set<string> {
  const byDay = new Map<string, number>();
  for (const p of products) {
    const day = p.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [day, count] of byDay) {
    // Absolute floor of 5 keeps tiny catalogs (and tests) from flagging
    // every day; the 5% share is what catches real bulk imports.
    if (count >= 5 && count / products.length >= 0.05) out.add(day);
  }
  return out;
}

export function newProducts(
  products: ProductRow[],
  genDate: string,
): ProductRow[] {
  const epoch = catalogEpoch(products);
  const bulk = bulkDays(products);
  const y = Number(genDate.slice(0, 4));
  const m = Number(genDate.slice(5, 7));
  const d = Number(genDate.slice(8, 10));
  const cutoff = new Date(Date.UTC(y, m - 1 - 6, d)).toISOString().slice(0, 10);
  return products
    .filter((p) => {
      const day = p.createdAt.slice(0, 10);
      return (
        (epoch === null || day > epoch) && day >= cutoff && !bulk.has(day)
      );
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function purchasedSkus(docs: GatheredDoc[]): Set<string> {
  const set = new Set<string>();
  for (const d of docs) for (const l of d.lines) if (l.sku) set.add(l.sku);
  return set;
}

// "N of the stores we supply buy this, you don't" — ranked by breadth
// (how many OTHER roster stores bought the sku), capped for punchiness.
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
    .map(([sku, storesBuying]) => ({
      sku,
      name: skuNames.get(sku) ?? sku,
      storesBuying,
    }));
}

export function topProducts(
  docs: GatheredDoc[],
  cap = 5,
): Array<{ sku: string; name: string | null; value: number }> {
  const bySku = new Map<string, { name: string | null; value: number }>();
  for (const d of docs)
    for (const l of d.lines) {
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

// Spend inside a genDate-relative day window [fromDaysAgo, toDaysAgo).
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
