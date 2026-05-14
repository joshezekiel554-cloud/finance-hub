// Compute the customer-facing "overdue" figure net of unapplied credit
// memos. Floors at zero so we never tell a customer their overdue is
// negative — that's the job of the "Net amount due" total in the PDF
// statement, which can legitimately go negative when credits exceed
// open balance.

function parseAmount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function effectiveOverdue(
  overdueBalance: string | number | null | undefined,
  unappliedCreditBalance: string | number | null | undefined,
): number {
  const overdue = parseAmount(overdueBalance);
  const credits = parseAmount(unappliedCreditBalance);
  const net = overdue - credits;
  if (net <= 0) return 0;
  return Math.round(net * 100) / 100;
}
