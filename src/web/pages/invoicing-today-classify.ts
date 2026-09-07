// Which tab a Today row belongs in.
//
// Extracted out of invoicing-today.tsx so it can be unit-tested — the repo
// has no DOM test environment, so this file must stay free of React and of
// anything that imports it.

export type TodayTab =
  | "open"
  | "unparseable"
  | "sent"
  | "dismissed"
  | "phone_calls";

// The minimal structural shape classification actually reads. The page's
// full Row type satisfies it, and so does a hand-built test fixture.
export type ClassifiableTodayRow = {
  gmailId: string;
  parseConfidence: number;
  // Non-null when the server filed this row away without the operator
  // touching it — currently only "b2c_paid_upfront" (a sales receipt for
  // a consumer order that was paid on the storefront, so there is nothing
  // to reconcile or send).
  autoHidden: string | null;
  qbInvoice: { emailStatus: string | null } | null;
};

// Priority order:
//   1. A real dismissal wins — a row the operator filed stays filed,
//      whatever else is true of it.
//   2. An auto-hidden row is filed too, so Open holds only work the
//      operator has to do. Ranked above Sent/Unparseable because the
//      reason it isn't actionable outranks how it happens to look.
//   3. Already-sent rows live in Sent (matches QBO EmailStatus).
//   4. Low-confidence parses go to Unparseable.
//   5. Everything else is Open.
export function classifyTodayRow(
  row: ClassifiableTodayRow,
  dismissed: Record<string, unknown>,
): TodayTab {
  if (dismissed[row.gmailId]) return "dismissed";
  if (row.autoHidden) return "dismissed";
  if (row.qbInvoice?.emailStatus === "EmailSent") return "sent";
  if (row.parseConfidence < 0.5) return "unparseable";
  return "open";
}
