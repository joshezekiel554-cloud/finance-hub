// Hold Orders board — pure row classification (tabs, ladder stage, why-held,
// mismatch flags). Kept free of DB so it's unit-testable and so the SPA can
// share the labels.

export const HOLD_TABS = [
  "held",
  "chasing",
  "at_risk",
  "shipped_while_held",
  "released",
] as const;
export type HoldTab = (typeof HOLD_TABS)[number];

export const HOLD_TAB_LABELS: Record<HoldTab, string> = {
  held: "Held",
  chasing: "Chasing",
  at_risk: "At risk",
  shipped_while_held: "Shipped while held",
  released: "Released (30 days)",
};

export type LadderStage = "off" | "paused" | "promise" | "not_started" | "notice" | "warning" | "cancel_notice";

export const LADDER_STAGE_LABELS: Record<LadderStage, string> = {
  off: "No customer emails",
  paused: "Paused",
  promise: "Paused — customer promise",
  not_started: "Day-0 notice due",
  notice: "Day-0 notice sent",
  warning: "Day-7 warning sent",
  cancel_notice: "Day-10 cancel notice sent",
};

export type Mismatch = "shipped_while_held" | "released_but_account_on_hold";

export const MISMATCH_LABELS: Record<Mismatch, string> = {
  shipped_while_held: "Shipped while still held here",
  released_but_account_on_hold: "Released here, but the customer account is still on hold",
};

export function humanHoldReason(reason: string | null, note: string | null): string {
  switch (reason) {
    case "customer_on_hold":
      return "Customer account is on hold";
    case "payment_upfront_unpaid":
      return "Payment upfront — order not paid yet";
    case "overdue_non_communicating":
      return note ? `Large overdue balance, not in contact — ${note}` : "Large overdue balance, not in contact";
    case "customer_rule":
      return note || "Customer hold rule";
    case "manual":
      return note ? `Manual hold — ${note}` : "Manual hold";
    default:
      return note || "On hold";
  }
}

function inFuture(d: Date | string | null | undefined, now: Date): boolean {
  if (!d) return false;
  const t = new Date(d).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/** Promise is active through the END of the promised day (YYYY-MM-DD). */
export function promiseActive(payBy: string | null | undefined, now: Date): boolean {
  if (!payBy) return false;
  const today = now.toISOString().slice(0, 10);
  return payBy >= today;
}

export function ladderStage(r: {
  holdState: string | null;
  ladderEnabled: boolean;
  pausedUntil: Date | string | null;
  promisedPayBy: string | null;
  noticeAt: Date | string | null;
  warnedAt: Date | string | null;
  cancelNotifiedAt: Date | string | null;
}, now: Date): LadderStage {
  if (r.holdState !== "on_hold" || !r.ladderEnabled) return "off";
  if (r.cancelNotifiedAt) return "cancel_notice";
  if (inFuture(r.pausedUntil, now)) return "paused";
  if (promiseActive(r.promisedPayBy, now)) return "promise";
  if (r.warnedAt) return "warning";
  if (r.noticeAt) return "notice";
  return "not_started";
}

/** Actively being chased by the customer email ladder right now. */
export function isChasing(stage: LadderStage): boolean {
  return stage === "not_started" || stage === "notice" || stage === "warning";
}

export type ShippedInfo = {
  source: "extensiv" | "shopify";
  trackingNumber: string | null;
  shipDate: string | null;
  carrier: string | null;
  transactionNumber?: string | null;
};

export function mismatchFor(r: {
  holdState: string | null;
  shipped: ShippedInfo | null;
  customerHoldStatus: string | null;
}): Mismatch | null {
  if (r.holdState === "on_hold" && r.shipped) return "shipped_while_held";
  if (r.holdState === "released" && r.customerHoldStatus === "hold") return "released_but_account_on_hold";
  return null;
}

export function daysBetween(from: Date | string | null | undefined, now: Date): number {
  if (!from) return 0;
  const t = new Date(from).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** "#18926" / "18926" / " 18926 " → "18926" (QBO DocNumber + shipment PO form). */
export function normalizeOrderNumber(n: string | null | undefined): string | null {
  if (!n) return null;
  const s = n.trim().replace(/^#/, "");
  return s || null;
}

export function matchesSearch(
  r: { orderNumber: string | null; customerName: string | null },
  q: string,
): boolean {
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return true;
  return (
    (r.orderNumber ?? "").toLowerCase().replace(/^#/, "").includes(needle) ||
    (r.customerName ?? "").toLowerCase().includes(needle)
  );
}

/** Opaque offset cursor. */
export function decodeCursor(c: string | undefined): number {
  const n = Number(c);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
