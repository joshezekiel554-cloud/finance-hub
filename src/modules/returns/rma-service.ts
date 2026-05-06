import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  extensivReceipts,
  rmaItems,
  rmaPhotos,
  rmas,
  seasons,
  type ExtensivReceipt,
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
  // 0-based offset for pagination. Once an org has more than `limit` RMAs the
  // list silently truncates without one — operators can't reach older rows.
  offset?: number;
};

// List rows include the customer's display name as a denormalised field so
// the returns list page can render it without a per-row roundtrip. Search (q)
// matches RMA number, notes, OR customer name so operators can search by
// either RMA # or "yiddy" / customer name without switching modes.
export type RmaListRow = Rma & {
  customerDisplayName: string | null;
};

export async function listRmas(
  filters: ListRmasFilters,
): Promise<RmaListRow[]> {
  const wheres: SQL[] = [];
  if (filters.status) wheres.push(eq(rmas.status, filters.status));
  if (filters.type) wheres.push(eq(rmas.returnType, filters.type));
  if (filters.customerId) wheres.push(eq(rmas.customerId, filters.customerId));
  if (filters.q) {
    const pattern = `%${filters.q}%`;
    const orClause = or(
      like(rmas.rmaNumber, pattern),
      like(rmas.notes, pattern),
      like(customers.displayName, pattern),
    );
    if (orClause) wheres.push(orClause);
  }
  const where = wheres.length ? and(...wheres) : undefined;
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  const rows = await db
    .select({
      rma: rmas,
      customerDisplayName: customers.displayName,
    })
    .from(rmas)
    .leftJoin(customers, eq(customers.id, rmas.customerId))
    .where(where as SQL | undefined)
    .orderBy(desc(rmas.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    ...(r.rma as Rma),
    customerDisplayName: r.customerDisplayName ?? null,
  }));
}

// ---------------------------------------------------------------------------
// updateRma
// ---------------------------------------------------------------------------

const EDITABLE_STATUSES: RmaStatus[] = ["draft"];

