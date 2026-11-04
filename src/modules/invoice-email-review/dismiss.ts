// Dismiss an invoice from the Email review lists — shared by the Invoicing
// page (POST /api/invoicing/email-review/dismiss) and the Feldart AI
// dismiss_email_review executor, so both write the same row + audit.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  invoiceEmailDismissals,
  type EmailReviewDismissReason,
} from "../../db/schema/invoice-email-dismissals.js";
import { invoices } from "../../db/schema/invoices.js";
import { isDismissalActive } from "./select.js";

export type DismissEmailReviewResult =
  | { ok: true; hidden: boolean }
  | { ok: false; reason: "invoice_not_found" };

export async function dismissEmailReview(input: {
  invoiceId: string;
  reason: EmailReviewDismissReason;
  reasonNote: string | null;
  userId: string;
  aiProposalId?: string;
}): Promise<DismissEmailReviewResult> {
  const { invoiceId, reason, reasonNote, userId } = input;
  // deliveryTime/deliveryError come back with the existence check so the
  // caller can tell whether the dismissal actually hides the row (an
  // undated bounce never can).
  const [invoice] = await db
    .select({ id: invoices.id, deliveryTime: invoices.deliveryTime, deliveryError: invoices.deliveryError })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!invoice) return { ok: false, reason: "invoice_not_found" };

  const dismissedAt = new Date();
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
      .limit(1);

    await tx
      .insert(invoiceEmailDismissals)
      .values({ invoiceId, reason, reasonNote, dismissedAt, dismissedByUserId: userId })
      .onDuplicateKeyUpdate({ set: { reason, reasonNote, dismissedAt, dismissedByUserId: userId } });

    await tx.insert(auditLog).values({
      id: nanoid(24),
      userId,
      action: "invoice_email_review.dismiss",
      entityType: "invoice",
      entityId: invoiceId,
      before: before ? ({ ...before } as Record<string, unknown>) : null,
      after: {
        invoiceId,
        reason,
        reasonNote,
        dismissedAt: dismissedAt.toISOString(),
        dismissedByUserId: userId,
        ...(input.aiProposalId ? { aiProposalId: input.aiProposalId } : {}),
      },
    });
  });

  return { ok: true, hidden: isDismissalActive(dismissedAt, invoice.deliveryTime, invoice.deliveryError) };
}
