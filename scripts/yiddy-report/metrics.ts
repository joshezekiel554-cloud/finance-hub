// Pure metric functions for the yiddy-roster report. Every function
// takes genDate (ISO YYYY-MM-DD) explicitly so results are
// deterministic and testable — no clock reads here.
import type { GatheredDoc, TrendBadge } from "./types";

export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

// n consecutive months ascending, ending `endOffset` months before the
// month of genDate (endOffset 0 = ends with the generation month;
// negative offsets reach into future months — the season window uses -1).
const monthsEnding = (genDate: string, n: number, endOffset = 0): string[] => {
  const [y, m] = genDate.split("-").map(Number);
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
  const gaps = sortedDates.slice(1).map((d, i) => daysBetween(sortedDates[i], d));
  gaps.sort((x, y) => x - y);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
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