export type UpdateRmaInput = {
  notes?: string | null;
  totalValue?: string;
  // Allow patching seasonId on draft RMAs — this covers the case where an
  // RMA was created (or imported) without a season and the operator picks
  // one mid-wizard. Eligibility checks gate on rma.seasonId so this MUST
  // land in the DB before approve fires, not just in the wizard's local
  // state.
  seasonId?: string | null;
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

  // Eligibility only applies to seasonal RMAs (the threshold check is keyed on
  // a season). Non-seasonal and damage approve without a season + without an
  // eligibility computation.
  if (current.returnType === "seasonal") {
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

    if (!breakdown.passesThreshold) {
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
// cancelRma — transitions to `cancelled` from approved / awaiting_warehouse_number / sent_to_warehouse
// ---------------------------------------------------------------------------

export type CancelRmaInput = {
  rmaId: string;
  userId: string;
  reason?: string | null;
};

export type CancelRmaResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function cancelRma(
  input: CancelRmaInput,
): Promise<CancelRmaResult | null> {
  const { rmaId, userId, reason } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "cancel",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  await db
    .update(rmas)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      notes: reason ? `${current.notes ?? ""}\n[cancelled: ${reason}]`.trim() : current.notes,
    })
    .where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_cancelled",
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
      meta: reason ? { reason } : undefined,
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
  // Sales tax. When applyTax is true we mirror the source invoice's tax
  // code onto the QBO credit memo — QBO computes the actual tax amount.
  // The frontend pulls the default + taxCodeRef from the source-invoice-tax
  // lookup so the operator only ticks/unticks one box.
  applyTax?: boolean;
  taxCodeRef?: string | null;
};

export type IssueCreditMemoResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function issueCreditMemo(
  id: string,
  input: IssueCreditMemoInput,
): Promise<IssueCreditMemoResult | null> {
  // Whole flow runs in a transaction with FOR UPDATE on the rma row.
  // Two operators clicking "Issue CM" in different tabs would otherwise
  // both pass the transition check (RMA in `received`), both call QBO,
  // and the customer ends up with two credit memos for one return. The
  // lock + post-lock qboCreditMemoId guard ensures only the first call
  // creates a CM; concurrent retries see the populated qboCreditMemoId
  // and abort with "already issued."
  //
  // The QBO API call runs inside the transaction so the lock is held
  // until the local DB write commits. If QBO succeeds and the local
  // commit fails (rare — DB is local), the lock releases and a retry
  // would call QBO again and duplicate. Acceptable trade for a small-
  // team app where DB-commit-after-QBO-success failure is vanishingly
  // rare; a stricter-grade fix would be a pre-flight QBO lookup by
  // rmaNumber/DocNumber before create, accepting an extra round trip.
  //
  // Activity recording happens post-commit (recordActivity opens its
  // own internal tx, so we'd be nesting otherwise). This matches the
  // pattern Agent D used for confirmExtensivReceipt.
  type IssueResult =
    | {
        ok: true;
        rma: Rma;
        creditMemoDocNumber: string;
        customerIdForActivity: string;
      }
    | { ok: false; reason: string }
    | null;
  const txResult: IssueResult = await db.transaction(async (tx) => {
    const rmaRows = await tx
      .select()
      .from(rmas)
      .where(eq(rmas.id, id))
      .for("update");
    if (rmaRows.length === 0) return null;
    const current = rmaRows[0] as Rma;

    // Idempotency guard — if a CM was already issued, refuse rather
    // than create another one. Operator should refresh the page to see
    // the existing CM.
    if (current.qboCreditMemoId) {
      return {
        ok: false,
        reason: `Credit memo ${current.creditMemoDocNumber ?? current.qboCreditMemoId} already issued for this RMA — refresh the page`,
      };
    }

    const transition = validateTransition({
      currentStatus: current.status,
      returnType: current.returnType,
      action: "issue_credit_memo",
    });
    if (!transition.ok) return { ok: false, reason: transition.reason };

    const items = (await tx
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
      applyTax: input.applyTax ?? false,
      taxCodeRef: input.taxCodeRef ?? null,
    });

    const now = new Date();
    await tx
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

    const updatedRows = await tx.select().from(rmas).where(eq(rmas.id, id));
    return {
      ok: true,
      rma: updatedRows[0] as Rma,
      creditMemoDocNumber: cmResult.docNumber,
      customerIdForActivity: current.customerId,
    };
  });

  if (!txResult || txResult.ok === false) {
    return txResult;
  }

  // Post-commit activity write — only fires when the tx above committed
  // successfully so a rollback won't leave a phantom audit row.
  await recordActivity({
    customerId: txResult.customerIdForActivity,
    kind: "rma_credit_memo_issued",
    source: "user_action",
    userId: input.userId,
    refType: "rma",
    refId: id,
    meta: { creditMemoDocNumber: txResult.creditMemoDocNumber },
  });

  return { ok: true, rma: txResult.rma };
}

// ---------------------------------------------------------------------------
// markAlreadyCredited — reconcile imported RMAs whose desktop status was
// stale (CM was actually issued in QBO; desktop never advanced past
// approved). Looks up the CM by doc number to verify + grab the QBO id,
// then transitions to completed without re-creating anything in QBO.
// ---------------------------------------------------------------------------

export type MarkAlreadyCreditedInput = {
  userId: string;
  creditMemoDocNumber: string;
};

export type MarkAlreadyCreditedResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function markAlreadyCredited(
  id: string,
  input: MarkAlreadyCreditedInput,
): Promise<MarkAlreadyCreditedResult | null> {
  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, id));
  if (rmaRows.length === 0) return null;
  const current = rmaRows[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "mark_already_credited",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  // Don't allow overwriting an existing CM link — operator should explicitly
  // unlink first if they need to change it (rare; not currently exposed).
  if (current.qboCreditMemoId) {
    return {
      ok: false,
      reason: `RMA is already linked to credit memo ${current.creditMemoDocNumber ?? current.qboCreditMemoId}`,
    };
  }

  const docNumber = input.creditMemoDocNumber.trim();
  if (!docNumber) {
    return { ok: false, reason: "Credit memo doc number is required" };
  }

  // Verify the CM actually exists in QBO and grab its internal id so the
  // RMA links to it the same way native CMs do (qboCreditMemoId is what the
  // detail page uses to render the "View CM in QBO" link).
  //
  // Also cross-check that the CM's CustomerRef matches the RMA's customer.
  // Without this, an operator typo (pasting another customer's CM doc#)
  // would silently link an unrelated CM — the RMA would mark "completed"
  // and the wrong customer's CM would appear on the detail page.
  const { QboClient } = await import("../../integrations/qb/client.js");
  const qbo = new QboClient();
  let qboCreditMemoId: string | null = null;
  try {
    const cm = await qbo.getCreditMemoByDocNumber(docNumber);
    if (!cm) {
      return {
        ok: false,
        reason: `Credit memo "${docNumber}" not found in QBO — double-check the doc number`,
      };
    }
    const cmCustomerId = cm.CustomerRef?.value ?? null;
    if (cmCustomerId !== current.qbCustomerId) {
      return {
        ok: false,
        reason: `CM ${docNumber} belongs to a different customer (${cmCustomerId ?? "unknown"} vs ${current.qbCustomerId}) — double-check the doc number`,
      };
    }
    qboCreditMemoId = cm.Id;
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `QBO lookup failed: ${err.message}`
          : "QBO lookup failed",
    };
  }

  const now = new Date();
  await db
    .update(rmas)
    .set({
      status: "completed",
      completedAt: now,
      qboCreditMemoId,
      creditMemoDocNumber: docNumber,
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
      meta: { creditMemoDocNumber: docNumber, reconciledFromImport: true },
    },
    db,
  );

  const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updatedRows[0] as Rma };
}

// ---------------------------------------------------------------------------
// forceStatus — operator override that bypasses the state machine.
// Used to fix imported RMAs whose lifecycle stage drifted from reality
// (e.g. flip an imported "approved" to "sent_to_warehouse" without walking
// through the wizard). Does NOT touch other fields — operator can use
// revert_to_draft if they need to clear workflow side-effects. Records an
// activity entry tagged manualStatusOverride for audit.
// ---------------------------------------------------------------------------

export type ForceStatusInput = {
  userId: string;
  status: RmaStatus;
  reason?: string | null;
};

export type ForceStatusResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function forceStatus(
  id: string,
  input: ForceStatusInput,
): Promise<ForceStatusResult | null> {
  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, id));
  if (rmaRows.length === 0) return null;
  const current = rmaRows[0] as Rma;

  if (current.status === input.status) {
    return { ok: false, reason: `RMA is already in "${input.status}" status` };
  }

  await db.update(rmas).set({ status: input.status }).where(eq(rmas.id, id));

  // Reuse manual_note since there's no dedicated status-change enum value.
  // The meta carries the actual transition for audit purposes.
  await recordActivity(
    {
      customerId: current.customerId,
      kind: "manual_note",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
      meta: {
        kind: "rma_status_override",
        from: current.status,
        to: input.status,
        reason: input.reason ?? null,
      },
    },
    db,
  );

  const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
  return { ok: true, rma: updatedRows[0] as Rma };
}

// ---------------------------------------------------------------------------
// setTracking — record the customer's return tracking number on a
// sent_to_warehouse RMA and, if a warehouse team email is configured,
// notify the warehouse so they expect the parcel.
// ---------------------------------------------------------------------------

export type SetTrackingInput = {
  userId: string;
  trackingNumber: string;
  trackingCarrier?: string | null;
  notes?: string | null;
};

export type SetTrackingResult =
  | { ok: true; rma: Rma; emailedTo: string | null }
  | { ok: false; reason: string };

