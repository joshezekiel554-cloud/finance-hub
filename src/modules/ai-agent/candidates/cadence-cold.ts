import { and, desc, eq, gt, isNull, max, or, sql } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { customers } from "../../../db/schema/customers.js";
import { activities, emailLog } from "../../../db/schema/crm.js";

export type Candidate = {
  entityType: "customer";
  entityId: string;
  summary: Record<string, unknown>;
};

const DAYS_MS = 24 * 60 * 60 * 1000;
const PAYMENT_STALE_DAYS = 45;
const CONTACT_STALE_DAYS = 21;
const NEVER_DAYS = 99999;

function msSince(date: Date | null | undefined): number {
  if (!date) return NEVER_DAYS * DAYS_MS;
  return Date.now() - date.getTime();
}

function daysSince(date: Date | null | undefined): number {
  return Math.floor(msSince(date) / DAYS_MS);
}

async function queryCandidates(customerId?: string): Promise<Candidate[]> {
  const lastPaymentSq = db
    .select({
      customerId: activities.customerId,
      lastPayment: max(activities.occurredAt).as("last_payment"),
    })
    .from(activities)
    .where(
      and(
        eq(activities.kind, "qbo_payment"),
        customerId ? eq(activities.customerId, customerId) : undefined,
      ),
    )
    .groupBy(activities.customerId)
    .as("last_payment_sq");

  const lastContactSq = db
    .select({
      customerId: emailLog.customerId,
      lastContact: max(emailLog.emailDate).as("last_contact"),
    })
    .from(emailLog)
    .where(customerId ? eq(emailLog.customerId, customerId) : undefined)
    .groupBy(emailLog.customerId)
    .as("last_contact_sq");

  const paymentCutoff = new Date(Date.now() - PAYMENT_STALE_DAYS * DAYS_MS);
  const contactCutoff = new Date(Date.now() - CONTACT_STALE_DAYS * DAYS_MS);

  const rows = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      overdueBalance: customers.overdueBalance,
      lastPayment: lastPaymentSq.lastPayment,
      lastContact: lastContactSq.lastContact,
    })
    .from(customers)
    .leftJoin(lastPaymentSq, eq(customers.id, lastPaymentSq.customerId))
    .leftJoin(lastContactSq, eq(customers.id, lastContactSq.customerId))
    .where(
      and(
        eq(customers.agentModeExcluded, false),
        gt(customers.overdueBalance, sql`0`),
        or(
          isNull(lastPaymentSq.lastPayment),
          sql`${lastPaymentSq.lastPayment} < ${paymentCutoff}`,
        ),
        or(
          isNull(lastContactSq.lastContact),
          sql`${lastContactSq.lastContact} < ${contactCutoff}`,
        ),
        customerId ? eq(customers.id, customerId) : undefined,
      ),
    );

  return rows.map((row) => ({
    entityType: "customer" as const,
    entityId: row.id,
    summary: {
      customerName: row.displayName,
      openBalance: parseFloat(row.overdueBalance ?? "0"),
      daysSinceLastPayment: daysSince(row.lastPayment ?? undefined),
      daysSinceLastContact: daysSince(row.lastContact ?? undefined),
    },
  }));
}

export async function findCandidates(): Promise<Candidate[]> {
  return queryCandidates();
}

export async function isStillEligible(entityId: string): Promise<boolean> {
  const results = await queryCandidates(entityId);
  return results.length > 0;
}
