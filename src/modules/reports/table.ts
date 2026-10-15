// Shared row-report shape for Feldart AI (hub "sheet-from-rows" contract,
// agreed on the radio 2026-10-15). Finance returns rows; the hub hands
// them to internal's single Sheet writer, so this shape is the whole
// interface — keep it generic and JSON-plain.
//
// Rows are objects keyed by column key (null = empty) so the hub can join
// finance + inbox rows by key. money/number/percent cells are JSON numbers
// (the sheet formats + sums them; money columns carry their currency),
// dates are "YYYY-MM-DD" strings, url cells are full finance URLs.

export type ReportColumnType =
  | "text"
  | "money"
  | "number"
  | "percent"
  | "date"
  | "url"
  | "bool";

export type ReportColumn = {
  key: string;
  label: string;
  type: ReportColumnType;
  currency?: "USD" | "GBP";
};

export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;

export type ReportTable = {
  title: string;
  asOf: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: Record<string, number>;
  warnings: string[];
};

/** Parse a decimal-string DB value; null/garbage → 0. */
export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents so float noise never reaches the sheet. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A DATE column value as drizzle hands it back (Date) or as a string. */
export type DateLike = string | Date | null;

/** Normalise a DATE value to "YYYY-MM-DD" (UTC, same as the statement PDF). */
export function dayOf(d: DateLike | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Today's calendar date in UTC as "YYYY-MM-DD" — matches the statement renderer. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from `dueDate` to `today` (both "YYYY-MM-DD", UTC midnight).
 * Positive = overdue, 0 = due today, negative = not yet due. null → null.
 */
export function daysPastDue(dueDate: DateLike, today: string): number | null {
  const day = dayOf(dueDate);
  if (!day) return null;
  const due = Date.parse(`${day}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(now)) return null;
  return Math.round((now - due) / 86_400_000);
}

/** Finance's books are kept in USD (QBO home currency). */
export const usd = (key: string, label: string): ReportColumn => ({
  key,
  label,
  type: "money",
  currency: "USD",
});

/** Sum the named numeric keys across rows (cents-rounded). */
export function sumKeys(rows: ReportRow[], keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = money(
      rows.reduce((s, r) => s + (typeof r[k] === "number" ? (r[k] as number) : 0), 0),
    );
  }
  return out;
}

/** Keep only the declared column keys, in order, with null for missing. */
export function shapeRows(columns: ReportColumn[], rows: ReportRow[]): ReportRow[] {
  return rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? null])));
}
