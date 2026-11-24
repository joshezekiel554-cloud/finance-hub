// Customer-rule evaluation (Hold Orders). PURE: callers load the customer's
// open invoices + candidate orders and pass them in, so the same function
// drives the editor preview, the at-risk list, the detection job, and the
// auto-release check — one answer to "would this rule hold them today?".

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
  ageDays: number;
  balance: number;
};

export type RuleEvaluation = {
  wouldHold: boolean;
  // Every open invoice over the line, oldest first.
  hits: RuleHit[];
  openBalance: number;
  // Human "why", e.g. "Rule: VIP 90/110 — invoice 19310 at 112 days".
  why: string | null;
};

const DAY_MS = 86_400_000;

function toDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d.length === 10 ? `${d}T00:00:00Z` : d);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

/** Whole days between invoice date and `now` (UTC days). */
export function invoiceAgeDays(
  inv: Pick<RuleInvoice, "issueDate" | "dueDate">,
  termsDays: number,
  now: Date,
): number | null {
  let issued = toDate(inv.issueDate);
  if (!issued) {
    const due = toDate(inv.dueDate);
    if (!due) return null;
    issued = new Date(due.getTime() - termsDays * DAY_MS);
  }
  return Math.floor((now.getTime() - issued.getTime()) / DAY_MS);
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

export function evaluateCustomerRule(
  rule: ResolvedHoldRule,
  invoicesIn: readonly RuleInvoice[],
  now: Date = new Date(),
): RuleEvaluation {
  if (rule.preset === "never") {
    return { wouldHold: false, hits: [], openBalance: 0, why: null };
  }
  const open = invoicesIn.filter((i) => isRuleRelevantInvoice(i, now));
  const openBalance = Math.round(open.reduce((s, i) => s + Number(i.balance), 0) * 100) / 100;
  const hits: RuleHit[] = [];
  for (const inv of open) {
    const age = invoiceAgeDays(inv, rule.termsDays, now);
    if (age == null) continue;
    if (age > rule.holdWhenInvoiceDaysOver) {
      hits.push({ docNumber: inv.docNumber, ageDays: age, balance: Number(inv.balance) });
    }
  }
  hits.sort((a, b) => b.ageDays - a.ageDays);
  const wouldHold = hits.length > 0 && openBalance >= rule.minBalance;
  let why: string | null = null;
  if (wouldHold) {
    const oldest = hits[0]!;
    const more = hits.length > 1 ? ` (+${hits.length - 1} more)` : "";
    why = `Rule: ${describeRule(rule)} — invoice ${oldest.docNumber ?? "(no #)"} at ${oldest.ageDays} days${more}`;
  }
  return { wouldHold, hits, openBalance, why };
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
