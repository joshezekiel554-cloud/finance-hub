// Pure derivations for the dashboard cards. Kept out of the components so
// they can be unit-tested (no DOM test env in this repo).

const AWAITING_ARRIVAL = new Set(["approved", "awaiting_warehouse_number", "sent_to_warehouse"]);

/** RMAs we're waiting to physically receive, longest-waiting first. */
export function awaitingArrivalRmas<T extends { status: string; updatedAt: string }>(rows: T[]): T[] {
  return rows
    .filter((r) => AWAITING_ARRIVAL.has(r.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** Customers on hold vs payment-upfront, each largest overdue first. */
export function groupHolds<T extends { holdStatus: "hold" | "payment_upfront"; overdueBalance: string }>(
  rows: T[],
): { onHold: T[]; paymentUpfront: T[] } {
  const byOverdue = (a: T, b: T) => Number(b.overdueBalance) - Number(a.overdueBalance);
  return {
    onHold: rows.filter((r) => r.holdStatus === "hold").sort(byOverdue),
    paymentUpfront: rows.filter((r) => r.holdStatus === "payment_upfront").sort(byOverdue),
  };
}

const LONDON_DATE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/London",
});

export function londonDateOf(d: Date): string {
  return LONDON_DATE.format(d);
}

/**
 * Today's warehouse emails that still need an invoice sent: received today
 * (London), not dismissed, and the QBO invoice (if any) not yet emailed.
 */
export function unsentTodayRows<
  T extends {
    gmailId: string;
    receivedAt: string | null;
    qbInvoice: { emailStatus: string | null } | null;
    autoHidden?: string | null;
  },
>(rows: T[], dismissed: Record<string, unknown>, todayLondon: string): T[] {
  return rows.filter((row) => {
    if (!row.receivedAt) return false;
    if (row.autoHidden) return false; // filed away by the server, nothing to send
    if (londonDateOf(new Date(row.receivedAt)) !== todayLondon) return false;
    if (dismissed[row.gmailId]) return false;
    if (row.qbInvoice?.emailStatus === "EmailSent") return false;
    return true;
  });
}
