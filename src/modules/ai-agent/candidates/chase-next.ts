import { and, eq, gt, gte, inArray, max } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { customers } from "../../../db/schema/customers.js";
import { invoices } from "../../../db/schema/invoices.js";
import { chaseLog } from "../../../db/schema/audit.js";
import { computeSeverity } from "../../chase/scoring.js";

export type Candidate = {
  entityType: "customer";
  entityId: string;
  summary: Record<string, unknown>;
};

const CHASE_COOLDOWN_DAYS = 7;
const ACTIONABLE_TIERS = new Set(["CRITICAL", "HIGH", "MEDIUM"]);

export async function findCandidates(): Promise<Candidate[]> {
  // 1. All overdue, non-excluded customers.
  const overdueRows = await db
    .select()
    .from(customers)
    .where(
      and(
        gt(customers.overdueBalance, "0"),
        eq(customers.agentModeExcluded, false),
      ),
    );

  if (overdueRows.length === 0) return [];

  const customerIds = overdueRows.map((c) => c.id);

  // 2. Batch-load open invoices + last chase_log timestamp in one query each.
  const [allInvoices, recentChases] = await Promise.all([
    db
      .select()
      .from(invoices)
      .where(
        and(inArray(invoices.customerId, customerIds), gt(invoices.balance, "0")),
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

  const candidates: Candidate[] = [];

  for (const customer of overdueRows) {
    if (recentlyChased.has(customer.id)) continue;

    const sev = computeSeverity(customer, invoicesByCustomer.get(customer.id) ?? []);
    if (!ACTIONABLE_TIERS.has(sev.tier)) continue;

    // lastChaseAt from the grouped result (null if never chased or outside window)
    const chaseRow = recentChases.find((r) => r.customerId === customer.id);
    const lastChaseAt = chaseRow?.lastChasedAt
      ? new Date(chaseRow.lastChasedAt).toISOString()
      : null;

    candidates.push({
      entityType: "customer",
      entityId: customer.id,
      summary: {
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

  const customerInvoices = await db
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.customerId, entityId), gt(invoices.balance, "0")),
    );

  const sev = computeSeverity(customerRow, customerInvoices);
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

  return true;
}

function cooldownCutoff(): Date {
  return new Date(Date.now() - CHASE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
}
