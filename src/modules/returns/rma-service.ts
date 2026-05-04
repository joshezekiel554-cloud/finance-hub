import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  rmaItems,
  rmas,
  type NewRma,
  type NewRmaItem,
  type Rma,
  type RmaItem,
  type RmaReturnType,
  type RmaStatus,
} from "../../db/schema/returns.js";
import { recordActivity } from "../crm/activity-ingester.js";
import { validateTransition } from "./rma-state.js";
import { buildAndPushCreditMemo } from "./credit-memo-builder.js";

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

// ---------------------------------------------------------------------------
// approveRma
// ---------------------------------------------------------------------------

export type ApproveRmaInput = {
  userId: string;
  overrideThreshold?: boolean;
  overrideReason?: string;
};

export type ApproveRmaResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

function generateDamageRmaNumber(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `DC-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function approveRma(
  id: string,
  input: ApproveRmaInput,
): Promise<ApproveRmaResult | null> {
  const existing = await db.select().from(rmas).where(eq(rmas.id, id));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;
  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "approve",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const rmaNumber = current.returnType === "damage" ? generateDamageRmaNumber() : null;
  const now = new Date();
  await db.update(rmas).set({
    status: "approved",
    approvedAt: now,
    approvedByUserId: input.userId,
    rmaNumber,
    thresholdOverridden: input.overrideThreshold ?? false,
    overrideReason: input.overrideReason ?? null,
    overrideByUserId: input.overrideThreshold ? input.userId : null,
  }).where(eq(rmas.id, id));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_approved",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// denyRma
// ---------------------------------------------------------------------------

export type DenyRmaInput = {
  userId: string;
  reason: string;
};

export type DenyRmaResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function denyRma(
  id: string,
  input: DenyRmaInput,
): Promise<DenyRmaResult | null> {
  const existing = await db.select().from(rmas).where(eq(rmas.id, id));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;
  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "deny",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const now = new Date();
  await db.update(rmas).set({
    status: "denied",
    deniedAt: now,
    denialReason: input.reason,
  }).where(eq(rmas.id, id));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_denied",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// issueCreditMemo
// ---------------------------------------------------------------------------

export type IssueCreditMemoInput = {
  userId: string;
  shippingDeduction?: string | null;
  restockingFee?: string | null;
  itemOverrides?: { itemId: string; receivedQuantity: string }[];
};

export type IssueCreditMemoResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function issueCreditMemo(
  id: string,
  input: IssueCreditMemoInput,
): Promise<IssueCreditMemoResult | null> {
  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, id));
  if (rmaRows.length === 0) return null;
  const current = rmaRows[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "issue_credit_memo",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const items = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, id))) as RmaItem[];

  const itemsForCm = items.map((item) => {
    const override = input.itemOverrides?.find((o) => o.itemId === item.id);
    return override ? { ...item, receivedQuantity: override.receivedQuantity } : item;
  });

  const cmResult = await buildAndPushCreditMemo({
    rma: current,
    items: itemsForCm,
    shippingDeduction: input.shippingDeduction ?? null,
    restockingFee: input.restockingFee ?? null,
  });

  const now = new Date();
  await db
    .update(rmas)
    .set({
      status: "completed",
      completedAt: now,
      qboCreditMemoId: cmResult.qboCreditMemoId,
      creditMemoDocNumber: cmResult.docNumber,
      shippingDeductionAmount: input.shippingDeduction ?? null,
      restockingFeeAmount: input.restockingFee ?? null,
    })
    .where(eq(rmas.id, id));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_credit_memo_issued",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
      meta: { creditMemoDocNumber: cmResult.docNumber },
    },
    db,
  );

  const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updatedRows[0] as Rma };
}

// ---------------------------------------------------------------------------
// markReplacementSent
// ---------------------------------------------------------------------------

export type MarkReplacementSentInput = {
  userId: string;
};

export type MarkReplacementSentResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function markReplacementSent(
  id: string,
  input: MarkReplacementSentInput,
): Promise<MarkReplacementSentResult | null> {
  const existing = await db.select().from(rmas).where(eq(rmas.id, id));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "mark_replacement_sent",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const now = new Date();
  await db
    .update(rmas)
    .set({
      status: "completed",
      completedAt: now,
      resolutionType: "replacement",
    })
    .where(eq(rmas.id, id));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_completed",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
      meta: { resolutionType: "replacement" },
    },
    db,
  );

  const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updatedRows[0] as Rma };
}
