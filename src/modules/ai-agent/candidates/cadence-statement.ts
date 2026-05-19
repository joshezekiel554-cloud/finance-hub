import { and, count, eq, gt, isNull, lt, max, or, sql, sum } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { customers } from "../../../db/schema/customers.js";
import { invoices } from "../../../db/schema/invoices.js";
import { statementSends } from "../../../db/schema/crm.js";

export type Candidate = {
  entityType: "customer";
  entityId: string;
  summary: Record<string, unknown>;
};

const STATEMENT_CADENCE_DAYS = 30;
const LARGE_DAYS = 9999;

export async function findCandidates(): Promise<Candidate[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STATEMENT_CADENCE_DAYS);

  const rows = await db
    .select({
      customerId: customers.id,
      customerName: customers.displayName,
      openInvoiceCount: count(invoices.id),
      totalOpenBalance: sum(invoices.balance),
      lastStatementSentAt: max(statementSends.sentAt),
    })
    .from(customers)
    .innerJoin(
      invoices,
      and(eq(invoices.customerId, customers.id), gt(invoices.balance, sql`0`)),
    )
    .leftJoin(statementSends, eq(statementSends.customerId, customers.id))
    .where(eq(customers.agentModeExcluded, false))
    .groupBy(customers.id, customers.displayName)
    .having(
      or(
        isNull(max(statementSends.sentAt)),
        lt(max(statementSends.sentAt), cutoff),
      ),
    );

  return rows.map((row) => {
    const lastSentAt = row.lastStatementSentAt ?? null;
    const daysSinceLastStatement = lastSentAt
      ? Math.floor(
          (Date.now() - new Date(lastSentAt).getTime()) / (1000 * 60 * 60 * 24),
        )
      : LARGE_DAYS;

    return {
      entityType: "customer",
      entityId: row.customerId,
      summary: {
        customerName: row.customerName,
        openInvoiceCount: Number(row.openInvoiceCount),
        totalOpenBalance: Number(row.totalOpenBalance ?? 0),
        lastStatementSentAt: lastSentAt
          ? new Date(lastSentAt).toISOString()
          : null,
        daysSinceLastStatement,
      },
    };
  });
}

export async function isStillEligible(entityId: string): Promise<boolean> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STATEMENT_CADENCE_DAYS);

  const [row] = await db
    .select({
      openInvoiceCount: count(invoices.id),
      lastStatementSentAt: max(statementSends.sentAt),
      agentModeExcluded: customers.agentModeExcluded,
    })
    .from(customers)
    .leftJoin(
      invoices,
      and(eq(invoices.customerId, customers.id), gt(invoices.balance, sql`0`)),
    )
    .leftJoin(statementSends, eq(statementSends.customerId, customers.id))
    .where(eq(customers.id, entityId))
    .groupBy(customers.id, customers.agentModeExcluded);

  if (!row) return false;
  if (row.agentModeExcluded) return false;
  if (Number(row.openInvoiceCount) === 0) return false;

  const lastSent = row.lastStatementSentAt;
  if (lastSent && new Date(lastSent) >= cutoff) return false;

  return true;
}