export async function setTracking(
  id: string,
  input: SetTrackingInput,
): Promise<SetTrackingResult | null> {
  const rmaRows = await db.select().from(rmas).where(eq(rmas.id, id));
  if (rmaRows.length === 0) return null;
  const current = rmaRows[0] as Rma;

  // Tracking only makes sense once the warehouse has been told to expect a
  // return — i.e. status is sent_to_warehouse ("Awaiting return"). For
  // looser enforcement we also accept awaiting_warehouse_number so the
  // operator can record tracking before the warehouse # has been issued.
  if (
    current.status !== "sent_to_warehouse" &&
    current.status !== "awaiting_warehouse_number"
  ) {
    return {
      ok: false,
      reason: `Tracking can only be added when the RMA is awaiting return (current: ${current.status})`,
    };
  }

  const trackingNumber = input.trackingNumber.trim();
  if (!trackingNumber) {
    return { ok: false, reason: "Tracking number is required" };
  }
  const trackingCarrier = input.trackingCarrier?.trim() || null;

  const now = new Date();
  await db
    .update(rmas)
    .set({
      trackingNumber,
      trackingCarrier,
      trackingSavedAt: now,
    })
    .where(eq(rmas.id, id));

  // Fire-and-store activity FIRST so the trail records the change even if
  // the email send below fails (orphaned-tracking-without-email is fine;
  // tracking-without-record is not).
  await recordActivity(
    {
      customerId: current.customerId,
      kind: "manual_note",
      source: "user_action",
      userId: input.userId,
      refType: "rma",
      refId: id,
      meta: {
        kind: "rma_tracking_added",
        trackingNumber,
        trackingCarrier,
      },
    },
    db,
  );

  // Notify the warehouse team if an email is configured. Lazy imports keep
  // the module's import graph clean (this is an outbound-facing service, the
  // service module itself shouldn't pull in gmail/templates eagerly).
  const { loadAppSettings } = await import("../statements/settings.js");
  const settings = await loadAppSettings();
  const warehouseEmail = (settings.warehouse_team_email ?? "").trim();
  if (!warehouseEmail) {
    const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
    return {
      ok: true,
      rma: updatedRows[0] as Rma,
      emailedTo: null,
    };
  }

  const customerRows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, current.customerId))
    .limit(1);
  const customerName = customerRows[0]?.displayName ?? "(unknown customer)";

  const { emailTemplates } = await import("../../db/schema/email-templates.js");
  const templateRows = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, "rma-warehouse-tracking"))
    .limit(1);
  const template = templateRows[0];
  if (!template) {
    // Template missing — return ok with no email but flag in meta. Operator
    // can re-run scripts/seed-email-templates.ts to fix.
    const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
    return {
      ok: true,
      rma: updatedRows[0] as Rma,
      emailedTo: null,
    };
  }

  const { renderTemplate } = await import("../email-compose/index.js");
  const vars: Record<string, string> = {
    rma_number: current.rmaNumber ?? current.id,
    tracking_number: trackingNumber,
    tracking_carrier: trackingCarrier ?? "(not specified)",
    tracking_notes: input.notes?.trim() || "(none)",
    customer_name: customerName,
    company_name: settings.company_name || "Feldart",
  };

  const subject = renderTemplate(template.subject, vars);
  const body = renderTemplate(template.body, vars);

  const { sendEmail } = await import("../../integrations/gmail/send.js");
  await sendEmail({
    to: warehouseEmail,
    subject,
    html: body
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
      .join("\n"),
    text: body,
  });

  const updatedRows = await db.select().from(rmas).where(eq(rmas.id, id));
  return {
    ok: true,
    rma: updatedRows[0] as Rma,
    emailedTo: warehouseEmail,
  };
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
  // Wrap the lookup-existing-items + insert in a transaction with a row
  // lock on the parent rma row. Without the lock, two concurrent addRmaItem
  // calls for the same RMA both see the same maxPosition and both insert at
  // the same position. SELECT ... FOR UPDATE on the rmas row serializes
  // them so the second call sees the first call's freshly-inserted item.
  await db.transaction(async (tx) => {
    const rmaRows = await tx
      .select()
      .from(rmas)
      .where(eq(rmas.id, rmaId))
      .for("update");
    if (rmaRows.length === 0) throw new Error(`RMA not found: ${rmaId}`);
    const current = rmaRows[0] as Rma;
    if (current.status !== "draft") {
      throw new Error(
        `Cannot add items to RMA in "${current.status}" status — only draft is editable`,
      );
    }

    const existingItems = (await tx
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

    await tx.insert(rmaItems).values(newItem);
  });
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
  // Item identity / display fields. qbItemId can be patched after the
  // operator picks a real QBO item for an imported row whose qbItemId was
  // empty at import time (we only had SKU). sku + name follow.
  qbItemId?: string;
  sku?: string;
  name?: string;
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
  // Warehouse-confirmed quantity. Set by the receipt review dialog when the
  // operator records what actually arrived. Persisted so the CM dialog can
  // pre-fill its receivedQty seed.
  receivedQuantity?: string | null;
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
  // Most fields are draft-only. The exception is receivedQuantity, which is
  // recorded after the warehouse confirms receipt — so allow it on
  // sent_to_warehouse / received. Detect "received-qty-only" patches and
  // bypass the draft gate for those.
  const patchKeys = Object.keys(patch);
  const isReceivedQtyOnly =
    patchKeys.length > 0 &&
    patchKeys.every((k) => k === "receivedQuantity");
  if (rma.status !== "draft" && !isReceivedQtyOnly) {
    throw new Error(
      `Cannot update items on RMA in "${rma.status}" status — only draft is editable`,
    );
  }
  if (
    isReceivedQtyOnly &&
    rma.status !== "draft" &&
    rma.status !== "sent_to_warehouse" &&
    rma.status !== "received"
  ) {
    throw new Error(
      `Cannot record received quantity on RMA in "${rma.status}" status`,
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

// ---------------------------------------------------------------------------
// createRmaFromReceipt
// ---------------------------------------------------------------------------
// Creates a new RMA in "received" state directly from an Extensiv receipt
// (goods are already at the warehouse — skip the draft→approved→warehouse
// round-trip). Also links the extensiv_receipt row to the new RMA.

export type CreateRmaFromReceiptInput = {
  receiptId: string;
  customerId: string;
  qbCustomerId: string;
  returnType: RmaReturnType;
  items: NewRmaItem[];
  userId: string;
};

export async function createRmaFromReceipt(
  input: CreateRmaFromReceiptInput,
): Promise<Rma> {
  const id = nanoid(24);
  const now = new Date();

  // Whole flow runs in a transaction with FOR UPDATE on the receipt row.
  // The route already checks `rmaId IS NULL && confirmedAt IS NULL &&
  // dismissedAt IS NULL` before calling, but that check is outside any
  // lock — two operators with stale tabs can both pass it and both
  // create RMAs racing to claim the same receipt. The lock plus the
  // post-lock null re-check ensures only the first claim wins; the
  // second sees the now-populated rmaId/confirmedAt/dismissedAt and
  // throws a clear "already claimed" error rather than orphaning a
  // duplicate RMA.
  //
  // Activity recording happens post-commit (recordActivity opens its
  // own internal transaction; nesting it inside this one would be
  // savepoint territory) — same pattern as confirmExtensivReceipt.
  const created = await db.transaction(async (tx) => {
    const receiptRows = await tx
      .select()
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, input.receiptId))
      .for("update");
    if (receiptRows.length === 0) {
      throw new Error(`extensiv_receipt not found: ${input.receiptId}`);
    }
    const receipt = receiptRows[0] as ExtensivReceipt;

    // Re-check claim state under the lock — this is the actual atomic
    // gate. The route-side pre-check is only a friendly UX gate; this
    // is the real one. If a concurrent submit beat us to the receipt,
    // bail with a clear message so the operator refreshes and sees
    // the existing RMA.
    if (receipt.rmaId) {
      throw new Error(
        `Receipt already linked to RMA ${receipt.rmaId} — refresh the page to see it`,
      );
    }
    if (receipt.confirmedAt) {
      throw new Error(
        "Receipt was already confirmed by another operator — refresh the page",
      );
    }
    if (receipt.dismissedAt) {
      throw new Error(
        "Receipt was already dismissed — refresh the page",
      );
    }

    const row: NewRma = {
      id,
      customerId: input.customerId,
      qbCustomerId: input.qbCustomerId,
      returnType: input.returnType,
      status: "received",
      seasonId: null,
      notes: null,
      originalEmail: null,
      totalValue: "0",
      thresholdOverridden: false,
      createdViaReceipt: true,
      receivedAtWarehouseAt: now,
      createdByUserId: input.userId,
    };

    await tx.insert(rmas).values(row);

    // Insert items with correct positions, accumulating the total
    // inline so we don't need to re-query inside the transaction.
    let totalSum = 0;
    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i];
      if (!item) continue;
      const qty = parseFloat(String(item.quantity ?? 0));
      const price = parseFloat(String(item.unitPrice ?? 0));
      const lineTotal = (qty * price).toFixed(2);
      totalSum += parseFloat(lineTotal);
      await tx.insert(rmaItems).values({
        ...item,
        id: nanoid(24),
        rmaId: id,
        position: i,
        lineTotal,
      });
    }

    // Persist the rollup total inside the same tx — replaces the
    // external recomputeTotalValue call from the pre-tx version.
    await tx
      .update(rmas)
      .set({ totalValue: totalSum.toFixed(2) })
      .where(eq(rmas.id, id));

    // Link the receipt to this new RMA. The FOR UPDATE lock + the
    // null re-check above guarantees we're the only writer — no
    // racing UPDATE from a concurrent claimant.
    await tx
      .update(extensivReceipts)
      .set({ rmaId: id, matchKind: "exact_tx_number" })
      .where(eq(extensivReceipts.id, input.receiptId));

    const createdRows = await tx.select().from(rmas).where(eq(rmas.id, id));
    return createdRows[0] as Rma;
  });

  // Post-commit activity write — only fires when the tx above committed
  // successfully so a rollback never leaves a phantom audit row.
  await recordActivity({
    customerId: input.customerId,
    kind: "rma_created",
    source: "user_action",
    userId: input.userId,
    refType: "rma",
    refId: id,
    meta: { createdViaReceipt: true, receiptId: input.receiptId },
  });

  return created;
}

