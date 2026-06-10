import type { InvoiceOrigin } from "../invoicing/origin.js";

export type OriginBalanceInput = {
  origin: InvoiceOrigin;
  balance: string | number;
  dueDate: Date | string | null;
};

export type OriginBalance = { balance: number; overdue: number };
export type OriginBalances = { feldart: OriginBalance; tj: OriginBalance };

// Compute per-origin open + overdue balances from a customer's invoices, then
// net each origin's unapplied credit against its own figures (TJ credit only
// ever offsets TJ; Feldart only Feldart). Credit reduces both balance and
// overdue, floored at zero — since gross overdue <= gross balance, net overdue
// stays <= net balance. This is the deliberately conservative reading: credit
// knocks down the overdue (chase) figure so we never over-chase a customer who
// is genuinely in credit.
export function computeOriginBalances(
  invoices: OriginBalanceInput[],
  credit: { feldart: number; tj: number },
  now: Date = new Date(),
  // Cutoff for the overdue comparison (due < cutoff). Defaults to `now`
  // (display/statement callers: an invoice due earlier today counts as
  // overdue). Severity callers pass startOfDayUtc(now) so the filter agrees
  // with chase scoring, which treats due-today as NOT overdue.
  overdueCutoff: Date = now,
): OriginBalances {
  const gross: OriginBalances = {
    feldart: { balance: 0, overdue: 0 },
    tj: { balance: 0, overdue: 0 },
  };

  for (const inv of invoices) {
    const bal = typeof inv.balance === "number" ? inv.balance : Number(inv.balance);
    if (!Number.isFinite(bal) || bal <= 0) continue;
    const bucket = gross[inv.origin];
    bucket.balance += bal;
    if (isOverdue(inv.dueDate, overdueCutoff)) bucket.overdue += bal;
  }

  return {
    feldart: net(gross.feldart, credit.feldart),
    tj: net(gross.tj, credit.tj),
  };
}

function isOverdue(dueDate: Date | string | null, cutoff: Date): boolean {
  if (dueDate == null) return false;
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < cutoff.getTime();
}

function net(gross: OriginBalance, credit: number): OriginBalance {
  const c = Number.isFinite(credit) && credit > 0 ? credit : 0;
  return {
    balance: round2(Math.max(0, gross.balance - c)),
    overdue: round2(Math.max(0, gross.overdue - c)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
