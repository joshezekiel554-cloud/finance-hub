import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  rmaItems,
  rmas,
  type NewRma,
  type Rma,
  type RmaItem,
  type RmaReturnType,
  type RmaStatus,
} from "../../db/schema/returns.js";
import { recordActivity } from "../crm/activity-ingester.js";

// ---------------------------------------------------------------------------
// createRma
// ---------------------------------------------------------------------------

export type CreateRmaInput = {
  customerId: string;
  qbCustomerId: string;
  returnType: RmaReturnType;
  createdByUserId: string;
  seasonId?: string | null;
  notes?: string | null;
  originalEmail?: string | null;
};

export async function createRma(input: CreateRmaInput): Promise<Rma> {
  const id = nanoid(24);
  const row: NewRma = {
    id,
    customerId: input.customerId,
    qbCustomerId: input.qbCustomerId,
    returnType: input.returnType,
    status: "draft",
    seasonId: input.seasonId ?? null,
    notes: input.notes ?? null,
    originalEmail: input.originalEmail ?? null,
    totalValue: "0",
    thresholdOverridden: false,
    createdViaReceipt: false,
    createdByUserId: input.createdByUserId,
  };
  await db.insert(rmas).values(row);
  await recordActivity(
    {
      customerId: input.customerId,
      kind: "rma_created",
      source: "user_action",
      userId: input.createdByUserId,
      refType: "rma",
      refId: id,
    },
    db,
  );
  return row as Rma;
}

// ---------------------------------------------------------------------------
// getRmaById
// ---------------------------------------------------------------------------

export type RmaWithItems = Rma & { items: RmaItem[] };

export async function getRmaById(id: string): Promise<RmaWithItems | null> {
  const rows = await db.select().from(rmas).where(eq(rmas.id, id));
  if (rows.length === 0) return null;
  const items = await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, id));
  return { ...(rows[0] as Rma), items: items as RmaItem[] };
}

// ---------------------------------------------------------------------------
// listRmas
// ---------------------------------------------------------------------------

export type ListRmasFilters = {
  status?: RmaStatus;
  type?: RmaReturnType;
  customerId?: string;
  q?: string;
  limit?: number;
};

export async function listRmas(filters: ListRmasFilters): Promise<Rma[]> {
  const wheres: SQL[] = [];
  if (filters.status) wheres.push(eq(rmas.status, filters.status));
  if (filters.type) wheres.push(eq(rmas.returnType, filters.type));
  if (filters.customerId) wheres.push(eq(rmas.customerId, filters.customerId));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    const orClause = or(like(rmas.rmaNumber, pattern), like(rmas.notes, pattern));
    if (orClause) wheres.push(orClause);
  }
  const where = wheres.length ? and(...wheres) : undefined;
  const limit = filters.limit ?? 200;
  return db
    .select()
    .from(rmas)
    .where(where as SQL | undefined)
    .orderBy(desc(rmas.createdAt))
    .limit(limit) as unknown as Promise<Rma[]>;
}

// ---------------------------------------------------------------------------
// updateRma
// ---------------------------------------------------------------------------

const EDITABLE_STATUSES: RmaStatus[] = ["draft"];

export type UpdateRmaInput = {
  notes?: string | null;
  totalValue?: string;
};

export async function updateRma(
  id: string,
  patch: UpdateRmaInput,
): Promise<Rma | null> {
  const existing = await db.select().from(rmas).where(eq(rmas.id, id));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;
  if (!EDITABLE_STATUSES.includes(current.status)) {
    throw new Error(
      `Cannot edit RMA in "${current.status}" status — only ${EDITABLE_STATUSES.join(", ")} are editable`,
    );
  }
  await db.update(rmas).set(patch).where(eq(rmas.id, id));
  const updated = await db.select().from(rmas).where(eq(rmas.id, id));
  return (updated[0] ?? null) as Rma | null;
}