// ---------------------------------------------------------------------------
// dismissExtensivReceipt
// ---------------------------------------------------------------------------

export async function dismissExtensivReceipt(input: {
  receiptId: string;
  userId: string;
}): Promise<void> {
  const rows = await db
    .select({ id: extensivReceipts.id })
    .from(extensivReceipts)
    .where(eq(extensivReceipts.id, input.receiptId))
    .limit(1);
  if (rows.length === 0) throw new Error(`extensiv_receipt not found: ${input.receiptId}`);

  await db
    .update(extensivReceipts)
    .set({ dismissedAt: new Date(), dismissedByUserId: input.userId })
    .where(eq(extensivReceipts.id, input.receiptId));
}

// ---------------------------------------------------------------------------
// confirmExtensivReceipt
// ---------------------------------------------------------------------------
// Sets confirmedAt on the receipt. If the linked RMA is in
// `sent_to_warehouse`, also advances it to `received`.
//
// Transactional: the whole flow runs inside `db.transaction` so the receipt
// confirmation + RMA advance land atomically. Without the transaction, a
// failure in the RMA advance leaves the receipt confirmed but the RMA still
// in `sent_to_warehouse` — split-brain that the operator can't recover from
// (the receipt review queue no longer surfaces it). recordActivity opens
// its own internal tx, so we leave it outside the main transaction — the
// activity log is informational, not part of the state-correctness invariant.

