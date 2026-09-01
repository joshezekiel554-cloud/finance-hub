// Pure metric functions for the yiddy-roster report. Every function
// takes genDate (ISO YYYY-MM-DD) explicitly so results are
// deterministic and testable — no clock reads here.
import type { GatheredDoc } from "./types";

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
