// Send a single invoice through QBO's infrastructure with finance-
// hub's resolved recipients. The shape is:
//
//   1. Resolve TO/CC/BCC for the "invoice" channel from the
//      customer's per-channel arrays + tag-driven routing rules.
//      Optional `recipientOverrides` from the caller (typically the
//      send dialog) replace the resolved values per-field.
//   2. Fetch the QBO Invoice to get its current SyncToken.
//   3. PATCH BillEmail / BillEmailCc / BillEmailBcc on the Invoice
//      via sparse update. Multiple addresses get comma-joined into
//      the single-string Address field (QBO accepts that).
//   4. POST /invoice/{id}/send — QBO emails it from their
//      infrastructure using the addresses we just set.
//   5. Update local invoices.sent_at / sent_via / status.
//   6. Write a `qbo_invoice_sent` activity row so the timeline picks
//      it up.
//
// Recipients are validated up-front: TO must be non-empty (we can't
// send an email with no TO). All addresses are normalised
// (trim/lowercase/dedupe) by resolveRecipients before this function
// sees them.

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { invoices } from "../../db/schema/invoices.js";
import { activities } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import type { Customer } from "../../db/schema/customers.js";
import type { Invoice } from "../../db/schema/invoices.js";
import { QboClient } from "../../integrations/qb/client.js";
import { createLogger } from "../../lib/logger.js";
import {
  resolveRecipients,
  type ResolvedRecipients,
} from "../customer-emails/recipients.js";

const log = createLogger({ component: "invoice-send.via-qbo" });

export type RecipientOverrides = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
};

export type SendInvoiceViaQboArgs = {
  customer: Customer;
  invoice: Invoice;
  // The user who clicked Send. Stamped onto the activity row + emit
  // events. Optional for cron / system-initiated sends, though all
  // real callers should pass it.
  userId?: string;
  recipientOverrides?: RecipientOverrides;
  // Test seam — caller can inject a mocked QboClient. Defaults to a
  // fresh QboClient() so production callers don't need to know.
  qbClient?: QboClient;
};

export type SendInvoiceViaQboResult = {
  qbInvoiceId: string;
  docNumber: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  sentAt: Date;
  // Surfaced so the UI can show "+ auto-BCC sales@ (yiddy)" hints
  // after send for a confirmation receipt.
  bccReasons: ResolvedRecipients["bccReasons"];
};

export async function sendInvoiceViaQbo(
  args: SendInvoiceViaQboArgs,
): Promise<SendInvoiceViaQboResult> {
  const { customer, invoice, userId, recipientOverrides } = args;

  if (!invoice.qbInvoiceId) {
    throw new Error("invoice has no qbInvoiceId — cannot send via QBO");
  }
  if (!customer.qbCustomerId) {
    throw new Error("customer has no qbCustomerId — cannot send via QBO");
  }

  const resolved = await resolveRecipients("invoice", {
    primaryEmail: customer.primaryEmail,
    billingEmails: customer.billingEmails,
    invoiceToEmails: customer.invoiceToEmails,
    invoiceCcEmails: customer.invoiceCcEmails,
    invoiceBccEmails: customer.invoiceBccEmails,
    statementToEmails: customer.statementToEmails,
    statementCcEmails: customer.statementCcEmails,
    statementBccEmails: customer.statementBccEmails,
    tags: customer.tags,
  });

  const to = recipientOverrides?.to ?? resolved.to;
  const cc = recipientOverrides?.cc ?? resolved.cc;
  const bcc = recipientOverrides?.bcc ?? resolved.bcc;

  if (to.length === 0) {
    throw new Error(
      "No TO address — cannot send. Add an invoice TO email on the customer profile.",
    );
  }

  const qb = args.qbClient ?? new QboClient();
  const qboInvoice = await qb.getInvoiceById(invoice.qbInvoiceId);
  if (!qboInvoice) {
    throw new Error(
      `QBO invoice ${invoice.qbInvoiceId} not found — was it deleted?`,
    );
  }
  if (!qboInvoice.SyncToken) {
    throw new Error(
      `QBO invoice ${invoice.qbInvoiceId} has no SyncToken; cannot sparse-update`,
    );
  }

  // Sparse PATCH BillEmail/Cc/Bcc. Multiple addresses get
  // comma-joined into the single Address string. QBO accepts a
  // comma-separated list and renders the recipients separately on
  // the outbound email.
  const patchPayload: Record<string, unknown> = {
    Id: qboInvoice.Id,
    SyncToken: qboInvoice.SyncToken,
    sparse: true,
    BillEmail: { Address: to.join(", ") },
    BillEmailCc: cc.length > 0 ? { Address: cc.join(", ") } : null,
    BillEmailBcc: bcc.length > 0 ? { Address: bcc.join(", ") } : null,
  };
  await qb.updateInvoice(patchPayload);

  // /invoice/{id}/send — QBO emails the customer using the addresses
  // we just set. Note the API also accepts a sendTo query param to
  // override BillEmail at send time, but we set BillEmail explicitly
  // above so the invoice record on QBO permanently shows the right
  // recipients.
  await qb.sendInvoiceEmail(qboInvoice.Id);

  const sentAt = new Date();

  // Local mirror update — the next QBO sync will reconcile, but we
  // don't want the UI to show "not sent" for the 30-min window in
  // between.
  await db
    .update(invoices)
    .set({
      sentAt,
      sentVia: "qbo",
      status: "sent",
    })
    .where(eq(invoices.id, invoice.id));

  // Activity row — picks up on the customer timeline. The body is
  // human-readable; meta carries the structured payload for the
  // activity-detail UI.
  const docNumber = invoice.docNumber ?? qboInvoice.DocNumber ?? null;
  const lines: string[] = [`TO: ${to.join(", ")}`];
  if (cc.length > 0) lines.push(`CC: ${cc.join(", ")}`);
  if (bcc.length > 0) lines.push(`BCC: ${bcc.join(", ")}`);

  await db.insert(activities).values({
    id: nanoid(),
    customerId: customer.id,
    userId: userId ?? null,
    kind: "qbo_invoice_sent",
    source: userId ? "user_action" : "app_send",
    occurredAt: sentAt,
    subject: docNumber ? `Invoice ${docNumber} sent` : `Invoice sent`,
    body: lines.join("\n"),
    refType: "invoice",
    refId: invoice.id,
    meta: {
      qbInvoiceId: invoice.qbInvoiceId,
      docNumber,
      to,
      cc,
      bcc,
      bccReasons: resolved.bccReasons,
      total: invoice.total,
      balance: invoice.balance,
    },
  });

  // Mark the customer's lastSyncedAt-adjacent fields as fresh so the
  // UI reflects "just sent" without a full QBO sync. Cheap update.
  await db
    .update(customers)
    .set({ updatedAt: sentAt })
    .where(eq(customers.id, customer.id));

  log.info(
    {
      customerId: customer.id,
      qbInvoiceId: invoice.qbInvoiceId,
      docNumber,
      toCount: to.length,
      ccCount: cc.length,
      bccCount: bcc.length,
    },
    "invoice sent via QBO",
  );

  return {
    qbInvoiceId: invoice.qbInvoiceId,
    docNumber,
    to,
    cc,
    bcc,
    sentAt,
    bccReasons: resolved.bccReasons,
  };
}