export type ConfirmExtensivReceiptResult = {
  receipt: ExtensivReceipt;
  rma?: Rma;
};

// Transactional twin of `manualMarkReceived` — accepts a tx handle so it can
// be composed with other transactional work. Skips activity recording (the
// caller handles that post-commit so the audit row only lands when the state
// change actually committed). Returns the updated RMA, or `null`/{ok:false}
// in the same shape as the public function for caller convenience.
async function advanceRmaStatusToReceived(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  rmaId: string,
  _userId: string,
): Promise<ManualMarkReceivedResult | null> {
  const existing = await tx.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "mark_received",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  const now = new Date();
  await tx
    .update(rmas)
    .set({ status: "received", receivedAtWarehouseAt: now })
    .where(eq(rmas.id, rmaId));

  const updated = await tx.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma };
}

export async function confirmExtensivReceipt(input: {
  receiptId: string;
  userId: string;
}): Promise<ConfirmExtensivReceiptResult> {
  // Whole flow runs in a transaction so the receipt confirm + RMA advance
  // are atomic. A failure mid-flight rolls back the receipt update too,
  // avoiding a confirmed-receipt-with-unadvanced-RMA split-brain that the
  // operator can't recover from.
  const txResult = await db.transaction(async (tx) => {
    const receiptRows = await tx
      .select()
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, input.receiptId))
      .limit(1);
    if (receiptRows.length === 0)
      throw new Error(`extensiv_receipt not found: ${input.receiptId}`);

    const receipt = receiptRows[0] as ExtensivReceipt;

    await tx
      .update(extensivReceipts)
      .set({ confirmedAt: new Date(), confirmedByUserId: input.userId })
      .where(eq(extensivReceipts.id, input.receiptId));

    const updatedReceiptRows = await tx
      .select()
      .from(extensivReceipts)
      .where(eq(extensivReceipts.id, input.receiptId))
      .limit(1);
    const updatedReceipt = updatedReceiptRows[0] as ExtensivReceipt;

    // If a linked RMA is still in sent_to_warehouse, advance it to received
    // inside the same tx so a failure here rolls back the receipt update too.
    let advancedRma: Rma | undefined;
    let needsActivity = false;
    let customerIdForActivity: string | null = null;
    if (receipt.rmaId) {
      const rmaRows = await tx
        .select()
        .from(rmas)
        .where(eq(rmas.id, receipt.rmaId))
        .limit(1);
      const rma = rmaRows[0] as Rma | undefined;
      if (rma?.status === "sent_to_warehouse") {
        const result = await advanceRmaStatusToReceived(
          tx,
          receipt.rmaId,
          input.userId,
        );
        if (result?.ok) {
          advancedRma = result.rma;
          needsActivity = true;
          customerIdForActivity = result.rma.customerId;
        }
      } else if (rma) {
        advancedRma = rma;
      }
    }

    return {
      updatedReceipt,
      advancedRma,
      needsActivity,
      customerIdForActivity,
      rmaIdForActivity: receipt.rmaId,
    };
  });

  // Record activity only after the tx commits — recordActivity opens its own
  // internal transaction so we keep it outside the main one. If this throws,
  // the state change already landed; we log and surface the error.
  if (
    txResult.needsActivity &&
    txResult.customerIdForActivity &&
    txResult.rmaIdForActivity
  ) {
    await recordActivity(
      {
        customerId: txResult.customerIdForActivity,
        kind: "rma_received_at_warehouse",
        source: "user_action",
        userId: input.userId,
        refType: "rma",
        refId: txResult.rmaIdForActivity,
        meta: { source: "extensiv_receipt_confirm" },
      },
      db,
    );
  }

  return txResult.advancedRma
    ? { receipt: txResult.updatedReceipt, rma: txResult.advancedRma }
    : { receipt: txResult.updatedReceipt };
}

