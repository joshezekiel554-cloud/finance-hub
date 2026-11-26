// Customer-rule evaluation (Hold Orders). PURE: callers load the customer's
// open invoices + candidate orders and pass them in, so the same function
// drives the editor preview, the at-risk list, the detection job, and the
// auto-release check — one answer to "would this rule hold them today?".
// Rules are OVERDUE-based (days past each invoice's due date) — see presets.ts.

import { describeRule, type ResolvedHoldRule } from "./presets.js";

export type RuleInvoice = {
  docNumber: string | null;
  issueDate: string | Date | null;
  dueDate: string | Date | null;
  balance: string | number;
  status: string | null;
  origin: string | null;
  disputeState?: string | null;
};

export type RuleOrder = {
  orderId: string;
  orderNumber: string | null;
  total: string | null;
  holdState: string | null;
  cancelledAt: Date | string | null;
  fulfillmentStatus: string | null;
  shipmentStatus: string | null;
};

export type RuleHit = {
  docNumber: string | null;
  daysOverdue: number;
  balance: number;
};

export type RuleEvaluation = {
  wouldHold: boolean;
  // Every open invoice over the line, most overdue first.
  hits: RuleHit[];
  // Total open balance (all open invoices) and the part that's past due.
  openBalance: number;
  overdueBalance: number;
  // Human "why", e.g. "Rule: Standard — 15 days overdue — invoice 19310 is 22 days overdue (Net 30)".
  why: string | null;
};

const DAY_MS = 86_400_000;

function toDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/**
 * Whole days past the invoice's due date (negative = not yet due). No due
 * date → issue date + `termsDays`; neither available → null (not overdue).
 */
export function invoiceDaysOverdue(
  inv: Pick<RuleInvoice, "issueDate" | "dueDate">,
  termsDays: number | null,
  now: Date,
): number | null {
  let due = toDate(inv.dueDate);
  if (!due) {
    const issued = toDate(inv.issueDate);
    if (!issued || termsDays == null) return null;
    due = new Date(issued.getTime() + termsDays * DAY_MS);
  }
  return Math.floor((now.getTime() - due.getTime()) / DAY_MS);
}

const CLOSED_STATUSES = new Set(["void", "paid", "draft"]);

/**
 * Is this invoice an open Feldart-book receivable the rule should look at?
 * Mirrors what the rest of the app treats as chaseable: balance > 0, not
 * void/paid/draft, not future-dated (the sync's 2030-01-01 placeholders),
 * not the TJ legacy book (its own softer chase track), and not parked in a
 * TJ dispute verification.
 */
export function isRuleRelevantInvoice(inv: RuleInvoice, now: Date): boolean {
  const bal = Number(inv.balance);
  if (!Number.isFinite(bal) || bal <= 0) return false;
  if (inv.status && CLOSED_STATUSES.has(inv.status)) return false;
  if ((inv.origin ?? "feldart") !== "feldart") return false;
  if (inv.disputeState === "verifying") return false;
  const issued = toDate(inv.issueDate);
  if (issued && issued.getTime() > now.getTime()) return false;
  return true;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Total open + overdue balance over the rule-relevant invoices. */
export function customerBalances(
  invoicesIn: readonly RuleInvoice[],
  termsDays: number | null,
  now: Date = new Date(),
): { openBalance: number; overdueBalance: number } {
  let open = 0;
  let overdue = 0;
  for (const inv of invoicesIn) {
    if (!isRuleRelevantInvoice(inv, now)) continue;
    const bal = Number(inv.balance);
    open += bal;
    const d = invoiceDaysOverdue(inv, termsDays, now);
    if (d != null && d > 0) overdue += bal;
  }
  return { openBalance: round2(open), overdueBalance: round2(overdue) };
}

export function evaluateCustomerRule(
  rule: ResolvedHoldRule & { source?: "explicit" | "default" },
  invoicesIn: readonly RuleInvoice[],
  now: Date = new Date(),
  // The customer's terms (customers.payment_terms) in days — only used to
  // derive a due date for an invoice that has none, and for the why-text.
  terms: { days: number | null; label?: string | null } = { days: null },
): RuleEvaluation {
  const { openBalance, overdueBalance } = customerBalances(invoicesIn, terms.days, now);
  if (rule.preset === "never") {
    return { wouldHold: false, hits: [], openBalance, overdueBalance, why: null };
  }
  const hits: RuleHit[] = [];
  for (const inv of invoicesIn) {
    if (!isRuleRelevantInvoice(inv, now)) continue;
    const d = invoiceDaysOverdue(inv, terms.days, now);
    if (d == null) continue;
    if (d > rule.graceDays) hits.push({ docNumber: inv.docNumber, daysOverdue: d, balance: Number(inv.balance) });
  }
  hits.sort((a, b) => b.daysOverdue - a.daysOverdue);
  const wouldHold = hits.length > 0 && overdueBalance >= rule.minOverdue;
  let why: string | null = null;
  if (wouldHold) {
    const worst = hits[0]!;
    const more = hits.length > 1 ? ` (+${hits.length - 1} more)` : "";
    const t = terms.label?.trim() ? ` (${terms.label.trim()})` : "";
    why = `Rule: ${describeRule(rule)} — invoice ${worst.docNumber ?? "(no #)"} is ${worst.daysOverdue} days overdue${t}${more}`;
  }
  return { wouldHold, hits, openBalance, overdueBalance, why };
}

/** Still holdable = not cancelled, not shipped/fulfilled, not delivered. */
export function isOrderOpen(o: Pick<RuleOrder, "cancelledAt" | "fulfillmentStatus" | "shipmentStatus">): boolean {
  if (o.cancelledAt) return false;
  const f = (o.fulfillmentStatus ?? "").toLowerCase();
  if (f === "fulfilled" || f === "restocked") return false;
  if ((o.shipmentStatus ?? "").toLowerCase() === "delivered") return false;
  return true;
}

/**
 * Orders a rule would newly hold: open, and never held before (holdState
 * "none"). A released order is deliberately never re-held by a rule — the
 * operator already decided to let it go (e.g. "paid outside QBO" while the
 * invoice still shows open in QBO).
 */
export function ordersRuleWouldHold<T extends RuleOrder>(
  evaluation: RuleEvaluation,
  orders: readonly T[],
): T[] {
  if (!evaluation.wouldHold) return [];
  return orders.filter((o) => (o.holdState ?? "none") === "none" && isOrderOpen(o));
}
