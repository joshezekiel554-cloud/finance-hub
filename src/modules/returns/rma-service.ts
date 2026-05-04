import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  rmaItems,
  rmas,
  seasons,
  type NewRma,
  type NewRmaItem,
  type Rma,
  type RmaItem,
  type RmaReturnType,
  type RmaStatus,
} from "../../db/schema/returns.js";
import { customers } from "../../db/schema/customers.js";
import { recordActivity } from "../crm/activity-ingester.js";
import { validateTransition } from "./rma-state.js";
import { buildAndPushCreditMemo } from "./credit-memo-builder.js";
import { runEligibility } from "./eligibility.js";
import { generateEligibilityPdf } from "./eligibility-pdf.js";
import { buildExtensivExportFile } from "./extensiv-export.js";

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
  | { ok: false; reason: string; eligibilityBreakdown?: import("./eligibility.js").EligibilityBreakdown };

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

  // For damage: allocate DC-... rma number immediately.
  // For seasonal/non-seasonal: rmaNumber stays null until set_warehouse_number.
  const rmaNumber = current.returnType === "damage" ? generateDamageRmaNumber() : null;

  // --- Eligibility check for seasonal / non-seasonal ---
  let eligibilityPatch: {
    eligibilityDetails?: unknown;
    eligibleAmount?: string | null;
    returnPercentage?: string | null;
    thresholdOverridden?: boolean;
    overrideReason?: string | null;
    overrideByUserId?: string | null;
  } = {};

  if (current.returnType !== "damage") {
    if (!current.seasonId) {
      return { ok: false, reason: "RMA has no season — cannot compute eligibility" };
    }

    // Fetch items for this RMA
    const itemRows = (await db
      .select()
      .from(rmaItems)
      .where(eq(rmaItems.rmaId, id))) as RmaItem[];

    const breakdown = await runEligibility({
      customerId: current.customerId,
      qbCustomerId: current.qbCustomerId ?? "",
      seasonId: current.seasonId,
      proposedItems: itemRows.map((item) => ({
        lineTotal: item.lineTotal,
        classification: item.classification,
      })),
      excludeRmaId: id,
    });

    // For non-seasonal: eligibility runs informationally — never gates approval.
    // For seasonal: gate on threshold, allow override.
    if (current.returnType === "seasonal" && !breakdown.passesThreshold) {
      if (!input.overrideThreshold) {
        return {
          ok: false,
          reason: "Over threshold — provide override or deny",
          eligibilityBreakdown: breakdown,
        } as ApproveRmaResult;
      }
      if (!input.overrideReason) {
        return {
          ok: false,
          reason: "Override reason required",
          eligibilityBreakdown: breakdown,
        } as ApproveRmaResult;
      }
    }

    eligibilityPatch = {
      eligibilityDetails: breakdown,
      eligibleAmount: breakdown.proposedSubtotalCountingTowardThreshold,
      returnPercentage: breakdown.cumulativeReturnPct,
      thresholdOverridden: input.overrideThreshold ?? false,
      overrideReason: input.overrideReason ?? null,
      overrideByUserId: input.overrideThreshold ? input.userId : null,
    };
  }

  const now = new Date();
  await db.update(rmas).set({
    status: "approved",
    approvedAt: now,
    approvedByUserId: input.userId,
    rmaNumber,
    thresholdOverridden: eligibilityPatch.thresholdOverridden ?? (input.overrideThreshold ?? false),
    overrideReason: eligibilityPatch.overrideReason ?? (input.overrideReason ?? null),
    overrideByUserId: eligibilityPatch.overrideByUserId ?? (input.overrideThreshold ? input.userId : null),
    ...(eligibilityPatch.eligibilityDetails !== undefined
      ? {
          eligibilityDetails: eligibilityPatch.eligibilityDetails,
          eligibleAmount: eligibilityPatch.eligibleAmount,
          returnPercentage: eligibilityPatch.returnPercentage,
        }
      : {}),
  }).where(eq(rmas.id, id));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_approved",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
      meta: input.overrideThreshold ? { thresholdOverridden: true } : undefined,
    },
    db,
  );

  // If a Drive folder exists (photos were uploaded pre-approval), rename it
  // from "RMA-{id}" to the newly allocated rmaNumber.
  // Note: for the seasonal flow, apply the same pattern at
  // set_warehouse_number when the warehouse RMA number is allocated.
  if (current.driveFolderId && rmaNumber) {
    try {
      const { renameFolder } = await import("../../integrations/google-drive/client.js");
      await renameFolder({
        userId: input.userId,
        folderId: current.driveFolderId,
        newName: rmaNumber,
      });
    } catch (err) {
      // Don't fail the whole approval if folder rename fails — log + continue.
      console.error("[approveRma] Drive folder rename failed:", err);
    }
  }

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

  // For seasonal RMAs: generate eligibility PDF and save to Drive (best-effort).
  let denialPdfDriveId: string | null = null;
  if (current.returnType === "seasonal" && current.seasonId) {
    try {
      const itemRows = (await db
        .select()
        .from(rmaItems)
        .where(eq(rmaItems.rmaId, id))) as RmaItem[];

      const breakdown = await runEligibility({
        customerId: current.customerId,
        qbCustomerId: current.qbCustomerId ?? "",
        seasonId: current.seasonId,
        proposedItems: itemRows.map((item) => ({
          lineTotal: item.lineTotal,
          classification: item.classification,
        })),
        // Don't exclude the RMA being denied — it's still being evaluated
      });

      // Fetch customer name for PDF
      const customerRows = await db
        .select({ displayName: customers.displayName })
        .from(customers)
        .where(eq(customers.id, current.customerId));
      const customerName = customerRows[0]?.displayName ?? "Customer";

      // Fetch season name for PDF
      const seasonRows = await db
        .select({ name: seasons.name })
        .from(seasons)
        .where(eq(seasons.id, current.seasonId));
      const seasonName = seasonRows[0]?.name ?? "Season";

      const pdfBuffer = await generateEligibilityPdf({
        rma: { id: current.id, rmaNumber: current.rmaNumber ?? null },
        customer: { name: customerName },
        season: { name: seasonName },
        breakdown,
        items: itemRows.map((item) => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          classification: item.classification,
          priorSeasonId: item.priorSeasonId,
        })),
      });

      // Upload to Drive — best-effort, catch errors
      const { uploadFile } = await import("../../integrations/google-drive/client.js");
      const now2 = new Date();
      const dateStr = `${now2.getFullYear()}${String(now2.getMonth() + 1).padStart(2, "0")}${String(now2.getDate()).padStart(2, "0")}`;
      const driveFolderId = current.driveFolderId;
      if (driveFolderId) {
        const uploadResult = await uploadFile({
          userId: input.userId,
          folderId: driveFolderId,
          filename: `denial-${id}-${dateStr}.pdf`,
          mimeType: "application/pdf",
          content: pdfBuffer,
        });
        denialPdfDriveId = uploadResult.fileId;
      }
    } catch (err) {
      // Don't fail the denial if PDF generation or Drive upload fails
      console.error("[denyRma] Eligibility PDF generation/upload failed:", err);
    }
  }

  const now = new Date();
  await db.update(rmas).set({
    status: "denied",
    deniedAt: now,
    denialReason: input.reason,
    ...(denialPdfDriveId ? { denialPdfDriveId } : {}),
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
// generateWarehouseExport
// ---------------------------------------------------------------------------

export type GenerateWarehouseExportInput = {
  rmaId: string;
  userId: string;
};

export type GenerateWarehouseExportResult =
  | { ok: true; rma: Rma; exportFile: { filename: string; content: string } }
  | { ok: false; reason: string };

export async function generateWarehouseExport(
  input: GenerateWarehouseExportInput,
): Promise<GenerateWarehouseExportResult | null> {
  const { rmaId, userId } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "generate_warehouse_export",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  // Fetch items
  const itemRows = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, rmaId))) as RmaItem[];

  // Fetch customer
  const customerRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, current.customerId))
    .limit(1);
  const customerRow = customerRows[0];
  const customerName = customerRow?.displayName ?? "Customer";

  // Fetch season
  let seasonName = "";
  if (current.seasonId) {
    const seasonRows = await db
      .select({ name: seasons.name })
      .from(seasons)
      .where(eq(seasons.id, current.seasonId));
    seasonName = seasonRows[0]?.name ?? "";
  }

  // Build extensiv ref: "{customerName} {seasonName} returns"
  const extensivRef = [customerName, seasonName, "returns"]
    .filter(Boolean)
    .join(" ");

  const exportFile = buildExtensivExportFile({
    rma: { rmaNumber: current.rmaNumber ?? null, extensivRef },
    customer: {
      name: customerName,
      qbCustomerId: current.qbCustomerId ?? "",
    },
    season: { name: seasonName },
    items: itemRows.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
    })),
  });

  const now = new Date();
  await db.update(rmas).set({
    status: "awaiting_warehouse_number",
    extensivRef,
    extensivExportGeneratedAt: now,
  }).where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_warehouse_export_generated",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma, exportFile };
}