// ---------------------------------------------------------------------------
// revertToDraft — pulls the RMA back to draft for editing.
// Clears workflow side-effects (rmaNumber, extensiv_*, sent_to_warehouse_at,
// received_at_warehouse_at, denial fields, override fields) but keeps items
// + audit trail intact. Operator must re-walk the wizard afterwards.
// ---------------------------------------------------------------------------

export type RevertToDraftInput = {
  rmaId: string;
  userId: string;
};

export type RevertToDraftResult =
  | { ok: true; rma: Rma }
  | { ok: false; reason: string };

export async function revertToDraft(
  input: RevertToDraftInput,
): Promise<RevertToDraftResult | null> {
  const { rmaId, userId } = input;
  const existing = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  if (existing.length === 0) return null;
  const current = existing[0] as Rma;

  const transition = validateTransition({
    currentStatus: current.status,
    returnType: current.returnType,
    action: "revert_to_draft",
  });
  if (!transition.ok) return { ok: false, reason: transition.reason };

  // Wipe workflow side-effects but keep items + denial PDF reference (the
  // file may still be in Drive — operator can clear separately if needed).
  await db
    .update(rmas)
    .set({
      status: "draft",
      // Damage RMAs keep their DC-... rmaNumber (it's just a deterministic
      // timestamp); seasonal/non-seasonal had it set to the warehouse tx#
      // which is no longer valid → clear it.
      rmaNumber: current.returnType === "damage" ? current.rmaNumber : null,
      extensivTxNumber: null,
      extensivExportGeneratedAt: null,
      sentToWarehouseAt: null,
      receivedAtWarehouseAt: null,
      approvedAt: null,
      approvedByUserId: null,
      thresholdOverridden: false,
      overrideReason: null,
      overrideByUserId: null,
      denialReason: null,
      deniedAt: null,
    })
    .where(eq(rmas.id, rmaId));

  await recordActivity(
    {
      customerId: current.customerId,
      kind: "rma_warehouse_export_cancelled", // closest existing kind; reuse for "reverted"
      source: "user_action",
      userId,
      refType: "rma",
      refId: rmaId,
      meta: { revertedFrom: current.status },
    },
    db,
  );

  const updated = await db.select().from(rmas).where(eq(rmas.id, rmaId));
  return { ok: true, rma: updated[0] as Rma };
}

