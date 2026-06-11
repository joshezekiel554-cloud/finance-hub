// TJ dispute state transitions, extracted from the disputes route so the
// AI agent's dispute_transition tool and the HTTP route share one path —
// especially the QBO void (the most dangerous write in the system).
// Discriminated results; callers map to HTTP codes / tool errors.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { invoices } from "../../db/schema/invoices.js";
import { auditLog } from "../../db/schema/audit.js";
import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "crm.dispute-actions" });

export type DisputeActionResult =
  | { kind: "ok"; disputeState: "verifying" | "confirmed_unpaid" | "confirmed_paid" }
  | {
      kind: "error";
      code:
        | "not_found"
        | "not_tj"
        | "already_resolved"
        | "not_verifying"
        | "no_sync_token"
        | "qbo_void_failed";
      message: string;
    };

async function loadInvoice(id: string) {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function guardTj(inv: { origin: string }): DisputeActionResult | null {
  if (inv.origin !== "tj") {
    return {
      kind: "error",
      code: "not_tj",
      message: "disputes only apply to Torah Judaica invoices",
    };
  }
  return null;
}

export async function disputeClaimsPaid(
  invoiceId: string,
  userId: string,
  note?: string | null,
): Promise<DisputeActionResult> {
  const inv = await loadInvoice(invoiceId);
  if (!inv) return { kind: "error", code: "not_found", message: "invoice not found" };
  const tjGuard = guardTj(inv);
  if (tjGuard) return tjGuard;
  if (inv.status === "void" || inv.disputeState === "confirmed_paid") {
    return {
      kind: "error",
      code: "already_resolved",
      message: "invoice already void or resolved paid",
    };
  }
  await db
    .update(invoices)
    .set({
      disputeState: "verifying",
      disputeClaimedAt: new Date(),
      disputeNote: note ?? null,
      disputeUpdatedBy: userId,
    })
    .where(eq(invoices.id, invoiceId));
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "dispute.claims_paid",
    entityType: "invoice",
    entityId: invoiceId,
    before: { disputeState: inv.disputeState },
    after: { disputeState: "verifying", disputeNote: note ?? null },
  });
  return { kind: "ok", disputeState: "verifying" };
}

export async function disputeResolveUnpaid(
  invoiceId: string,
  userId: string,
): Promise<DisputeActionResult> {
  const inv = await loadInvoice(invoiceId);
  if (!inv) return { kind: "error", code: "not_found", message: "invoice not found" };
  const tjGuard = guardTj(inv);
  if (tjGuard) return tjGuard;
  if (inv.status === "void" || inv.disputeState === "confirmed_paid") {
    return {
      kind: "error",
      code: "already_resolved",
      message: "invoice already void or resolved paid",
    };
  }
  await db
    .update(invoices)
    .set({ disputeState: "confirmed_unpaid", disputeUpdatedBy: userId })
    .where(eq(invoices.id, invoiceId));
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "dispute.resolve_unpaid",
    entityType: "invoice",
    entityId: invoiceId,
    before: { disputeState: inv.disputeState },
    after: { disputeState: "confirmed_unpaid" },
  });
  return { kind: "ok", disputeState: "confirmed_unpaid" };
}

// The dangerous one: voids the invoice in QuickBooks, then soft-voids
// locally. QBO failure leaves all state untouched (retryable).
export async function disputeResolvePaid(
  invoiceId: string,
  userId: string,
): Promise<DisputeActionResult> {
  const inv = await loadInvoice(invoiceId);
  if (!inv) return { kind: "error", code: "not_found", message: "invoice not found" };
  const tjGuard = guardTj(inv);
  if (tjGuard) return tjGuard;
  if (inv.status === "void") {
    return { kind: "error", code: "already_resolved", message: "invoice already void" };
  }
  // Voiding only ever happens off a deliberate dispute (claims-paid first).
  if (inv.disputeState !== "verifying") {
    return {
      kind: "error",
      code: "not_verifying",
      message: "invoice is not parked for verification",
    };
  }
  if (!inv.syncToken) {
    return {
      kind: "error",
      code: "no_sync_token",
      message: "invoice missing syncToken; run a QB sync first",
    };
  }

  let voidedSyncToken = inv.syncToken;
  try {
    const qb = new QboClient();
    const voided = await qb.voidInvoice(inv.qbInvoiceId, inv.syncToken);
    if (voided?.SyncToken) voidedSyncToken = voided.SyncToken;
  } catch (err) {
    log.error(
      {
        invoice_id: invoiceId,
        qb_invoice_id: inv.qbInvoiceId,
        err: (err as Error).message,
      },
      "QBO void failed during dispute resolution",
    );
    return {
      kind: "error",
      code: "qbo_void_failed",
      message: "QuickBooks void failed; nothing changed. Try again.",
    };
  }

  await db
    .update(invoices)
    .set({
      status: "void",
      balance: "0",
      disputeState: "confirmed_paid",
      disputeUpdatedBy: userId,
      syncToken: voidedSyncToken,
      lastSyncedAt: new Date(),
    })
    .where(eq(invoices.id, invoiceId));
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId,
    action: "dispute.void_qbo",
    entityType: "invoice",
    entityId: invoiceId,
    before: {
      status: inv.status,
      balance: inv.balance,
      disputeState: inv.disputeState,
    },
    after: { status: "void", balance: "0", disputeState: "confirmed_paid" },
  });
  return { kind: "ok", disputeState: "confirmed_paid" };
}