// ---------------------------------------------------------------------------
// cancelWarehouseExport
// ---------------------------------------------------------------------------

export type CancelWarehouseExportInput = {
  rmaId: string;
  userId: string;
};

export type CancelWarehouseExportResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function cancelWarehouseExport(
  input: CancelWarehouseExportInput,
): Promise<CancelWarehouseExportResult | null> {
  const { rmaId, userId } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "cancel_warehouse_export",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  await db.update(rmas).set({
    status: "approved",
    extensivExportGeneratedAt: null,
  }).where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_warehouse_export_cancelled",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// setWarehouseNumber
// ---------------------------------------------------------------------------

export type SetWarehouseNumberInput = {
  rmaId: string;
  userId: string;
  txNumber: string;
};

export type SetWarehouseNumberResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function setWarehouseNumber(
  input: SetWarehouseNumberInput,
): Promise<SetWarehouseNumberResult | null> {
  const { rmaId, userId, txNumber } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "set_warehouse_number",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const now = new Date();
  await db.update(rmas).set({
    status: "sent_to_warehouse",
    rmaNumber: txNumber,
    extensivTxNumber: txNumber,
    sentToWarehouseAt: now,
  }).where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_sent_to_warehouse",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
      meta: { txNumber },
    },
    db,
  );

  // If a Drive folder exists, rename it to the warehouse tx number.
  if (current.driveFolderId) {
    try {
      const { renameFolder } = await import("../../integrations/google-drive/client.js");
      await renameFolder({
        userId,
        folderId: current.driveFolderId,
        newName: txNumber,
      });
    } catch (err) {
      console.error("[setWarehouseNumber] Drive folder rename failed:", err);
    }
  }

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// manualMarkReceived
// ---------------------------------------------------------------------------

