import { and, eq, gt, gte, inArray, max } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { customers } from "../../../db/schema/customers.js";
import { invoices } from "../../../db/schema/invoices.js";
import type { Invoice } from "../../../db/schema/invoices.js";
import { chaseLog } from "../../../db/schema/audit.js";
import { computeSeverity } from "../../chase/scoring.js";
import { loadRecentHumanContact } from "../../chase/chased-tracker.js";

export type Candidate = {
  entityType: "customer";
  entityId: string;
  // chase_next is the Feldart-book chase track; its TJ twin is
  // candidates/tj-chase.ts (origin "tj"). The scanner stamps this onto
  // ai_proposals.origin.
  origin: "feldart";
  summary: Record<string, unknown>;
};

const CHASE_COOLDOWN_DAYS = 7;
const ACTIONABLE_TIERS = new Set(["CRITICAL", "HIGH", "MEDIUM"]);

export async function findCandidates(
  customerId?: string,
): Promise<Candidate[]> {
  // 1. All overdue, non-excluded customers.
  const overdueRows = await db
    .select()
    .from(customers)
    .where(
      and(
        gt(customers.overdueBalance, "0"),
        eq(customers.agentModeExcluded, false),
        customerId ? eq(customers.id, customerId) : undefined,
      ),
    );

  if (overdueRows.length === 0) return [];

  const customerIds = overdueRows.map((c) => c.id);

  // 2. Batch-load open invoices + last chase_log timestamp in one query each.
  //    Scope invoices to origin='feldart' — TJ (Torah Judaica) is a legacy
  //    wind-down book chased manually with its own templates, so the AI
  //    proposer must never generate chase proposals for it.
  const [allInvoices, recentChases] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(
        and(
          inArray(invoices.customerId, customerIds),
          gt(invoices.balance, "0"),
          eq(invoices.origin, "feldart"),
        ),
      ),
    db
      .select({
        customerId: chaseLog.customerId,
        lastChasedAt: max(chaseLog.chasedAt),
      })
      .from(chaseLog)
      .where(
        and(
          inArray(chaseLog.customerId, customerIds),
          gte(chaseLog.chasedAt, cooldownCutoff()),
        ),
      )
      .groupBy(chaseLog.customerId),
  ]);

  const invoicesByCustomer = new Map<string, typeof allInvoices>();
  for (const inv of allInvoices) {
    if (!inv.customerId) continue;
    const list = invoicesByCustomer.get(inv.customerId) ?? [];
    list.push(inv);
    invoicesByCustomer.set(inv.customerId, list);
  }

  const recentlyChased = new Set(recentChases.map((r) => r.customerId));
  // Don't auto-chase a customer a human (or the Inbox app) just emailed.
  const recentHumanContact = await loadRecentHumanContact(customerIds);

  const candidates: Candidate[] = [];

  for (const customer of overdueRows) {
    if (recentlyChased.has(customer.id)) continue;
    if (recentHumanContact.has(customer.id)) continue;

    // Origin-scoped: only Feldart invoices reached invoicesByCustomer, so the
    // raw-overdue override is the customer's Feldart overdue only. A customer
    // whose overdue is entirely TJ has no Feldart open invoices here → override
    // of 0 → LOW tier → excluded. The gross figure is still netted against the
    // customer's unapplied credit by computeSeverity (no credit override).
    const customerInvoices = invoicesByCustomer.get(customer.id) ?? [];
    const sev = computeSeverity(customer, customerInvoices, {
      rawOverdueOverride: feldartOverdueSum(customerInvoices),
    });
    if (!ACTIONABLE_TIERS.has(sev.tier)) continue;

    // lastChaseAt from the grouped result (null if never chased or outside window)
    const chaseRow = recentChases.find((r) => r.customerId === customer.id);
    const lastChaseAt = chaseRow?.lastChasedAt
      ? new Date(chaseRow.lastChasedAt).toISOString()
      : null;

    candidates.push({
      entityType: "customer",
      entityId: customer.id,
      origin: "feldart",
      summary: {
        // customerId included — the drafting prompt (prompts/chase-next.ts)
        // instructs the tool call with summary.customerId.
        customerId: customer.id,
        customerName: customer.displayName,
        overdueBalance: sev.totalOverdue,
        daysOverdue: sev.daysOverdue,
        tier: sev.tier,
        lastChaseAt,
      },
    });
  }

  return candidates;
}

export async function isStillEligible(entityId: string): Promise<boolean> {
  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, entityId))
    .limit(1);

  if (!customerRow) return false;
  if (customerRow.agentModeExcluded) return false;

  const overdueBalance = Number(customerRow.overdueBalance ?? 0);
  if (overdueBalance <= 0) return false;

  // Origin-scoped to Feldart — TJ invoices are chased manually, never by the
  // AI proposer (see findCandidates).
  const customerInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.customerId, entityId),
        gt(invoices.balance, "0"),
        eq(invoices.origin, "feldart"),
      ),
    );

  const sev = computeSeverity(customerRow, customerInvoices, {
    rawOverdueOverride: feldartOverdueSum(customerInvoices),
  });
  if (!ACTIONABLE_TIERS.has(sev.tier)) return false;

  const [chaseRow] = await db
    .select({ lastChasedAt: max(chaseLog.chasedAt) })
    .from(chaseLog)
    .where(
      and(
        eq(chaseLog.customerId, entityId),
        gte(chaseLog.chasedAt, cooldownCutoff()),
      ),
    );

  if (chaseRow?.lastChasedAt) return false;

  // Re-check at execute time: a human/Inbox reply since the proposal was made
  // should cancel the auto-chase.
  const recentHumanContact = await loadRecentHumanContact([entityId]);
  if (recentHumanContact.has(entityId)) return false;

  return true;
}

function cooldownCutoff(): Date {
  return new Date(Date.now() - CHASE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}

// Gross overdue (balance > 0 AND past due) summed across the supplied invoices.
// Callers pass an already origin-filtered (Feldart-only) list, so the result is
// the customer's Feldart overdue — fed to computeSeverity as rawOverdueOverride
// so the denormalized, origin-blended customer.overdueBalance is never used for
// the chase decision. Mirrors the overdue predicate in chase/scoring.ts.
function feldartOverdueSum(invoiceRows: Pick<Invoice, "balance" | "dueDate">[]): number {
  const todayMs = startOfDayUtcMs(new Date());
  let sum = 0;
  for (const inv of invoiceRows) {
    const balance = Number(inv.balance ?? 0);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    if (!inv.dueDate) continue;
    const due = inv.dueDate instanceof Date ? inv.dueDate : new Date(inv.dueDate);
    if (Number.isNaN(due.getTime())) continue;
    if (startOfDayUtcMs(due) < todayMs) sum += balance;
  }
  return sum;
}

function startOfDayUtcMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