// ---------------------------------------------------------------------------
// deleteRma — hard delete, only allowed for draft or cancelled RMAs
// ---------------------------------------------------------------------------
//
// Other statuses preserve their audit trail in the DB. Operators who want to
// "remove" an in-flight RMA should cancel it first, then delete if needed.
// rma_items + rma_photos rows cascade via the FK ON DELETE CASCADE constraint.
//
// Drive side: rma_photos rows hold the only handles to the Drive blobs, so
// once they cascade-delete, the Drive folder + files are orphaned. We list
// the photos up-front, attempt best-effort `deleteFile` for each, then
// `deleteFolder` for the parent folder, BEFORE cascading the row delete.
// All Drive calls are wrapped in try/catch so a Drive failure leaks the
// blob but doesn't block the DB delete (better than the alternative of
// orphaning the row + the blob).
//
// userId is required for the Drive client — it routes to the user's OAuth
// token. Caller (the route handler) supplies it from `requireAuth`.

export type DeleteRmaInput = {
  rmaId: string;
  userId: string;
};

export async function deleteRma(input: DeleteRmaInput): Promise<
  | { ok: true }
  | { ok: false; reason: string }
  | null
> {
  const { rmaId, userId } = input;
  const rows = await db.select().from(rmas).where(eq(rmas.id, rmaId)).limit(1);
  if (rows.length === 0) return null;
  const current = rows[0] as Rma;
  if (current.status !== "draft" && current.status !== "cancelled") {
    return {
      ok: false,
      reason:
        "RMAs in this state cannot be deleted — cancel it first to preserve audit history.",
    };
  }

  // Best-effort Drive cleanup. We list photos before the cascade delete so
  // we still have driveFileId handles. Any Drive call failure is logged and
  // swallowed — leaking a Drive file is preferable to leaving an orphaned
  // DB row that the operator can't retry-delete.
  try {
    const photos = await db
      .select({ driveFileId: rmaPhotos.driveFileId })
      .from(rmaPhotos)
      .where(eq(rmaPhotos.rmaId, rmaId));
    if (photos.length > 0 || current.driveFolderId) {
      const { deleteFile, deleteFolder } = await import(
        "../../integrations/google-drive/client.js"
      );
      for (const p of photos) {
        try {
          await deleteFile({ userId, fileId: p.driveFileId });
        } catch (err) {
          console.error(
            "[deleteRma] Drive file delete failed (continuing):",
            { rmaId, fileId: p.driveFileId, err },
          );
        }
      }
      if (current.driveFolderId) {
        try {
          await deleteFolder({ userId, folderId: current.driveFolderId });
        } catch (err) {
          console.error(
            "[deleteRma] Drive folder delete failed (continuing):",
            { rmaId, folderId: current.driveFolderId, err },
          );
        }
      }
    }
  } catch (err) {
    // Listing or import failure — log and proceed with DB delete.
    console.error("[deleteRma] Drive cleanup setup failed (continuing):", err);
  }

  await db.delete(rmas).where(eq(rmas.id, rmaId));
  return { ok: true };
}