export type ManualMarkReceivedInput = {
  rmaId: string;
  userId: string;
};

export type ManualMarkReceivedResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function manualMarkReceived(
  input: ManualMarkReceivedInput,
): Promise<ManualMarkReceivedResult | null> {
  const { rmaId, userId } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "mark_received",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const now = new Date();
  await db.update(rmas).set({
    status: "received",
    receivedAtWarehouseAt: now,
  }).where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_received_at_warehouse",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
      meta: { source: "manual" },
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// overrideApproveRma
// ---------------------------------------------------------------------------

export type OverrideApproveRmaInput = {
  rmaId: string;
  userId: string;
  reason: string;
};

export type OverrideApproveRmaResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function overrideApproveRma(
  input: OverrideApproveRmaInput,
): Promise<OverrideApproveRmaResult | null> {
  const { rmaId, userId, reason } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "override_approve",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  // deniedAt + denialReason preserved as history. Denial PDF stays attached.
  await db.update(rmas).set({
    status: "approved",
    thresholdOverridden: true,
    overrideReason: reason,
    overrideByUserId: userId,
  }).where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_override_approved",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
      meta: { reason },
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
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

// ---------------------------------------------------------------------------
// Shared helper: recompute RMA totalValue from items
// ---------------------------------------------------------------------------

async function recomputeTotalValue(rmaId: string): Promise<void> {
  const items = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, rmaId))) as RmaItem[];
  const total = items
    .reduce((sum, item) => sum + parseFloat(item.lineTotal), 0)
    .toFixed(2);
  await db.update(rmas).set({ totalValue: total }).where(eq(rmas.id, rmaId));
}

// ---------------------------------------------------------------------------
// addRmaItem
// ---------------------------------------------------------------------------

export type AddRmaItemInput = {
  qbItemId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  classification: RmaItem["classification"];
  listUnitPrice?: string | null;
  invoiceDiscountPct?: string | null;
  reason?: string | null;
  originalInvoiceDocNumber?: string | null;
  /** YYYY-MM-DD string or Date — stored as MySQL DATE */
  originalInvoiceDate?: Date | string | null;
  priorSeasonId?: string | null;
  priorSeasonOverrideReason?: string | null;
};

