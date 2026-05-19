import { and, eq, inArray, lt, or } from "drizzle-orm";
import type { RmaStatus } from "../../../db/schema/returns.js";
import { db } from "../../../db/index.js";
import { rmas } from "../../../db/schema/returns.js";
import { customers } from "../../../db/schema/customers.js";

export type Candidate = {
  entityType: "rma";
  entityId: string;
  summary: Record<string, unknown>;
};

const STALLED_STATUSES = [
  "draft",
  "approved",
  "awaiting_warehouse_number",
  "sent_to_warehouse",
  "received",
] as const;

const STALE_THRESHOLD_DAYS = 14;

function cutoffDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - STALE_THRESHOLD_DAYS);
  return d;
}

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

export async function findCandidates(): Promise<Candidate[]> {
  const cutoff = cutoffDate();

  const rows = await db
    .select({
      id: rmas.id,
      rmaNumber: rmas.rmaNumber,
      status: rmas.status,
      updatedAt: rmas.updatedAt,
      sentToWarehouseAt: rmas.sentToWarehouseAt,
      receivedAtWarehouseAt: rmas.receivedAtWarehouseAt,
      customerName: customers.displayName,
    })
    .from(rmas)
    .innerJoin(customers, eq(rmas.customerId, customers.id))
    .where(
      and(
        inArray(rmas.status, [...STALLED_STATUSES] as RmaStatus[]),
        eq(customers.agentModeExcluded, false),
        or(
          // sent_to_warehouse: gate on sentToWarehouseAt
          and(
            eq(rmas.status, "sent_to_warehouse"),
            lt(rmas.sentToWarehouseAt, cutoff),
          ),
          // received: gate on receivedAtWarehouseAt
          and(
            eq(rmas.status, "received"),
            lt(rmas.receivedAtWarehouseAt, cutoff),
          ),
          // all others: gate on updatedAt
          and(
            inArray(rmas.status, ["draft", "approved", "awaiting_warehouse_number"] as RmaStatus[]),
            lt(rmas.updatedAt, cutoff),
          ),
        ),
      ),
    );

  return rows.map((row) => {
    const stateTs =
      row.status === "sent_to_warehouse"
        ? row.sentToWarehouseAt
        : row.status === "received"
          ? row.receivedAtWarehouseAt
          : row.updatedAt;

    return {
      entityType: "rma",
      entityId: row.id,
      summary: {
        rmaNumber: row.rmaNumber ?? row.id,
        customerName: row.customerName,
        status: row.status,
        daysInState: daysAgo(stateTs!),
      },
    };
  });
}

export async function isStillEligible(rmaId: string): Promise<boolean> {
  const cutoff = cutoffDate();

  const rows = await db
    .select({
      id: rmas.id,
      status: rmas.status,
      updatedAt: rmas.updatedAt,
      sentToWarehouseAt: rmas.sentToWarehouseAt,
      receivedAtWarehouseAt: rmas.receivedAtWarehouseAt,
      agentModeExcluded: customers.agentModeExcluded,
    })
    .from(rmas)
    .innerJoin(customers, eq(rmas.customerId, customers.id))
    .where(eq(rmas.id, rmaId))
    .limit(1);

  const row = rows[0];
  if (!row) return false;
  if (row.agentModeExcluded) return false;
  if (!STALLED_STATUSES.includes(row.status as (typeof STALLED_STATUSES)[number])) return false;

  if (row.status === "sent_to_warehouse") {
    return row.sentToWarehouseAt != null && row.sentToWarehouseAt < cutoff;
  }
  if (row.status === "received") {
    return row.receivedAtWarehouseAt != null && row.receivedAtWarehouseAt < cutoff;
  }
  return row.updatedAt < cutoff;
}