export async function addRmaItem(
  rmaId: string,
  input: AddRmaItemInput,
): Promise<RmaWithItems> {
  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (rmaRows.length === 0) throw new Error(`RMA not found: ${rmaId}`);
  const current = rmaRows[0] as Rma;
  if (current.status !== "draft") {
    throw new Error(
      `Cannot add items to RMA in "${current.status}" status — only draft is editable`,
    );
  }

  const existingItems = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, rmaId))) as RmaItem[];

  const maxPosition = existingItems.reduce(
    (max, item) => Math.max(max, item.position),
    -1,
  );
  const position = maxPosition + 1;

  const qty = parseFloat(input.quantity);
  const price = parseFloat(input.unitPrice);
  const lineTotal = (qty * price).toFixed(2);

  const newItem: NewRmaItem = {
    id: nanoid(24),
    rmaId,
    position,
    qbItemId: input.qbItemId,
    sku: input.sku,
    name: input.name,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    lineTotal,
    classification: input.classification,
    listUnitPrice: input.listUnitPrice ?? null,
    invoiceDiscountPct: input.invoiceDiscountPct ?? null,
    reason: input.reason ?? null,
    originalInvoiceDocNumber: input.originalInvoiceDocNumber ?? null,
    originalInvoiceDate: (input.originalInvoiceDate ?? null) as Date | null,
    priorSeasonId: input.priorSeasonId ?? null,
    priorSeasonOverrideReason: input.priorSeasonOverrideReason ?? null,
  };

  await db.insert(rmaItems).values(newItem);
  await recomputeTotalValue(rmaId);

  const updatedRmaRows = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  const updatedItems = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, rmaId))) as RmaItem[];

  return { ...(updatedRmaRows[0] as Rma), items: updatedItems };
}

// ---------------------------------------------------------------------------
// updateRmaItem
// ---------------------------------------------------------------------------

export type UpdateRmaItemInput = {
  quantity?: string;
  unitPrice?: string;
  listUnitPrice?: string | null;
  invoiceDiscountPct?: string | null;
  reason?: string | null;
  originalInvoiceDocNumber?: string | null;
  /** YYYY-MM-DD string or Date — stored as MySQL DATE */
  originalInvoiceDate?: Date | string | null;
  priorSeasonId?: string | null;
  priorSeasonOverrideReason?: string | null;
  classification?: RmaItem["classification"];
};

export async function updateRmaItem(
  itemId: string,
  patch: UpdateRmaItemInput,
): Promise<RmaWithItems | null> {
  const itemRows = await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.id, itemId));
  if (itemRows.length === 0) return null;
  const item = itemRows[0] as RmaItem;

  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, item.rmaId));
  if (rmaRows.length === 0) return null;
  const rma = rmaRows[0] as Rma;
  if (rma.status !== "draft") {
    throw new Error(
      `Cannot update items on RMA in "${rma.status}" status — only draft is editable`,
    );
  }

  // Recalculate lineTotal if quantity or unitPrice changed
  const newQty = patch.quantity ?? item.quantity;
  const newPrice = patch.unitPrice ?? item.unitPrice;
  const lineTotal = (parseFloat(newQty) * parseFloat(newPrice)).toFixed(2);

  const setPatch = {
    ...patch,
    lineTotal,
    originalInvoiceDate: (patch.originalInvoiceDate ?? undefined) as Date | null | undefined,
  };
  await db
    .update(rmaItems)
    .set(setPatch)
    .where(eq(rmaItems.id, itemId));

  await recomputeTotalValue(item.rmaId);

  const updatedRmaRows = await db
    .select()
    .from(rmas)
    .where(eq(rmas.id, item.rmaId));
  const updatedItems = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, item.rmaId))) as RmaItem[];

  return { ...(updatedRmaRows[0] as Rma), items: updatedItems };
}

// ---------------------------------------------------------------------------
// removeRmaItem
// ---------------------------------------------------------------------------

export async function removeRmaItem(itemId: string): Promise<RmaWithItems | null> {
  const itemRows = await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.id, itemId));
  if (itemRows.length === 0) return null;
  const item = itemRows[0] as RmaItem;

  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, item.rmaId));
  if (rmaRows.length === 0) return null;
  const rma = rmaRows[0] as Rma;
  if (rma.status !== "draft") {
    throw new Error(
      `Cannot remove items from RMA in "${rma.status}" status — only draft is editable`,
    );
  }

  await db.delete(rmaItems).where(eq(rmaItems.id, itemId));
  await recomputeTotalValue(item.rmaId);

  const updatedRmaRows = await db
    .select()
    .from(rmas)
    .where(eq(rmas.id, item.rmaId));
  const updatedItems = (await db
    .select()
    .from(rmaItems)
    .where(eq(rmaItems.rmaId, item.rmaId))) as RmaItem[];

  return { ...(updatedRmaRows[0] as Rma), items: updatedItems };
}
